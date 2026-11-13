import { create } from 'zustand'
import type {
  Account,
  Address,
  Draft,
  OutboxItem,
  Settings,
  Split,
  ThreadActionType,
  ThreadDetail,
  ThreadSummary,
  View,
} from '../../shared/types'
import { api } from './api'

export interface ComposeState {
  draft: Draft
  /** Text the user typed in the address fields, parsed on send. */
  toText: string
  ccText: string
  bccText: string
  showCc: boolean
  replyTo?: number
}

export interface Notice {
  id: number
  message: string
  kind: 'info' | 'error'
  undo?: () => void | Promise<void>
}

type Overlay = null | 'palette' | 'snooze' | 'settings' | 'sendLater' | 'help' | 'remind'

interface State {
  accounts: Account[]
  splits: Split[]
  settings: Settings | null
  view: View
  threads: ThreadSummary[]
  cursor: number
  open: ThreadDetail | null
  outbox: OutboxItem[]
  compose: ComposeState | null
  overlay: Overlay
  searching: boolean
  notices: Notice[]
  loaded: boolean

  refresh(): Promise<void>
  setView(view: View): void
  move(delta: number): void
  setCursor(i: number): void
  openThread(id?: number): Promise<void>
  closeThread(): void
  act(type: ThreadActionType | 'snooze', until?: number): Promise<void>
  undoLast(): void
  notify(message: string, kind?: 'info' | 'error', undo?: () => void | Promise<void>): void
  dismiss(id: number): void
  setOverlay(o: Overlay): void
  setSearching(on: boolean): void
  startCompose(kind?: 'new' | 'reply' | 'replyAll' | 'forward', base?: Partial<ComposeState>): void
  updateCompose(patch: Partial<ComposeState> | ((c: ComposeState) => Partial<ComposeState>)): void
  send(sendAt?: number, remindAt?: number): Promise<void>
}

let noticeId = 0
let refreshSeq = 0

const DEFAULT_VIEW: View = { kind: 'split', splitId: 'important' }

