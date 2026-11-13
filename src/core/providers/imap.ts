import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from 'imapflow'
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser'
import nodemailer from 'nodemailer'
import type { Address } from '../../shared/types'
import type {
  FolderCursor,
  FolderRole,
  FolderSnapshot,
  MailProvider,
  OutgoingMessage,
  RemoteBody,
  RemoteFolder,
  RemoteMessage,
} from '../provider'
import type { Profile } from './profiles'

export interface ImapCredentials {
  user: string
  password?: string
  /** Returns a fresh OAuth access token. */
  accessToken?: () => Promise<string>
}

/** Fetch at most this many bodies per sync; the rest load when opened. */
const BODY_BATCH = 150
const HEADER_FIELDS = ['references', 'in-reply-to', 'list-id', 'list-unsubscribe', 'auto-submitted', 'precedence', 'x-auto-response-suppress']

/** A connected IMAP + SMTP account. Works for Gmail, Outlook, iCloud, Proton Bridge and generic servers. */
export class ImapProvider implements MailProvider {
  private client: ImapFlow | null = null
  private watchers = new Set<ImapFlow>()

  constructor(
    private profile: Profile,
    private creds: ImapCredentials,
  ) {}

  private async auth() {
    return this.creds.accessToken
      ? { user: this.creds.user, accessToken: await this.creds.accessToken() }
      : { user: this.creds.user, pass: this.creds.password ?? '' }
  }

  private async newClient(): Promise<ImapFlow> {
    const c = new ImapFlow({
      host: this.profile.imap.host,
      port: this.profile.imap.port,
      secure: this.profile.imap.secure,
      auth: await this.auth(),
      logger: false,
      tls: { rejectUnauthorized: !this.profile.allowSelfSigned },
    })
    c.on('error', () => {})
    await c.connect()
    return c
  }

  private async conn(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client
    this.client = await this.newClient()
    this.client.on('close', () => (this.client = null))
    return this.client
  }

  private async withMailbox<T>(path: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(path)
    try {
      return await fn(c)
    } finally {
      lock.release()
    }
  }

  async listFolders(): Promise<RemoteFolder[]> {
    const c = await this.conn()
    const list = await c.list()
    const hasArchive = list.some((f) => f.specialUse === '\\Archive')
    return list
      .filter((f) => !f.flags?.has('\\Noselect'))
      .map((f) => ({ path: f.path, role: roleOf(f.path, f.specialUse, this.profile.gmail || !hasArchive) }))
  }

