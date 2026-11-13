import { randomUUID } from 'node:crypto'
import type {
  Account,
  AddPasswordAccount,
  Api,
  CoreEvents,
  Draft,
  OutboxItem,
  Settings,
  ThreadActionType,
  ThreadDetail,
} from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { Db, type Row } from './db'
import { isTransient, type FolderRole, type MailProvider } from './provider'
import { Store, type FolderRow } from './store'

/** Services the core needs from whatever process hosts it. */
export interface Host {
  encrypt(plain: string): Promise<string>
  decrypt(cipher: string): Promise<string>
  openExternal(url: string): Promise<void>
  /** Writes a file to a temporary location, opens it, and returns its path. */
  openFile(filename: string, content: Uint8Array): Promise<string>
}

export interface AccountSecret {
  password?: string
  refreshToken?: string
}

export type ProviderFactory = (
  account: Account & { config: Row },
  secret: AccountSecret,
  core: Core,
) => Promise<MailProvider>

export interface CoreOptions {
  dbPath: string
  host: Host
  createProvider: ProviderFactory
  /** Interactive sign-in for Gmail and Outlook. */
  oauthSignIn?: (provider: 'gmail' | 'outlook', settings: Settings, host: Host) => Promise<{ email: string; name: string; refreshToken: string }>
  seedDemo?: (core: Core) => Promise<Account[]>
  emit?: <K extends keyof CoreEvents>(event: K, payload: CoreEvents[K]) => void
  now?: () => number
}

interface Session {
  provider: Promise<MailProvider> | null
  queue: Promise<unknown>
  stopWatch: (() => void) | null
  syncQueued: Set<FolderRole>
}

const COLORS = ['#7c9cff', '#f59e8b', '#6fcf97', '#e6b655', '#c58af9', '#56c5d0', '#ef7fa8']
const SYNC_ROLES: FolderRole[] = ['inbox', 'sent', 'archive']
const SYNC_INTERVAL = 120_000
const DAY = 86_400_000

export class Core implements Api {
  readonly db: Db
  readonly store: Store
  private sessions = new Map<number, Session>()
  private now: () => number
  private lastFullSync = 0
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private background = new Set<Promise<unknown>>()

  constructor(private opts: CoreOptions) {
    this.db = new Db(opts.dbPath)
    this.store = new Store(this.db)
    this.now = opts.now ?? Date.now
    // Anything interrupted mid-flight by a previous exit goes back in the queue.
    this.db.run("UPDATE actions SET state = 'pending' WHERE state = 'running'")
    this.db.run("UPDATE outbox SET state = 'pending' WHERE state = 'sending'")
  }

  /** Begins background sync and the one-second scheduler. */
  start() {
    this.syncNow()
    this.interval = setInterval(() => this.tick(), 1000)
  }

  async stop() {
    if (this.interval) clearInterval(this.interval)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    await this.idle()
    for (const s of this.sessions.values()) {
      s.stopWatch?.()
      await s.provider?.then((p) => p.close()).catch(() => {})
    }
    this.db.close()
  }

