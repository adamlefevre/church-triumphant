import type { Address, AttachmentMeta, Draft } from '../shared/types'

export type FolderRole = 'inbox' | 'sent' | 'archive' | 'trash' | 'drafts' | 'spam' | 'other'

export interface RemoteFolder {
  path: string
  role: FolderRole
}

export interface RemoteBody {
  text: string
  html: string | null
  attachments: AttachmentMeta[]
}

export interface RemoteMessage {
  uid: number
  /** Message-ID header, including angle brackets. Empty if the message has none. */
  messageId: string
  inReplyTo: string | null
  references: string[]
  /** Provider-native thread id (Gmail X-GM-THRID), when available. */
  nativeThreadId: string | null
  subject: string
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  date: number
  seen: boolean
  flagged: boolean
  hasAttachments: boolean
  isList: boolean
  hasInvite: boolean
  isAutomated: boolean
  body: RemoteBody | null
}

export interface FolderCursor {
  uidvalidity: string | null
  uidnext: number | null
}

export interface FolderSnapshot {
  uidvalidity: string
  uidnext: number
  /** True when the cursor could not be used and `added` is the whole window. */
  reset: boolean
  added: RemoteMessage[]
  /** Every message currently in the sync window, with its flags. */
  present: { uid: number; seen: boolean; flagged: boolean }[]
}

export interface OutgoingMessage {
  messageId: string
  from: Address
  draft: Draft
}

/** One connected mail account. All four providers are driven through this interface. */
export interface MailProvider {
  listFolders(): Promise<RemoteFolder[]>
  fetchFolder(
    path: string,
    cursor: FolderCursor,
    opts: { since: number; withBodies: boolean },
  ): Promise<FolderSnapshot>
  fetchBody(path: string, uid: number): Promise<RemoteBody>
  fetchAttachment(path: string, uid: number, index: number): Promise<{ filename: string; content: Uint8Array }>
  move(path: string, uids: number[], toPath: string): Promise<void>
  setFlags(path: string, uids: number[], flags: { seen?: boolean; flagged?: boolean }): Promise<void>
  /** Sends the message; saves a copy to `sentPath` when the provider does not do so itself. */
  send(msg: OutgoingMessage, sentPath: string | null): Promise<void>
  /** Calls back when the folder changes on the server. Returns a function that stops watching. */
  watch(path: string, onChange: () => void): Promise<() => void>
  close(): Promise<void>
}

const TRANSIENT = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'NoConnection',
  'ESOCKET',
  'ECONNECTION',
  'ETIMEOUT',
  'OFFLINE',
])

/** Network-level failures are retried forever; anything else is a real rejection. */
export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return typeof code === 'string' && TRANSIENT.has(code)
}

export function offlineError(message = 'Offline'): Error {
  return Object.assign(new Error(message), { code: 'OFFLINE' })
}