  async fetchFolder(path: string, cursor: FolderCursor, opts: { since: number; withBodies: boolean }): Promise<FolderSnapshot> {
    return this.withMailbox(path, async (c) => {
      const box = c.mailbox
      if (!box) throw new Error(`Could not open ${path}`)
      const uidvalidity = String(box.uidValidity)
      const reset = cursor.uidvalidity !== uidvalidity
      const uids = box.exists ? ((await c.search({ since: new Date(opts.since) }, { uid: true })) || []) : []
      const present: FolderSnapshot['present'] = []
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, flags: true }, { uid: true })) {
          present.push({ uid: m.uid, seen: !!m.flags?.has('\\Seen'), flagged: !!m.flags?.has('\\Flagged') })
        }
      }
      const fromUid = reset ? 0 : (cursor.uidnext ?? 0)
      const newUids = uids.filter((u) => u >= fromUid)
      const added: RemoteMessage[] = []
      if (newUids.length) {
        const query = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, headers: HEADER_FIELDS, threadId: this.profile.gmail }
        for await (const m of c.fetch(newUids, query, { uid: true })) added.push(toRemote(m))
      }
      if (opts.withBodies && added.length) {
        const want = [...added].sort((a, b) => b.date - a.date).slice(0, BODY_BATCH)
        const byUid = new Map(want.map((m) => [m.uid, m]))
        for await (const m of c.fetch(want.map((m) => m.uid), { uid: true, source: true }, { uid: true })) {
          const target = byUid.get(m.uid)
          if (target && m.source) target.body = bodyOf(await simpleParser(m.source))
        }
      }
      return { uidvalidity, uidnext: Number(box.uidNext), reset, added, present }
    })
  }

  private async parsed(path: string, uid: number): Promise<ParsedMail> {
    return this.withMailbox(path, async (c) => {
      const m = await c.fetchOne(String(uid), { source: true }, { uid: true })
      if (!m || !m.source) throw new Error('That message is no longer on the server')
      return simpleParser(m.source)
    })
  }

  async fetchBody(path: string, uid: number): Promise<RemoteBody> {
    return bodyOf(await this.parsed(path, uid))
  }

  async fetchAttachment(path: string, uid: number, index: number) {
    const a = (await this.parsed(path, uid)).attachments[index]
    if (!a) throw new Error('Attachment not found')
    return { filename: a.filename || `attachment-${index + 1}`, content: new Uint8Array(a.content) }
  }

  async move(path: string, uids: number[], toPath: string) {
    await this.withMailbox(path, async (c) => {
      await c.messageMove(uids, toPath, { uid: true })
    })
  }

  async setFlags(path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) {
    await this.withMailbox(path, async (c) => {
      for (const [flag, on] of [['\\Seen', flags.seen], ['\\Flagged', flags.flagged]] as const) {
        if (on === undefined) continue
        if (on) await c.messageFlagsAdd(uids, [flag], { uid: true })
        else await c.messageFlagsRemove(uids, [flag], { uid: true })
      }
    })
  }

  async send(msg: OutgoingMessage, sentPath: string | null) {
    const d = msg.draft
    const fmt = (a: Address[]) => a.map((x) => ({ name: x.name, address: x.address }))
    const mail = {
      messageId: msg.messageId,
      from: { name: msg.from.name, address: msg.from.address },
      to: fmt(d.to),
      cc: fmt(d.cc),
      bcc: fmt(d.bcc),
      subject: d.subject,
      text: d.text,
      html: d.html,
      inReplyTo: d.inReplyTo,
      references: d.references,
    }
    const auth = this.creds.accessToken
      ? { type: 'OAuth2' as const, user: this.creds.user, accessToken: await this.creds.accessToken() }
      : { user: this.creds.user, pass: this.creds.password ?? '' }
    const transport = nodemailer.createTransport({
      host: this.profile.smtp.host,
      port: this.profile.smtp.port,
      secure: this.profile.smtp.secure,
      requireTLS: !this.profile.smtp.secure,
      auth,
      tls: { rejectUnauthorized: !this.profile.allowSelfSigned },
    })
    try {
      await transport.sendMail(mail)
    } finally {
      transport.close()
    }
    if (!this.profile.serverSavesSent && sentPath) {
      const raw = await new Promise<Buffer>((resolve, reject) =>
        nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail(mail, (err, info) =>
          err ? reject(err) : resolve(info.message as Buffer),
        ),
      )
      await (await this.conn()).append(sentPath, raw, ['\\Seen'])
    }
  }

  /** IDLE on a second connection so normal commands are never blocked. */
  async watch(path: string, onChange: () => void): Promise<() => void> {
    let stopped = false
    let current: ImapFlow | null = null
    const run = async () => {
      let backoff = 5000
      while (!stopped) {
        try {
          current = await this.newClient()
          this.watchers.add(current)
          await current.mailboxOpen(path, { readOnly: true })
          backoff = 5000
          current.on('exists', onChange)
          current.on('expunge', onChange)
          current.on('flags', onChange)
          await new Promise<void>((resolve) => current!.once('close', () => resolve()))
        } catch {
          // fall through to retry
        }
        if (current) this.watchers.delete(current)
        if (!stopped) {
          await new Promise((r) => setTimeout(r, backoff))
          backoff = Math.min(backoff * 2, 300_000)
          onChange() // catch up on anything missed while disconnected
        }
      }
    }
    void run()
    return () => {
      stopped = true
      void current?.logout().catch(() => current?.close())
    }
  }

  async close() {
    for (const w of this.watchers) await w.logout().catch(() => w.close())
    this.watchers.clear()
    await this.client?.logout().catch(() => this.client?.close())
    this.client = null
  }
}

