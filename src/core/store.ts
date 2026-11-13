import type {
  Account,
  Address,
  FolderView,
  MessageDetail,
  Split,
  SplitRule,
  ThreadDetail,
  ThreadSummary,
  View,
} from '../shared/types'
import type { Db, Row } from './db'
import type { FolderRole, RemoteBody, RemoteMessage } from './provider'

export interface FolderRow {
  id: number
  account_id: number
  path: string
  role: FolderRole
  uidvalidity: string | null
  uidnext: number | null
}

const BUILTIN_SPLITS: { id: string; name: string; rule: SplitRule }[] = [
  { id: 'important', name: 'Important', rule: { isList: false, hasInvite: false, isAutomated: false } },
  { id: 'calendar', name: 'Calendar', rule: { hasInvite: true } },
  { id: 'news', name: 'Newsletters', rule: { isList: true, hasInvite: false } },
  { id: 'other', name: 'Other', rule: { isAutomated: true, isList: false, hasInvite: false } },
]

/** A thread is in the inbox if it has mail there or a reminder fired, and it is not snoozed. */
const IN_INBOX = 't.hidden = 0 AND (t.in_inbox = 1 OR t.reminded > 0) AND t.snoozed_until IS NULL'
const SORT = 'COALESCE(t.bump_date, t.last_date) DESC, t.id DESC'
const THREAD_COLS = `t.*, (SELECT MIN(r.due_at) FROM reminders r WHERE r.thread_id = t.id) AS reminder_at`

export function snippetOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** All persistent mail state. Synchronous; every method leaves the database consistent. */
export class Store {
  constructor(readonly db: Db) {}

  // ---------- accounts and folders ----------

  accounts(): Account[] {
    return this.db.all('SELECT * FROM accounts ORDER BY id').map(accountOf)
  }

  account(id: number): (Account & { secret: string | null; config: Row }) | undefined {
    const r = this.db.get('SELECT * FROM accounts WHERE id = ?', id)
    return r ? { ...accountOf(r), secret: r.secret, config: JSON.parse(r.config) } : undefined
  }

  folders(accountId: number): FolderRow[] {
    return this.db.all<FolderRow>('SELECT * FROM folders WHERE account_id = ?', accountId)
  }

  folderByRole(accountId: number, role: FolderRole): FolderRow | undefined {
    return this.db.get<FolderRow>('SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY id', accountId, role)
  }

  upsertFolder(accountId: number, path: string, role: FolderRole): FolderRow {
    this.db.run(
      `INSERT INTO folders(account_id, path, role) VALUES(?, ?, ?)
       ON CONFLICT(account_id, path) DO UPDATE SET role = excluded.role`,
      accountId,
      path,
      role,
    )
    return this.db.get<FolderRow>('SELECT * FROM folders WHERE account_id = ? AND path = ?', accountId, path)!
  }

  // ---------- ingest ----------

