import type { Address } from '../../shared/types'
import {
  offlineError,
  type FolderCursor,
  type FolderRole,
  type FolderSnapshot,
  type MailProvider,
  type OutgoingMessage,
  type RemoteBody,
  type RemoteFolder,
  type RemoteMessage,
} from '../provider'

interface FakeFolder {
  role: FolderRole
  uidvalidity: number
  uidnext: number
  messages: RemoteMessage[]
}

export interface FakeState {
  folders: Record<string, FakeFolder>
}

export type FakeMessageInput = Partial<Omit<RemoteMessage, 'uid' | 'body'>> & {
  from: Address
  subject: string
  text?: string
  html?: string | null
}

let counter = 0

/**
 * An in-memory mail server. Backs the demo accounts and the tests, and behaves like
 * IMAP where it matters: per-folder uids, uidvalidity, moves that assign new uids.
 */
export class FakeMailbox {
  folders = new Map<string, FakeFolder>()
  private listeners = new Map<string, Set<() => void>>()
  onMutate: (() => void) | null = null

  constructor(state?: FakeState) {
    if (state) {
      for (const [path, f] of Object.entries(state.folders)) this.folders.set(path, f)
    } else {
      this.addFolder('INBOX', 'inbox')
      this.addFolder('Sent', 'sent')
      this.addFolder('Archive', 'archive')
      this.addFolder('Trash', 'trash')
    }
  }

  toJSON(): FakeState {
    return { folders: Object.fromEntries(this.folders) }
  }

  addFolder(path: string, role: FolderRole) {
    this.folders.set(path, { role, uidvalidity: 1, uidnext: 1, messages: [] })
  }

  folder(path: string): FakeFolder {
    const f = this.folders.get(path)
    if (!f) throw new Error(`No such folder: ${path}`)
    return f
  }

  deliver(path: string, input: FakeMessageInput): RemoteMessage {
    const f = this.folder(path)
    const text = input.text ?? ''
    const msg: RemoteMessage = {
      messageId: `<fake-${++counter}-${Math.random().toString(36).slice(2, 10)}@example.test>`,
      inReplyTo: null,
      references: [],
      nativeThreadId: null,
      to: [],
      cc: [],
      bcc: [],
      date: Date.now(),
      seen: false,
      flagged: false,
      hasAttachments: false,
      isList: false,
      hasInvite: false,
      isAutomated: false,
      ...input,
      uid: f.uidnext++,
      body: { text, html: input.html ?? null, attachments: [] },
    }
    f.messages.push(msg)
    this.changed(path)
    return msg
  }

  /** Simulates the server renumbering a folder. */
  resetUidValidity(path: string) {
    const f = this.folder(path)
    f.uidvalidity++
    f.uidnext = 1
    for (const m of f.messages) m.uid = f.uidnext++
    this.changed(path)
  }

  remove(path: string, uid: number) {
    const f = this.folder(path)
    f.messages = f.messages.filter((m) => m.uid !== uid)
    this.changed(path)
  }

  changed(path: string) {
    this.onMutate?.()
    for (const cb of this.listeners.get(path) ?? []) cb()
  }

  listen(path: string, cb: () => void): () => void {
    if (!this.listeners.has(path)) this.listeners.set(path, new Set())
    this.listeners.get(path)!.add(cb)
    return () => this.listeners.get(path)?.delete(cb)
  }
}

export class FakeProvider implements MailProvider {
  offline = false
  /** When set, the next non-network operation fails with this error. */
  failWith: Error | null = null
  sent: OutgoingMessage[] = []
  calls: string[] = []

  constructor(
    readonly box: FakeMailbox,
    private opts: { withBodies?: boolean } = {},
  ) {}

  private guard(name: string) {
    this.calls.push(name)
    if (this.offline) throw offlineError()
    if (this.failWith) {
      const e = this.failWith
      this.failWith = null
      throw e
    }
  }

  async listFolders(): Promise<RemoteFolder[]> {
    this.guard('listFolders')
    return [...this.box.folders].map(([path, f]) => ({ path, role: f.role }))
  }

  async fetchFolder(path: string, cursor: FolderCursor, opts: { since: number; withBodies: boolean }): Promise<FolderSnapshot> {
    this.guard('fetchFolder')
    const f = this.box.folder(path)
    const reset = cursor.uidvalidity !== String(f.uidvalidity)
    const inWindow = f.messages.filter((m) => m.date >= opts.since)
    const fresh = reset ? inWindow : inWindow.filter((m) => m.uid >= (cursor.uidnext ?? 0))
    const withBodies = opts.withBodies || this.opts.withBodies
    return {
      uidvalidity: String(f.uidvalidity),
      uidnext: f.uidnext,
      reset,
      added: fresh.map((m) => ({ ...m, body: withBodies ? m.body : null })),
      present: inWindow.map((m) => ({ uid: m.uid, seen: m.seen, flagged: m.flagged })),
    }
  }

  async fetchBody(path: string, uid: number): Promise<RemoteBody> {
    this.guard('fetchBody')
    const m = this.box.folder(path).messages.find((x) => x.uid === uid)
    if (!m?.body) throw new Error('Message not found')
    return m.body
  }

  async fetchAttachment(): Promise<{ filename: string; content: Uint8Array }> {
    this.guard('fetchAttachment')
    return { filename: 'demo.txt', content: new TextEncoder().encode('Demo attachment\n') }
  }

  async move(path: string, uids: number[], toPath: string) {
    this.guard('move')
    const from = this.box.folder(path)
    const to = this.box.folder(toPath)
    for (const uid of uids) {
      const m = from.messages.find((x) => x.uid === uid)
      if (!m) continue
      from.messages = from.messages.filter((x) => x !== m)
      to.messages.push({ ...m, uid: to.uidnext++ })
    }
    this.box.changed(path)
    this.box.changed(toPath)
  }

  async setFlags(path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }) {
    this.guard('setFlags')
    for (const m of this.box.folder(path).messages) {
      if (!uids.includes(m.uid)) continue
      if (flags.seen !== undefined) m.seen = flags.seen
      if (flags.flagged !== undefined) m.flagged = flags.flagged
    }
    this.box.changed(path)
  }

  async send(msg: OutgoingMessage, sentPath: string | null) {
    this.guard('send')
    this.sent.push(msg)
    const sent = sentPath ?? [...this.box.folders].find(([, f]) => f.role === 'sent')?.[0]
    if (!sent) return
    this.box.deliver(sent, {
      messageId: msg.messageId,
      inReplyTo: msg.draft.inReplyTo ?? null,
      references: msg.draft.references ?? [],
      from: msg.from,
      to: msg.draft.to,
      cc: msg.draft.cc,
      bcc: msg.draft.bcc,
      subject: msg.draft.subject,
      text: msg.draft.text,
      html: msg.draft.html,
      seen: true,
    })
  }

  async watch(path: string, onChange: () => void) {
    return this.box.listen(path, onChange)
  }

  async close() {}
}