  /** Resolves once all queued background work has finished. Used on shutdown and in tests. */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background])
  }

  private changed() {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.opts.emit?.('changed', undefined)
    }, 30)
  }

  private toast(message: string, kind: 'info' | 'error' = 'info') {
    this.opts.emit?.('toast', { message, kind })
  }

  // ---------- sessions ----------

  private session(accountId: number): Session {
    let s = this.sessions.get(accountId)
    if (!s) {
      s = { provider: null, queue: Promise.resolve(), stopWatch: null, syncQueued: new Set() }
      this.sessions.set(accountId, s)
    }
    return s
  }

  /** Runs `fn` with the account's connection, one job at a time per account. */
  private enqueue<T>(accountId: number, fn: (p: MailProvider) => Promise<T>): Promise<T> {
    const s = this.session(accountId)
    const job = s.queue.then(async () => {
      try {
        if (!s.provider) {
          const account = this.store.account(accountId)
          if (!account) throw new Error('Account was removed')
          const secret: AccountSecret = account.secret ? JSON.parse(await this.opts.host.decrypt(account.secret)) : {}
          s.provider = this.opts.createProvider(account, secret, this)
        }
        return await fn(await s.provider)
      } catch (e) {
        if (isTransient(e) || !(await s.provider?.then(() => true, () => false))) this.dropProvider(accountId)
        throw e
      }
    })
    s.queue = job.catch(() => {})
    this.background.add(job)
    const done = () => this.background.delete(job)
    job.then(done, done)
    return job
  }

  private dropProvider(accountId: number) {
    const s = this.session(accountId)
    s.stopWatch?.()
    s.stopWatch = null
    s.provider?.then((p) => p.close()).catch(() => {})
    s.provider = null
  }

  // ---------- accounts ----------

  accountsList(): Account[] {
    return this.store.accounts()
  }

  private async insertAccount(provider: Account['provider'], email: string, name: string, secret: AccountSecret, config: Row = {}): Promise<Account> {
    const count = this.db.get('SELECT COUNT(*) AS n FROM accounts')!.n as number
    const { id } = this.db.run(
      'INSERT INTO accounts(provider, email, name, color, secret, config, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      provider,
      email,
      name || email,
      COLORS[count % COLORS.length],
      await this.opts.host.encrypt(JSON.stringify(secret)),
      JSON.stringify(config),
      this.now(),
    )
    this.changed()
    return this.store.account(id)!
  }

  async accountsAddPassword(input: AddPasswordAccount): Promise<Account> {
    const config: Row = {}
    for (const k of ['imapHost', 'imapPort', 'smtpHost', 'smtpPort'] as const) if (input[k]) config[k] = input[k]
    const secret = { password: input.password }
    // Connect once before saving so a wrong password is reported immediately.
    const probe = await this.opts.createProvider(
      { id: 0, provider: input.provider, email: input.email, name: input.name, color: '', state: 'new', error: null, config },
      secret,
      this,
    )
    try {
      await probe.listFolders()
    } finally {
      await probe.close().catch(() => {})
    }
    const account = await this.insertAccount(input.provider, input.email, input.name, secret, config)
    this.requestSync(account.id)
    return account
  }

  async accountsAddOAuth(provider: 'gmail' | 'outlook'): Promise<Account> {
    if (!this.opts.oauthSignIn) throw new Error('Sign-in is not available')
    const r = await this.opts.oauthSignIn(provider, this.settingsGet(), this.opts.host)
    const account = await this.insertAccount(provider, r.email, r.name, { refreshToken: r.refreshToken })
    this.requestSync(account.id)
    return account
  }

  async accountsAddDemo(): Promise<Account[]> {
    if (!this.opts.seedDemo) throw new Error('Demo data is not available')
    const accounts = await this.opts.seedDemo(this)
    for (const a of accounts) this.requestSync(a.id)
    return accounts
  }

  /** Replaces an account's stored secret, e.g. when a refresh token rotates. */
  async updateSecret(accountId: number, secret: AccountSecret) {
    this.db.run('UPDATE accounts SET secret = ? WHERE id = ?', await this.opts.host.encrypt(JSON.stringify(secret)), accountId)
  }

  /** Used by the demo seeder. */
  addAccountRecord(provider: Account['provider'], email: string, name: string) {
    return this.insertAccount(provider, email, name, {})
  }

  accountsRemove(id: number) {
    this.dropProvider(id)
    this.sessions.delete(id)
    this.db.tx(() => {
      this.db.run('DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', id)
      this.db.run('DELETE FROM accounts WHERE id = ?', id)
    })
    this.changed()
  }

  // ---------- settings ----------

  settingsGet(): Settings {
    const r = this.db.get("SELECT value FROM meta WHERE key = 'settings'")
    return { ...DEFAULT_SETTINGS, ...(r ? JSON.parse(r.value) : {}) }
  }

  settingsSet(patch: Partial<Settings>): Settings {
    const next = { ...this.settingsGet(), ...patch }
    this.db.run("INSERT INTO meta(key, value) VALUES('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(next))
    this.changed()
    return next
  }

  // ---------- sync ----------

  syncNow() {
    this.lastFullSync = this.now()
    for (const a of this.store.accounts()) this.requestSync(a.id)
  }

  /** Queues a sync of the given folder roles; overlapping requests collapse into one. */
  requestSync(accountId: number, roles: FolderRole[] = SYNC_ROLES): Promise<void> {
    const s = this.session(accountId)
    const alreadyQueued = s.syncQueued.size > 0
    for (const r of roles) s.syncQueued.add(r)
    if (alreadyQueued) return Promise.resolve()
    return this.enqueue(accountId, async (p) => {
      const wanted = [...s.syncQueued]
      s.syncQueued.clear()
      await this.syncAccount(accountId, p, wanted)
    }).catch((e) => {
      s.syncQueued.clear()
      this.db.run("UPDATE accounts SET state = 'error', error = ? WHERE id = ?", isTransient(e) ? 'Offline. Will retry.' : errorText(e), accountId)
      this.changed()
    })
  }

  private async syncAccount(accountId: number, p: MailProvider, roles: FolderRole[]) {
    const account = this.store.account(accountId)
    if (!account) return
    if (account.state !== 'ok') {
      this.db.run("UPDATE accounts SET state = 'syncing', error = NULL WHERE id = ?", accountId)
      this.changed()
    }
    const full = SYNC_ROLES.every((r) => roles.includes(r))
    if (full || this.store.folders(accountId).length === 0) {
      for (const f of await p.listFolders()) this.store.upsertFolder(accountId, f.path, f.role)
    }
    const since = this.now() - this.settingsGet().syncDays * DAY
    for (const role of roles) {
      const folder = this.store.folderByRole(accountId, role)
      if (!folder) continue
      const snap = await p.fetchFolder(folder.path, { uidvalidity: folder.uidvalidity, uidnext: folder.uidnext }, { since, withBodies: role === 'inbox' })
      if (snap.reset && folder.uidvalidity !== null) this.store.clearFolder(folder)
      this.store.ingest(folder, snap.added, account.email)
      this.store.reconcile(folder, snap.present)
      this.store.setFolderCursor(folder.id, snap.uidvalidity, snap.uidnext, this.now())
      this.changed()
    }
    if (full) this.store.collectOrphans(accountId)
    this.db.run("UPDATE accounts SET state = 'ok', error = NULL WHERE id = ?", accountId)
    this.changed()

    const s = this.session(accountId)
    const inbox = this.store.folderByRole(accountId, 'inbox')
    if (!s.stopWatch && inbox) {
      s.stopWatch = await p.watch(inbox.path, () => void this.requestSync(accountId, ['inbox']))
    }
  }

  // ---------- scheduler ----------

  /** Runs everything that is due. Called once a second; safe to call at any time. */
  tick() {
    const now = this.now()
    this.wakeSnoozed(now)
    this.fireReminders(now)
    this.runDueActions(now)
    this.runDueOutbox(now)
    if (now - this.lastFullSync >= SYNC_INTERVAL) this.syncNow()
  }

  // ---------- thread actions ----------

  threadsAction(ids: number[], type: ThreadActionType): string | null {
    const undoable = type === 'archive' || type === 'trash'
    const batch = randomUUID()
    const runAt = this.now() + (undoable ? this.settingsGet().undoSeconds * 1000 : 0)
    this.db.tx(() => {
      for (const id of ids) {
        const t = this.db.get('SELECT * FROM threads WHERE id = ?', id)
        if (!t) continue
        const payload = this.applyLocal(t, type)
        this.db.run(
          'INSERT INTO actions(account_id, thread_id, type, payload, batch, run_at) VALUES(?, ?, ?, ?, ?, ?)',
          t.account_id,
          id,
          type,
          JSON.stringify(payload),
          batch,
          runAt,
        )
      }
    })
    this.changed()
    return undoable ? batch : null
  }

  private applyLocal(t: Row, type: ThreadActionType): Row {
    const id = t.id as number
    let payload: Row = {}
    if (type === 'archive') {
      payload = { reminded: t.reminded }
      this.db.run(
        `UPDATE locations SET removed = 1 WHERE removed = 0
           AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)
           AND folder_id IN (SELECT id FROM folders WHERE account_id = ? AND role = 'inbox')`,
        id,
        t.account_id,
      )
      this.db.run('UPDATE threads SET reminded = 0 WHERE id = ?', id)
    } else if (type === 'trash') {
      this.db.run('UPDATE locations SET removed = 1 WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)', id)
      this.db.run('UPDATE threads SET hidden = 1 WHERE id = ?', id)
    } else {
      const msgs = this.db.all('SELECT id, seen, flagged, is_sent FROM messages WHERE thread_id = ? ORDER BY date, id', id)
      let targets: Row[] = []
      if (type === 'read') targets = msgs.filter((m) => !m.seen)
      if (type === 'unread') targets = [msgs.filter((m) => !m.is_sent).pop() ?? msgs[msgs.length - 1]].filter((m) => m && m.seen)
      if (type === 'star') targets = msgs.some((m) => m.flagged) ? [] : msgs.slice(-1)
      if (type === 'unstar') targets = msgs.filter((m) => m.flagged)
      const [col, val] = type === 'read' || type === 'unread' ? ['seen', type === 'read'] : ['flagged', type === 'star']
      for (const m of targets) this.db.run(`UPDATE messages SET ${col} = ? WHERE id = ?`, val, m.id)
      payload = { ids: targets.map((m) => m.id) }
    }
    this.store.recomputeThread(id)
    return payload
  }

  private rollback(a: Row) {
    const payload = JSON.parse(a.payload) as Row
    const id = a.thread_id as number
    if (a.type === 'archive') {
      this.db.run(
        `UPDATE locations SET removed = 0 WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)
           AND folder_id IN (SELECT id FROM folders WHERE account_id = ? AND role = 'inbox')`,
        id,
        a.account_id,
      )
      this.db.run('UPDATE threads SET reminded = ? WHERE id = ?', payload.reminded ?? 0, id)
    } else if (a.type === 'trash') {
      this.db.run('UPDATE locations SET removed = 0 WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)', id)
      this.db.run('UPDATE threads SET hidden = 0 WHERE id = ?', id)
    } else {
      const [col, val] = a.type === 'read' || a.type === 'unread' ? ['seen', a.type !== 'read'] : ['flagged', a.type !== 'star']
      for (const mid of payload.ids ?? []) this.db.run(`UPDATE messages SET ${col} = ? WHERE id = ?`, val, mid)
    }
    this.db.run('DELETE FROM actions WHERE id = ?', a.id)
    this.store.recomputeThread(id)
  }

  undo(token: string): boolean {
    if (token.startsWith('snooze:')) {
      this.threadsUnsnooze(token.slice(7).split(',').map(Number))
      return true
    }
    const rows = this.db.all("SELECT * FROM actions WHERE batch = ? AND state = 'pending' ORDER BY id DESC", token)
    this.db.tx(() => rows.forEach((a) => this.rollback(a)))
    this.changed()
    return rows.length > 0
  }

  private runDueActions(now: number) {
    // Flag changes go first: a move gives the message a new uid in its new folder.
    const due = this.db.all("SELECT * FROM actions WHERE state = 'pending' AND run_at <= ? ORDER BY type IN ('archive', 'trash'), id", now)
    for (const a of due) {
      this.db.run("UPDATE actions SET state = 'running' WHERE id = ?", a.id)
      this.enqueue(a.account_id, (p) => this.runAction(a, p)).then(
        () => this.changed(),
        (e) => {
          const transient = isTransient(e)
          const attempts = a.attempts + 1
          if (!transient && attempts >= 3) {
            this.db.tx(() => this.rollback(a))
            this.toast(`Couldn't ${a.type} a conversation: ${errorText(e)}`, 'error')
          } else {
            const delay = Math.min(300_000, 5000 * 2 ** Math.min(a.attempts, 6))
            this.db.run("UPDATE actions SET state = 'pending', attempts = ?, run_at = ?, error = ? WHERE id = ?", transient ? a.attempts : attempts, this.now() + delay, errorText(e), a.id)
          }
          this.changed()
        },
      )
    }
  }

  private async runAction(a: Row, p: MailProvider) {
    const accountId = a.account_id as number
    const threadId = a.thread_id as number
    const type = a.type as ThreadActionType
    const byFolder = (rows: Row[]) => {
      const groups = new Map<number, number[]>()
      for (const r of rows) groups.set(r.folder_id, [...(groups.get(r.folder_id) ?? []), r.uid])
      const folders = new Map(this.store.folders(accountId).map((f) => [f.id, f]))
      return [...groups].map(([fid, uids]) => ({ folder: folders.get(fid)!, uids }))
    }
    if (type === 'archive' || type === 'trash') {
      const destRole = type === 'archive' ? 'archive' : 'trash'
      const dest = this.store.folderByRole(accountId, destRole)
      const rows = this.db.all(
        `SELECT l.id, l.folder_id, l.uid FROM locations l JOIN messages m ON m.id = l.message_id
         WHERE m.thread_id = ? AND l.removed = 1`,
        threadId,
      )
      if (rows.length && !dest) throw new Error(`This account has no ${destRole} folder`)
      for (const g of byFolder(rows)) {
        if (g.folder.id !== dest!.id) await p.move(g.folder.path, g.uids, dest!.path)
      }
      this.db.tx(() => {
        for (const r of rows) this.db.run('DELETE FROM locations WHERE id = ? AND folder_id != ?', r.id, dest?.id ?? -1)
        this.db.run('UPDATE locations SET removed = 0 WHERE removed = 1 AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)', threadId)
        this.db.run('DELETE FROM actions WHERE id = ?', a.id)
        this.store.recomputeThread(threadId)
      })
      if (type === 'archive') void this.requestSync(accountId, ['archive'])
    } else {
      const ids = (JSON.parse(a.payload).ids ?? []) as number[]
      if (ids.length) {
        const rows = this.db.all(`SELECT folder_id, uid FROM locations WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids)
        const flags = type === 'read' || type === 'unread' ? { seen: type === 'read' } : { flagged: type === 'star' }
        for (const g of byFolder(rows)) await p.setFlags(g.folder.path, g.uids, flags)
      }
      this.db.run('DELETE FROM actions WHERE id = ?', a.id)
    }
  }

  // ---------- snooze and reminders ----------

  threadsSnooze(ids: number[], until: number): string {
    this.db.tx(() => {
      for (const id of ids) this.db.run('UPDATE threads SET snoozed_until = ?, reminded = 0 WHERE id = ?', until, id)
    })
    this.changed()
    return `snooze:${ids.join(',')}`
  }

  threadsUnsnooze(ids: number[]) {
    this.db.tx(() => {
      for (const id of ids) this.db.run('UPDATE threads SET snoozed_until = NULL WHERE id = ?', id)
    })
    this.changed()
  }

  private wakeSnoozed(now: number) {
    const r = this.db.run('UPDATE threads SET snoozed_until = NULL, reminded = 1, bump_date = ? WHERE snoozed_until <= ?', now, now)
    if (r.changes) this.changed()
  }

  remindersSet(threadId: number, dueAt: number, ifNoReply: boolean) {
    const t = this.store.thread(threadId)
    if (!t) return
    this.db.tx(() => {
      this.db.run('DELETE FROM reminders WHERE thread_id = ?', threadId)
      this.db.run('INSERT INTO reminders(account_id, thread_id, due_at, if_no_reply, created_at) VALUES(?, ?, ?, ?, ?)', t.accountId, threadId, dueAt, ifNoReply, this.now())
    })
    this.changed()
  }

  remindersClear(threadId: number) {
    this.db.run('DELETE FROM reminders WHERE thread_id = ?', threadId)
    this.changed()
  }

  private fireReminders(now: number) {
    const due = this.db.all('SELECT * FROM reminders WHERE due_at <= ?', now)
    if (!due.length) return
    this.db.tx(() => {
      for (const r of due) {
        // A reminder set while composing only knows the Message-ID until the sent copy syncs.
        const threadId: number | undefined =
          r.thread_id ?? this.db.get('SELECT thread_id FROM thread_refs WHERE account_id = ? AND msgid = ?', r.account_id, r.msgid)?.thread_id
        if (!threadId) {
          if (now - r.due_at > DAY) this.db.run('DELETE FROM reminders WHERE id = ?', r.id)
          continue
        }
        const replied = r.if_no_reply && this.db.get('SELECT 1 FROM messages WHERE thread_id = ? AND is_sent = 0 AND date > ? LIMIT 1', threadId, r.created_at)
        if (!replied) this.db.run('UPDATE threads SET reminded = 2, bump_date = ?, snoozed_until = NULL WHERE id = ?', now, threadId)
        this.db.run('DELETE FROM reminders WHERE id = ?', r.id)
      }
    })
    this.changed()
  }

  // ---------- compose and outbox ----------

  composeSend(draft: Draft, sendAt?: number): OutboxItem {
    const account = this.store.account(draft.accountId)
    if (!account) throw new Error('Choose an account to send from')
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) throw new Error('Add at least one recipient')
    const messageId = `<${randomUUID()}@${account.email.split('@')[1] ?? 'localhost'}>`
    const at = sendAt ?? this.now() + this.settingsGet().undoSeconds * 1000
    const { id } = this.db.tx(() => {
      if (draft.remindAt) {
        this.db.run('INSERT INTO reminders(account_id, msgid, due_at, if_no_reply, created_at) VALUES(?, ?, ?, 1, ?)', draft.accountId, messageId, draft.remindAt, at)
      }
      return this.db.run('INSERT INTO outbox(account_id, message_id, draft, send_at) VALUES(?, ?, ?, ?)', draft.accountId, messageId, JSON.stringify(draft), at)
    })
    this.changed()
    return this.outboxList().find((o) => o.id === id)!
  }

  outboxList(): OutboxItem[] {
    return this.db.all("SELECT * FROM outbox ORDER BY send_at").map(outboxOf)
  }

  outboxCancel(id: number): OutboxItem | null {
    const r = this.db.get("SELECT * FROM outbox WHERE id = ? AND state != 'sending'", id)
    if (!r) return null
    this.db.tx(() => {
      this.db.run('DELETE FROM reminders WHERE account_id = ? AND msgid = ?', r.account_id, r.message_id)
      this.db.run('DELETE FROM outbox WHERE id = ?', id)
    })
    this.changed()
    return outboxOf(r)
  }

  outboxRetry(id: number) {
    this.db.run("UPDATE outbox SET state = 'pending', error = NULL, attempts = 0, send_at = ? WHERE id = ? AND state = 'failed'", this.now(), id)
    this.changed()
  }

  private runDueOutbox(now: number) {
    const due = this.db.all("SELECT * FROM outbox WHERE state = 'pending' AND send_at <= ? ORDER BY send_at", now)
    for (const o of due) {
      const account = this.store.account(o.account_id)
      if (!account) continue
      this.db.run("UPDATE outbox SET state = 'sending' WHERE id = ?", o.id)
      const sent = this.store.folderByRole(account.id, 'sent')
      this.enqueue(account.id, (p) =>
        p.send({ messageId: o.message_id, from: { name: account.name, address: account.email }, draft: JSON.parse(o.draft) }, sent?.path ?? null),
      ).then(
        () => {
          this.db.run('DELETE FROM outbox WHERE id = ?', o.id)
          this.changed()
          void this.requestSync(account.id, ['sent', 'inbox'])
        },
        (e) => {
          if (isTransient(e)) {
            const delay = Math.min(300_000, 5000 * 2 ** Math.min(o.attempts, 6))
            this.db.run("UPDATE outbox SET state = 'pending', attempts = attempts + 1, send_at = ?, error = ? WHERE id = ?", this.now() + delay, 'Offline. Will retry.', o.id)
          } else {
            this.db.run("UPDATE outbox SET state = 'failed', error = ? WHERE id = ?", errorText(e), o.id)
            this.toast(`Message not sent: ${errorText(e)}`, 'error')
          }
          this.changed()
        },
      )
    }
  }

  // ---------- reading ----------

  splitsList = () => this.store.splits()
  splitsSave(input: Parameters<Api['splitsSave']>[0]) {
    this.store.saveSplit(input)
    this.changed()
  }
  splitsDelete(id: string) {
    this.store.deleteSplit(id)
    this.changed()
  }
  threadsList: Api['threadsList'] = (view, limit) => this.store.listThreads(view, limit)

  /** Returns the thread, fetching any message bodies that have not been downloaded yet. */
  async threadsGet(id: number): Promise<ThreadDetail | null> {
    const detail = this.store.threadDetail(id)
    if (!detail) return null
    const missing = detail.messages.filter((m) => m.bodyState === 'missing')
    if (!missing.length) return detail
    for (const m of missing) {
      const loc = this.locate(m.id)
      if (!loc) continue
      try {
        const body = await this.enqueue(detail.accountId, (p) => p.fetchBody(loc.folder.path, loc.uid))
        this.db.tx(() => {
          this.store.setBody(m.id, body)
          this.store.recomputeThread(id)
        })
      } catch {
        break // offline or gone: show what we have
      }
    }
    this.changed()
    return this.store.threadDetail(id) ?? null
  }

  private locate(messageRowId: number): { folder: FolderRow; uid: number } | undefined {
    const r = this.db.get(
      'SELECT f.*, l.uid AS loc_uid FROM locations l JOIN folders f ON f.id = l.folder_id WHERE l.message_id = ? ORDER BY l.removed LIMIT 1',
      messageRowId,
    )
    return r ? { folder: r as unknown as FolderRow, uid: r.loc_uid } : undefined
  }

  async attachmentOpen(messageRowId: number, index: number): Promise<string> {
    const m = this.db.get('SELECT account_id FROM messages WHERE id = ?', messageRowId)
    const loc = this.locate(messageRowId)
    if (!m || !loc) throw new Error('That message is no longer available')
    const file = await this.enqueue(m.account_id, (p) => p.fetchAttachment(loc.folder.path, loc.uid, index))
    return this.opts.host.openFile(file.filename, file.content)
  }
}

function outboxOf(r: Row): OutboxItem {
  return { id: r.id, accountId: r.account_id, draft: JSON.parse(r.draft), sendAt: r.send_at, state: r.state, error: r.error }
}

function errorText(e: unknown): string {
  const anyE = e as { responseText?: string; message?: string }
  return anyE?.responseText || anyE?.message || String(e)
}