  /** Stores messages fetched from a folder and returns the ids of the threads they touched. */
  ingest(folder: FolderRow, messages: RemoteMessage[], accountEmail: string): Set<number> {
    const touched = new Set<number>()
    this.db.tx(() => {
      for (const m of messages) {
        const messageId = m.messageId || `<no-id-${folder.id}-${m.uid}@local>`
        const existing = this.db.get('SELECT id, thread_id, body_state FROM messages WHERE account_id = ? AND message_id = ?', folder.account_id, messageId)
        let id: number
        let threadId: number
        if (existing) {
          id = existing.id
          threadId = existing.thread_id
          if (m.body && !existing.body_state) this.setBody(id, m.body)
          if (!this.hasPendingAction(threadId)) {
            this.db.run('UPDATE messages SET seen = ?, flagged = ? WHERE id = ?', m.seen, m.flagged, id)
          }
        } else {
          threadId = this.resolveThread(folder.account_id, messageId, m)
          const isSent = folder.role === 'sent' || m.from.address.toLowerCase() === accountEmail.toLowerCase()
          id = this.db.run(
            `INSERT INTO messages(account_id, thread_id, message_id, refs, from_name, from_addr, to_json, cc_json,
               bcc_json, subject, date, seen, flagged, is_sent, has_attachments, is_list, has_invite, is_automated)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            folder.account_id,
            threadId,
            messageId,
            JSON.stringify(m.references),
            m.from.name,
            m.from.address,
            JSON.stringify(m.to),
            JSON.stringify(m.cc),
            JSON.stringify(m.bcc),
            m.subject,
            m.date,
            m.seen,
            m.flagged,
            isSent,
            m.hasAttachments,
            m.isList,
            m.hasInvite,
            m.isAutomated,
          ).id
          this.db.run(
            'INSERT INTO msg_fts(rowid, subject, sender, recipients, body) VALUES(?, ?, ?, ?, ?)',
            id,
            m.subject,
            `${m.from.name} ${m.from.address}`,
            [...m.to, ...m.cc].map((a) => `${a.name} ${a.address}`).join(' '),
            '',
          )
          if (m.body) this.setBody(id, m.body)
          // New mail in a conversation that was trashed brings it back.
          if (!this.hasPendingAction(threadId)) this.db.run('UPDATE threads SET hidden = 0 WHERE id = ?', threadId)
        }
        // A uid can be reused for a different message only after a uidvalidity reset,
        // which clears the folder first, so a conflict here is the same message.
        this.db.run(
          `INSERT INTO locations(message_id, folder_id, uid) VALUES(?, ?, ?)
           ON CONFLICT(folder_id, uid) DO UPDATE SET message_id = excluded.message_id`,
          id,
          folder.id,
          m.uid,
        )
        touched.add(threadId)
      }
      for (const t of touched) this.recomputeThread(t)
    })
    return touched
  }

  /** Finds the thread a message belongs to, merging threads that turn out to be one. */
  private resolveThread(accountId: number, messageId: string, m: RemoteMessage): number {
    const keys = m.nativeThreadId
      ? [`native:${m.nativeThreadId}`, messageId]
      : [...new Set([messageId, ...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references])]
    const lookup = m.nativeThreadId ? [keys[0]] : keys
    const found = new Set<number>()
    for (const k of lookup) {
      const r = this.db.get('SELECT thread_id FROM thread_refs WHERE account_id = ? AND msgid = ?', accountId, k)
      if (r) found.add(r.thread_id)
    }
    let threadId: number
    if (found.size === 0) {
      threadId = this.db.run('INSERT INTO threads(account_id) VALUES(?)', accountId).id
    } else {
      const [keep, ...merge] = [...found].sort((a, b) => a - b)
      threadId = keep
      for (const other of merge) {
        this.db.run('UPDATE messages SET thread_id = ? WHERE thread_id = ?', keep, other)
        this.db.run('UPDATE thread_refs SET thread_id = ? WHERE thread_id = ?', keep, other)
        this.db.run('UPDATE reminders SET thread_id = ? WHERE thread_id = ?', keep, other)
        this.db.run('UPDATE actions SET thread_id = ? WHERE thread_id = ?', keep, other)
        this.db.run('DELETE FROM threads WHERE id = ?', other)
      }
    }
    for (const k of keys) {
      this.db.run(
        `INSERT INTO thread_refs(account_id, msgid, thread_id) VALUES(?, ?, ?)
         ON CONFLICT(account_id, msgid) DO UPDATE SET thread_id = excluded.thread_id`,
        accountId,
        k,
        threadId,
      )
    }
    return threadId
  }

  setBody(messageRowId: number, body: RemoteBody) {
    this.db.run(
      `UPDATE messages SET body_text = ?, body_html = ?, attachments = ?, body_state = 1, snippet = ?,
         has_attachments = MAX(has_attachments, ?) WHERE id = ?`,
      body.text,
      body.html,
      JSON.stringify(body.attachments),
      snippetOf(body.text),
      body.attachments.length > 0,
      messageRowId,
    )
    this.db.run('UPDATE msg_fts SET body = ? WHERE rowid = ?', body.text.slice(0, 100_000), messageRowId)
  }

  /** Applies the server's view of a folder: updates flags and drops messages that left it. */
  reconcile(folder: FolderRow, present: { uid: number; seen: boolean; flagged: boolean }[]): Set<number> {
    const touched = new Set<number>()
    this.db.tx(() => {
      const byUid = new Map(present.map((p) => [p.uid, p]))
      const rows = this.db.all(
        `SELECT l.id, l.uid, m.id AS mid, m.thread_id, m.seen, m.flagged
         FROM locations l JOIN messages m ON m.id = l.message_id WHERE l.folder_id = ?`,
        folder.id,
      )
      for (const r of rows) {
        const p = byUid.get(r.uid)
        if (!p) {
          this.db.run('DELETE FROM locations WHERE id = ?', r.id)
          touched.add(r.thread_id)
        } else if ((!!r.seen !== p.seen || !!r.flagged !== p.flagged) && !this.hasPendingAction(r.thread_id)) {
          this.db.run('UPDATE messages SET seen = ?, flagged = ? WHERE id = ?', p.seen, p.flagged, r.mid)
          touched.add(r.thread_id)
        }
      }
      for (const t of touched) this.recomputeThread(t)
    })
    return touched
  }

  clearFolder(folder: FolderRow) {
    this.db.tx(() => {
      const threads = this.db.all(
        'SELECT DISTINCT m.thread_id FROM locations l JOIN messages m ON m.id = l.message_id WHERE l.folder_id = ?',
        folder.id,
      )
      this.db.run('DELETE FROM locations WHERE folder_id = ?', folder.id)
      for (const t of threads) this.recomputeThread(t.thread_id)
    })
  }

  setFolderCursor(folderId: number, uidvalidity: string, uidnext: number, now: number) {
    this.db.run('UPDATE folders SET uidvalidity = ?, uidnext = ?, synced_at = ? WHERE id = ?', uidvalidity, uidnext, now, folderId)
  }

  /** Deletes messages that no longer exist in any synced folder. Run after a full, clean sync. */
  collectOrphans(accountId: number) {
    this.db.tx(() => {
      const rows = this.db.all(
        `SELECT m.id, m.thread_id FROM messages m WHERE m.account_id = ?
           AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.thread_id = m.thread_id AND a.state IN ('pending', 'running'))`,
        accountId,
      )
      const threads = new Set<number>()
      for (const r of rows) {
        this.db.run('DELETE FROM messages WHERE id = ?', r.id)
        this.db.run('DELETE FROM msg_fts WHERE rowid = ?', r.id)
        threads.add(r.thread_id)
      }
      for (const t of threads) this.recomputeThread(t)
    })
  }

  hasPendingAction(threadId: number): boolean {
    return !!this.db.get("SELECT 1 FROM actions WHERE thread_id = ? AND state IN ('pending', 'running') LIMIT 1", threadId)
  }

  /** Rebuilds a thread's summary columns from its messages; deletes the thread if it is empty. */
  recomputeThread(threadId: number) {
    const msgs = this.db.all('SELECT * FROM messages WHERE thread_id = ? ORDER BY date, id', threadId)
    if (msgs.length === 0) {
      this.db.run('DELETE FROM reminders WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM threads WHERE id = ?', threadId)
      return
    }
    const last = msgs[msgs.length - 1]
    const incoming = [...msgs].reverse().find((m) => !m.is_sent) ?? last
    const inFolder = (role: FolderRole) =>
      !!this.db.get(
        `SELECT 1 FROM locations l JOIN messages m ON m.id = l.message_id JOIN folders f ON f.id = l.folder_id
         WHERE m.thread_id = ? AND f.role = ? AND l.removed = 0 LIMIT 1`,
        threadId,
        role,
      )
    const names: string[] = []
    for (const m of msgs) {
      const n = m.is_sent ? 'Me' : shortName(m.from_name, m.from_addr)
      if (!names.includes(n)) names.push(n)
    }
    this.db.run(
      `UPDATE threads SET subject = ?, snippet = ?, last_date = ?, from_name = ?, from_addr = ?, participants = ?,
         msg_count = ?, unread_count = ?, starred = ?, has_attachments = ?, in_inbox = ?, in_sent = ?,
         is_list = ?, has_invite = ?, is_automated = ? WHERE id = ?`,
      msgs[0].subject,
      last.snippet,
      last.date,
      incoming.is_sent ? firstRecipient(incoming) : incoming.from_name || incoming.from_addr,
      incoming.from_addr,
      JSON.stringify(names),
      msgs.length,
      msgs.filter((m) => !m.seen && !m.is_sent).length,
      msgs.some((m) => m.flagged),
      msgs.some((m) => m.has_attachments),
      inFolder('inbox'),
      msgs.some((m) => m.is_sent),
      incoming.is_list,
      msgs.some((m) => m.has_invite),
      incoming.is_automated,
      threadId,
    )
  }

  // ---------- reading ----------

  listThreads(view: View, limit = 300): ThreadSummary[] {
    if (view.kind === 'search') return this.search(view.query, limit)
    const where = view.kind === 'split' ? this.splitWhere(view.splitId) : folderWhere(view.name)
    if (!where) return []
    const order = view.kind === 'folder' && view.name === 'snoozed' ? 't.snoozed_until ASC' : SORT
    return this.db
      .all(`SELECT ${THREAD_COLS} FROM threads t WHERE ${where.sql} ORDER BY ${order} LIMIT ?`, ...where.params, limit)
      .map(threadOf)
  }

  thread(id: number): ThreadSummary | undefined {
    const r = this.db.get(`SELECT ${THREAD_COLS} FROM threads t WHERE t.id = ?`, id)
    return r ? threadOf(r) : undefined
  }

  threadDetail(id: number): ThreadDetail | undefined {
    const t = this.thread(id)
    if (!t) return undefined
    const messages = this.db.all('SELECT * FROM messages WHERE thread_id = ? ORDER BY date, id', id).map(messageOf)
    return { ...t, messages }
  }

  search(query: string, limit = 200): ThreadSummary[] {
    const q = parseQuery(query)
    if (!q.match && q.filters.length === 0) return []
    const filters = ['t.hidden = 0', ...q.filters.map((f) => f.sql)].join(' AND ')
    const params = q.filters.flatMap((f) => f.params)
    if (!q.match) {
      return this.db.all(`SELECT ${THREAD_COLS} FROM threads t WHERE ${filters} ORDER BY ${SORT} LIMIT ?`, ...params, limit).map(threadOf)
    }
    return this.db
      .all(
        `SELECT ${THREAD_COLS} FROM threads t WHERE t.id IN (
           SELECT m.thread_id FROM msg_fts JOIN messages m ON m.id = msg_fts.rowid WHERE msg_fts MATCH ?
         ) AND ${filters} ORDER BY ${SORT} LIMIT ?`,
        q.match,
        ...params,
        limit,
      )
      .map(threadOf)
  }

  // ---------- splits ----------

  splits(): Split[] {
    const custom = this.db.all('SELECT * FROM splits ORDER BY position, id').map((r) => ({
      id: `custom:${r.id}`,
      name: r.name as string,
      kind: 'custom' as const,
      rule: JSON.parse(r.rule) as SplitRule,
    }))
    const accounts = this.accounts()
    const all = [
      ...BUILTIN_SPLITS.map((s) => ({ ...s, kind: 'builtin' as const })),
      ...custom,
      ...(accounts.length > 1
        ? accounts.map((a) => ({ id: `acct:${a.id}`, name: a.name, kind: 'account' as const, rule: { accountIds: [a.id] } }))
        : []),
    ]
    return all.map((s) => {
      const w = this.splitWhere(s.id)!
      const c = this.db.get(
        `SELECT COUNT(*) AS n, COALESCE(SUM(t.unread_count > 0), 0) AS u FROM threads t WHERE ${w.sql}`,
        ...w.params,
      )!
      return { ...s, count: c.n, unread: c.u }
    })
  }

  saveSplit(input: { id?: string; name: string; rule: SplitRule }) {
    const rule = JSON.stringify(input.rule)
    if (input.id?.startsWith('custom:')) {
      this.db.run('UPDATE splits SET name = ?, rule = ? WHERE id = ?', input.name, rule, Number(input.id.slice(7)))
    } else {
      const pos = this.db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM splits')!.p
      this.db.run('INSERT INTO splits(name, position, rule) VALUES(?, ?, ?)', input.name, pos, rule)
    }
  }

  deleteSplit(id: string) {
    if (id.startsWith('custom:')) this.db.run('DELETE FROM splits WHERE id = ?', Number(id.slice(7)))
  }

  /**
   * Built-in splits exclude anything a custom split claims, so adding a custom split
   * pulls its mail out of Important. Account splits show everything for that account.
   */
  private splitWhere(splitId: string): Where | null {
    const customs = this.db.all('SELECT * FROM splits ORDER BY position, id')
    if (splitId.startsWith('acct:')) {
      return { sql: `${IN_INBOX} AND t.account_id = ?`, params: [Number(splitId.slice(5))] }
    }
    if (splitId.startsWith('custom:')) {
      const row = customs.find((c) => c.id === Number(splitId.slice(7)))
      if (!row) return null
      const w = ruleWhere(JSON.parse(row.rule))
      return { sql: `${IN_INBOX} AND ${w.sql}`, params: w.params }
    }
    const builtin = BUILTIN_SPLITS.find((s) => s.id === splitId)
    if (!builtin) return null
    const w = ruleWhere(builtin.rule)
    const parts = [IN_INBOX, w.sql]
    const params = [...w.params]
    for (const c of customs) {
      const cw = ruleWhere(JSON.parse(c.rule))
      parts.push(`NOT (${cw.sql})`)
      params.push(...cw.params)
    }
    return { sql: parts.join(' AND '), params }
  }
}

interface Where {
  sql: string
  params: unknown[]
}

export function ruleWhere(rule: SplitRule): Where {
  const parts: string[] = []
  const params: unknown[] = []
  const flag = (col: string, v: boolean | undefined) => {
    if (v !== undefined) parts.push(`t.${col} = ${v ? 1 : 0}`)
  }
  flag('is_list', rule.isList)
  flag('has_invite', rule.hasInvite)
  flag('is_automated', rule.isAutomated)
  if (rule.accountIds?.length) {
    parts.push(`t.account_id IN (${rule.accountIds.map(() => '?').join(', ')})`)
    params.push(...rule.accountIds)
  }
  const contains = (cols: string[], values: string[] | undefined) => {
    const vals = (values ?? []).map((v) => v.trim()).filter(Boolean)
    if (!vals.length) return
    const ors: string[] = []
    for (const v of vals) {
      for (const c of cols) {
        ors.push(`instr(lower(t.${c}), ?) > 0`)
        params.push(v.toLowerCase())
      }
    }
    parts.push(`(${ors.join(' OR ')})`)
  }
  contains(['from_addr', 'from_name'], rule.fromContains)
  contains(['subject'], rule.subjectContains)
  return { sql: parts.length ? parts.join(' AND ') : '1', params }
}

function folderWhere(name: FolderView): Where {
  switch (name) {
    case 'all':
      return { sql: IN_INBOX, params: [] }
    case 'snoozed':
      return { sql: 't.hidden = 0 AND t.snoozed_until IS NOT NULL', params: [] }
    case 'sent':
      return { sql: 't.hidden = 0 AND t.in_sent = 1', params: [] }
    case 'archive':
      return { sql: 't.hidden = 0 AND t.in_inbox = 0 AND t.reminded = 0', params: [] }
    case 'starred':
      return { sql: 't.hidden = 0 AND t.starred = 1', params: [] }
    case 'reminders':
      return { sql: 't.hidden = 0 AND EXISTS (SELECT 1 FROM reminders r WHERE r.thread_id = t.id)', params: [] }
  }
}

/** Turns "from:ann is:unread budget report" into an FTS expression plus thread filters. */
export function parseQuery(query: string): { match: string; filters: Where[] } {
  const terms: string[] = []
  const filters: Where[] = []
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`
  for (const tok of query.match(/\S+:"[^"]*"|"[^"]*"|\S+/g) ?? []) {
    const m = /^(\w+):(.*)$/.exec(tok)
    const val = (m ? m[2] : tok).replace(/^"|"$/g, '').trim()
    if (!val) continue
    const key = m?.[1].toLowerCase()
    if (key === 'from') terms.push(`sender : ${quote(val)}*`)
    else if (key === 'to') terms.push(`recipients : ${quote(val)}*`)
    else if (key === 'subject') terms.push(`subject : ${quote(val)}*`)
    else if (key === 'is' && val === 'unread') filters.push({ sql: 't.unread_count > 0', params: [] })
    else if (key === 'is' && val === 'starred') filters.push({ sql: 't.starred = 1', params: [] })
    else if (key === 'has' && val.startsWith('attach')) filters.push({ sql: 't.has_attachments = 1', params: [] })
    else if (key === 'in' && val === 'inbox') filters.push({ sql: 't.in_inbox = 1', params: [] })
    else terms.push(`${quote(tok.replace(/"/g, ''))}*`)
  }
  return { match: terms.join(' AND '), filters }
}

function shortName(name: string, addr: string): string {
  const n = name.trim()
  if (!n) return addr.split('@')[0]
  return n.includes(',') ? n : n.split(/\s+/)[0]
}

function firstRecipient(m: Row): string {
  const to = JSON.parse(m.to_json) as Address[]
  return to[0] ? `To: ${to[0].name || to[0].address}` : 'Me'
}

function accountOf(r: Row): Account {
  return { id: r.id, provider: r.provider, email: r.email, name: r.name, color: r.color, state: r.state, error: r.error }
}

function threadOf(r: Row): ThreadSummary {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    date: r.bump_date ?? r.last_date,
    fromName: r.from_name,
    fromAddr: r.from_addr,
    participants: JSON.parse(r.participants),
    messageCount: r.msg_count,
    unreadCount: r.unread_count,
    starred: !!r.starred,
    hasAttachments: !!r.has_attachments,
    inInbox: !!r.in_inbox,
    isList: !!r.is_list,
    hasInvite: !!r.has_invite,
    snoozedUntil: r.snoozed_until,
    reminded: r.reminded,
    reminderAt: r.reminder_at ?? null,
  }
}

function messageOf(r: Row): MessageDetail {
  return {
    id: r.id,
    threadId: r.thread_id,
    accountId: r.account_id,
    messageId: r.message_id,
    references: JSON.parse(r.refs),
    from: { name: r.from_name, address: r.from_addr },
    to: JSON.parse(r.to_json),
    cc: JSON.parse(r.cc_json),
    bcc: JSON.parse(r.bcc_json),
    subject: r.subject,
    date: r.date,
    seen: !!r.seen,
    flagged: !!r.flagged,
    isSent: !!r.is_sent,
    snippet: r.snippet,
    html: r.body_html,
    text: r.body_text,
    attachments: JSON.parse(r.attachments),
    bodyState: r.body_state ? 'ready' : 'missing',
  }
}