export function roleOf(path: string, specialUse: string | undefined, allMailIsArchive: boolean): FolderRole {
  if (path.toUpperCase() === 'INBOX' || specialUse === '\\Inbox') return 'inbox'
  switch (specialUse) {
    case '\\Sent':
      return 'sent'
    case '\\Archive':
      return 'archive'
    case '\\All':
      return allMailIsArchive ? 'archive' : 'other'
    case '\\Trash':
      return 'trash'
    case '\\Drafts':
      return 'drafts'
    case '\\Junk':
      return 'spam'
  }
  const name = path.split(/[/.]/).pop()!.toLowerCase()
  if (name === 'archive') return 'archive'
  if (name === 'sent' || name === 'sent items' || name === 'sent messages') return 'sent'
  if (name === 'trash' || name === 'deleted items' || name === 'deleted messages') return 'trash'
  return 'other'
}

function addr(a: { name?: string; address?: string } | undefined): Address {
  return { name: a?.name ?? '', address: (a?.address ?? '').toLowerCase() }
}

/** Unfolds a raw header block into a lower-cased name → value map. */
export function parseHeaders(raw: Buffer | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw) return out
  const text = raw.toString('utf8').replace(/\r?\n[ \t]+/g, ' ')
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim())
  }
  return out
}

export function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? []
}

function walk(s: MessageStructureObject | undefined, fn: (s: MessageStructureObject) => void) {
  if (!s) return
  fn(s)
  s.childNodes?.forEach((c) => walk(c, fn))
}

const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|bounce[s]?)([+._-].*)?@/i

export function toRemote(m: FetchMessageObject): RemoteMessage {
  const env = m.envelope
  const h = parseHeaders(m.headers)
  let hasAttachments = false
  let hasInvite = false
  walk(m.bodyStructure, (s) => {
    if (s.disposition === 'attachment') hasAttachments = true
    if (s.type === 'text/calendar' || s.type === 'application/ics') hasInvite = true
  })
  const from = addr(env?.from?.[0])
  const auto = h.get('auto-submitted')
  const precedence = h.get('precedence')?.toLowerCase()
  return {
    uid: m.uid,
    messageId: env?.messageId ?? '',
    inReplyTo: messageIds(env?.inReplyTo ?? h.get('in-reply-to'))[0] ?? null,
    references: messageIds(h.get('references')),
    nativeThreadId: m.threadId ?? null,
    subject: env?.subject ?? '',
    from,
    to: (env?.to ?? []).map(addr),
    cc: (env?.cc ?? []).map(addr),
    bcc: (env?.bcc ?? []).map(addr),
    date: new Date(env?.date ?? m.internalDate ?? Date.now()).getTime(),
    seen: !!m.flags?.has('\\Seen'),
    flagged: !!m.flags?.has('\\Flagged'),
    hasAttachments,
    isList: h.has('list-id') || h.has('list-unsubscribe'),
    hasInvite,
    isAutomated:
      (!!auto && auto.toLowerCase() !== 'no') ||
      precedence === 'bulk' ||
      precedence === 'junk' ||
      h.has('x-auto-response-suppress') ||
      AUTOMATED_SENDER.test(from.address),
    body: null,
  }
}

export function bodyOf(p: ParsedMail): RemoteBody {
  return {
    text: p.text ?? '',
    html: typeof p.html === 'string' ? p.html : null,
    // Keep the original index: fetchAttachment looks attachments up by it.
    attachments: p.attachments
      .map((a, index) => ({ a, index }))
      .filter(({ a }) => a.contentDisposition !== 'inline' || !a.cid)
      .map(({ a, index }) => ({ index, filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, size: a.size })),
  }
}

export function addressesOf(a: AddressObject | AddressObject[] | undefined): Address[] {
  return (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => addr(v)))
}