export const useStore = create<State>((set, get) => ({
  accounts: [],
  splits: [],
  settings: null,
  view: DEFAULT_VIEW,
  threads: [],
  cursor: 0,
  open: null,
  outbox: [],
  compose: null,
  overlay: null,
  searching: false,
  notices: [],
  loaded: false,

  async refresh() {
    const seq = ++refreshSeq
    const { view, open } = get()
    const [accounts, splits, threads, outbox, settings] = await Promise.all([
      api.accountsList(),
      api.splitsList(),
      api.threadsList(view),
      api.outboxList(),
      api.settingsGet(),
    ])
    if (seq !== refreshSeq) return
    // Keep the cursor on the same thread when the list changes underneath it.
    const prev = get().threads[get().cursor]?.id
    let cursor = prev ? threads.findIndex((t) => t.id === prev) : -1
    if (cursor < 0) cursor = Math.min(get().cursor, Math.max(threads.length - 1, 0))
    set({ accounts, splits, threads, outbox, settings, cursor, loaded: true })
    if (open) {
      const fresh = await api.threadsGet(open.id)
      if (seq === refreshSeq && get().open?.id === open.id) set({ open: fresh })
    }
  },

  setView(view) {
    set({ view, cursor: 0, open: null, threads: [] })
    void get().refresh()
  },

  move(delta) {
    const { cursor, threads, open } = get()
    const next = Math.max(0, Math.min(threads.length - 1, cursor + delta))
    set({ cursor: next })
    if (open && threads[next]) void get().openThread(threads[next].id)
  },

  setCursor(i) {
    set({ cursor: i })
  },

  async openThread(id) {
    const target = id ?? get().threads[get().cursor]?.id
    if (!target) return
    const detail = await api.threadsGet(target)
    set({ open: detail })
    if (detail && detail.unreadCount > 0) await api.threadsAction([detail.id], 'read')
  },

  closeThread() {
    set({ open: null })
  },

  async act(type, until) {
    const { threads, cursor, open } = get()
    const target = open ?? threads[cursor]
    if (!target) return
    const removes = type === 'archive' || type === 'trash' || type === 'snooze'
    const label: Record<string, string> = {
      archive: 'Archived',
      trash: 'Moved to trash',
      snooze: 'Snoozed',
      read: 'Marked read',
      unread: 'Marked unread',
      star: 'Starred',
      unstar: 'Unstarred',
    }
    // In thread view, archiving moves straight on to the next conversation.
    const nextId = removes ? (threads[cursor + 1] ?? threads[cursor - 1])?.id : undefined
    const token = type === 'snooze' ? await api.threadsSnooze([target.id], until!) : await api.threadsAction([target.id], type)
    if (removes && open) {
      if (nextId) await get().openThread(nextId)
      else set({ open: null })
    }
    if (type === 'unread' && open) set({ open: null })
    await get().refresh()
    get().notify(label[type], 'info', token ? () => void api.undo(token).then(() => get().refresh()) : undefined)
  },

  undoLast() {
    const n = [...get().notices].reverse().find((x) => x.undo)
    if (!n) return
    void n.undo!()
    get().dismiss(n.id)
  },

  notify(message, kind = 'info', undo) {
    const id = ++noticeId
    set({ notices: [...get().notices.slice(-3), { id, message, kind, undo }] })
    setTimeout(() => get().dismiss(id), undo ? 9000 : kind === 'error' ? 8000 : 3000)
  },

  dismiss(id) {
    set({ notices: get().notices.filter((n) => n.id !== id) })
  },

  setOverlay(overlay) {
    set({ overlay })
  },

  setSearching(searching) {
    set({ searching })
  },

  startCompose(kind = 'new', base) {
    const { accounts, open, threads, cursor } = get()
    const from = accounts[0]
    if (!from) {
      get().notify('Add an account first', 'error')
      return
    }
    if (kind === 'new' || !(open ?? threads[cursor])) {
      set({ compose: { draft: emptyDraft(from.id), toText: '', ccText: '', bccText: '', showCc: false, ...base }, overlay: null })
      return
    }
    const thread = open
    if (!thread) {
      void get().openThread().then(() => get().open && get().startCompose(kind, base))
      return
    }
    const account = accounts.find((a) => a.id === thread.accountId) ?? from
    const last = [...thread.messages].reverse().find((m) => !m.isSent) ?? thread.messages[thread.messages.length - 1]
    const me = account.email.toLowerCase()
    const notMe = (a: Address) => a.address.toLowerCase() !== me
    let to: Address[] = []
    let cc: Address[] = []
    if (kind === 'reply') to = last.isSent ? last.to : [last.from]
    if (kind === 'replyAll') {
      to = (last.isSent ? last.to : [last.from, ...last.to]).filter(notMe)
      cc = last.cc.filter(notMe)
    }
    const stripped = thread.subject.replace(/^((re|fw|fwd):\s*)+/i, '')
    const subject = kind === 'forward' ? `Fwd: ${stripped}` : `Re: ${stripped}`
    const quoted = quote(last)
    const draft: Draft = {
      ...emptyDraft(account.id),
      subject,
      html: kind === 'forward' ? `<p></p>${quoted}` : `<p></p>${quoted}`,
      ...(kind === 'forward' ? {} : { inReplyTo: last.messageId, references: [...last.references, last.messageId] }),
    }
    set({
      compose: {
        draft,
        toText: formatList(dedupe(to)),
        ccText: formatList(dedupe(cc)),
        bccText: '',
        showCc: cc.length > 0,
        replyTo: thread.id,
        ...base,
      },
      overlay: null,
    })
  },

  updateCompose(patch) {
    const c = get().compose
    if (!c) return
    set({ compose: { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } })
  },

  async send(sendAt, remindAt) {
    const c = get().compose
    if (!c) return
    const draft: Draft = {
      ...c.draft,
      to: parseAddresses(c.toText),
      cc: parseAddresses(c.ccText),
      bcc: parseAddresses(c.bccText),
      remindAt,
    }
    const bad = [...draft.to, ...draft.cc, ...draft.bcc].find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.address))
    if (bad) {
      get().notify(`"${bad.address}" is not an email address`, 'error')
      return
    }
    try {
      const item = await api.composeSend(draft, sendAt)
      set({ compose: null, overlay: null })
      const msg = sendAt ? `Scheduled for ${new Date(sendAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Sending'
      get().notify(msg, 'info', async () => {
        const back = await api.outboxCancel(item.id)
        if (back) set({ compose: { ...c, draft: { ...back.draft, remindAt: undefined } } })
        else get().notify('Already sent', 'error')
        void get().refresh()
      })
      void get().refresh()
    } catch (e) {
      get().notify((e as Error).message, 'error')
    }
  },
}))

function emptyDraft(accountId: number): Draft {
  return { accountId, to: [], cc: [], bcc: [], subject: '', html: '', text: '' }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function quote(m: ThreadDetail['messages'][number]) {
  const who = m.from.name || m.from.address
  const when = new Date(m.date).toLocaleString()
  const body = (m.text ?? m.snippet)
    .split('\n')
    .map((l) => `<p>${esc(l) || '<br>'}</p>`)
    .join('')
  return `<p>On ${esc(when)}, ${esc(who)} wrote:</p><blockquote>${body}</blockquote>`
}

function dedupe(list: Address[]) {
  const seen = new Set<string>()
  return list.filter((a) => !seen.has(a.address.toLowerCase()) && seen.add(a.address.toLowerCase()))
}

export function formatList(list: Address[]) {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ')
}

/** Parses "Ann Lee <ann@x.com>, bob@y.com" into addresses. */
export function parseAddresses(text: string): Address[] {
  return text
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(.*)<([^>]+)>$/.exec(p)
      return m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: p }
    })
}
