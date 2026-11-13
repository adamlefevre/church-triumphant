export type ProviderKind = 'gmail' | 'outlook' | 'icloud' | 'proton' | 'imap' | 'demo'

export interface Address {
  name: string
  address: string
}

export interface Account {
  id: number
  provider: ProviderKind
  email: string
  name: string
  color: string
  state: 'new' | 'syncing' | 'ok' | 'error'
  error: string | null
}

export interface ThreadSummary {
  id: number
  accountId: number
  subject: string
  snippet: string
  date: number
  fromName: string
  fromAddr: string
  participants: string[]
  messageCount: number
  unreadCount: number
  starred: boolean
  hasAttachments: boolean
  inInbox: boolean
  isList: boolean
  hasInvite: boolean
  snoozedUntil: number | null
  /** 0 = none, 1 = returned from snooze, 2 = reminder fired */
  reminded: number
  reminderAt: number | null
}

export interface AttachmentMeta {
  index: number
  filename: string
  contentType: string
  size: number
}

export interface MessageDetail {
  id: number
  threadId: number
  accountId: number
  messageId: string
  references: string[]
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  date: number
  seen: boolean
  flagged: boolean
  isSent: boolean
  snippet: string
  html: string | null
  text: string | null
  attachments: AttachmentMeta[]
  bodyState: 'ready' | 'missing'
}

export interface ThreadDetail extends ThreadSummary {
  messages: MessageDetail[]
}

export interface Draft {
  accountId: number
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  text: string
  inReplyTo?: string
  references?: string[]
  /** Resurface the thread at this time if nobody has replied. */
  remindAt?: number
}

export interface OutboxItem {
  id: number
  accountId: number
  draft: Draft
  sendAt: number
  state: 'pending' | 'sending' | 'failed'
  error: string | null
}

/** Each field is optional; a thread must satisfy every field that is set. */
export interface SplitRule {
  accountIds?: number[]
  isList?: boolean
  hasInvite?: boolean
  isAutomated?: boolean
  /** Matches if the sender address or name contains any of these (case-insensitive). */
  fromContains?: string[]
  subjectContains?: string[]
}

export interface Split {
  /** 'important' | 'calendar' | 'news' | 'other' | 'acct:<id>' | 'custom:<id>' */
  id: string
  name: string
  kind: 'builtin' | 'account' | 'custom'
  rule: SplitRule
  count: number
  unread: number
}

export type FolderView = 'all' | 'snoozed' | 'sent' | 'archive' | 'starred' | 'reminders'

export type View =
  | { kind: 'split'; splitId: string }
  | { kind: 'folder'; name: FolderView }
  | { kind: 'search'; query: string }

export type ThreadActionType = 'archive' | 'trash' | 'read' | 'unread' | 'star' | 'unstar'

export interface Settings {
  googleClientId: string
  googleClientSecret: string
  microsoftClientId: string
  undoSeconds: number
  syncDays: number
  loadRemoteImages: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  undoSeconds: 10,
  syncDays: 90,
  loadRemoteImages: false,
}

export interface AddPasswordAccount {
  provider: 'icloud' | 'proton' | 'imap'
  email: string
  name: string
  password: string
  /** Only for 'imap' and to override Proton Bridge ports. */
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
}

export interface Toast {
  message: string
  kind: 'info' | 'error'
}

/** Methods the UI can call on the mail core. */
export interface Api {
  accountsList(): Account[]
  accountsAddPassword(input: AddPasswordAccount): Promise<Account>
  accountsAddOAuth(provider: 'gmail' | 'outlook'): Promise<Account>
  accountsAddDemo(): Promise<Account[]>
  accountsRemove(id: number): void
  settingsGet(): Settings
  settingsSet(patch: Partial<Settings>): Settings
  splitsList(): Split[]
  splitsSave(input: { id?: string; name: string; rule: SplitRule }): void
  splitsDelete(id: string): void
  threadsList(view: View, limit?: number): ThreadSummary[]
  threadsGet(id: number): Promise<ThreadDetail | null>
  /** Returns an undo token when the action can be undone. */
  threadsAction(ids: number[], type: ThreadActionType): string | null
  threadsSnooze(ids: number[], until: number): string
  threadsUnsnooze(ids: number[]): void
  remindersSet(threadId: number, dueAt: number, ifNoReply: boolean): void
  remindersClear(threadId: number): void
  undo(token: string): boolean
  composeSend(draft: Draft, sendAt?: number): OutboxItem
  outboxList(): OutboxItem[]
  /** Cancels a queued message and returns it so the composer can reopen it. */
  outboxCancel(id: number): OutboxItem | null
  outboxRetry(id: number): void
  attachmentOpen(messageId: number, index: number): Promise<string>
  syncNow(): void
}

export type ApiMethod = keyof Api

export interface CoreEvents {
  changed: undefined
  toast: Toast
}
