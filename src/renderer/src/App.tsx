import { useEffect, useRef, useState } from 'react'
import { api, mod, onCore } from './api'
import { Composer } from './components/Composer'
import { Help } from './components/Help'
import { Notices } from './components/Notices'
import { Palette, type PaletteCommand } from './components/Palette'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { SplitTabs, splitOrder } from './components/SplitTabs'
import { ThreadList } from './components/ThreadList'
import { ThreadView } from './components/ThreadView'
import { TimePicker } from './components/TimePicker'
import { useStore } from './state'

export function App() {
  const s = useStore()
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void s.refresh()
    const off1 = onCore('changed', () => void useStore.getState().refresh())
    const off2 = onCore('toast', (t) => useStore.getState().notify(t.message, t.kind))
    return () => {
      off1()
      off2()
    }
  }, [])

  // Open settings on first run so there is an obvious next step.
  useEffect(() => {
    if (s.loaded && !s.accounts.length) s.setOverlay('settings')
  }, [s.loaded])

  const commands: PaletteCommand[] = [
    { id: 'compose', label: 'Compose', keys: 'c', run: () => s.startCompose('new') },
    { id: 'search', label: 'Search', keys: '/', run: () => startSearch() },
    { id: 'done', label: 'Mark done', keys: 'e', run: () => void s.act('archive') },
    { id: 'trash', label: 'Trash', keys: '#', run: () => void s.act('trash') },
    { id: 'snooze', label: 'Snooze', keys: 'h', run: () => s.setOverlay('snooze') },
    { id: 'remind', label: 'Remind me about this conversation', run: () => s.setOverlay('remind') },
    { id: 'star', label: 'Star / unstar', keys: 's', run: () => toggleStar() },
    { id: 'unread', label: 'Mark unread', keys: 'u', run: () => void s.act('unread') },
    { id: 'read', label: 'Mark read', keys: '⇧U', run: () => void s.act('read') },
    { id: 'reply', label: 'Reply', keys: 'r', run: () => s.startCompose('reply') },
    { id: 'replyAll', label: 'Reply all', keys: 'a', run: () => s.startCompose('replyAll') },
    { id: 'forward', label: 'Forward', keys: 'f', run: () => s.startCompose('forward') },
    { id: 'inbox', label: 'Go to Important', keys: 'g i', run: () => s.setView({ kind: 'split', splitId: 'important' }) },
    { id: 'all', label: 'Go to All inbox', run: () => s.setView({ kind: 'folder', name: 'all' }) },
    { id: 'starred', label: 'Go to Starred', keys: 'g s', run: () => s.setView({ kind: 'folder', name: 'starred' }) },
    { id: 'snoozed', label: 'Go to Snoozed', keys: 'g h', run: () => s.setView({ kind: 'folder', name: 'snoozed' }) },
    { id: 'reminders', label: 'Go to Reminders', run: () => s.setView({ kind: 'folder', name: 'reminders' }) },
    { id: 'sent', label: 'Go to Sent', run: () => s.setView({ kind: 'folder', name: 'sent' }) },
    { id: 'archive', label: 'Go to Done', keys: 'g d', run: () => s.setView({ kind: 'folder', name: 'archive' }) },
    ...s.splits.map((sp) => ({ id: `split-${sp.id}`, label: `Go to split: ${sp.name}`, run: () => s.setView({ kind: 'split', splitId: sp.id }) })),
    { id: 'sync', label: 'Sync now', run: () => void api.syncNow() },
    { id: 'settings', label: 'Settings and accounts', run: () => s.setOverlay('settings') },
    { id: 'help', label: 'Keyboard shortcuts', keys: '?', run: () => s.setOverlay('help') },
  ]

  function toggleStar() {
    const st = useStore.getState()
    const t = st.open ?? st.threads[st.cursor]
    if (t) void st.act(t.starred ? 'unstar' : 'star')
  }

  function startSearch() {
    s.setSearching(true)
    setTimeout(() => searchRef.current?.select(), 0)
  }

  // Global keyboard map. Single keys work only when no text field has focus.
  useEffect(() => {
    let pendingG = 0
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const target = e.target as HTMLElement
      const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      const cmd = e.metaKey || e.ctrlKey
      const key = e.key

      if (cmd && key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setOverlay(st.overlay === 'palette' ? null : 'palette')
        return
      }
      if (st.compose) {
        if (cmd && key === 'Enter') {
          e.preventDefault()
          void st.send()
        } else if (cmd && e.shiftKey && key.toLowerCase() === 'l') {
          e.preventDefault()
          st.setOverlay('sendLater')
        } else if (cmd && e.shiftKey && key.toLowerCase() === 'r') {
          e.preventDefault()
          st.setOverlay('remind')
        } else if (key === 'Escape') {
          e.preventDefault()
          if (st.overlay) st.setOverlay(null)
          else useStore.setState({ compose: null })
        }
        return
      }
      if (st.overlay) {
        if (key === 'Escape') {
          e.preventDefault()
          st.setOverlay(null)
        }
        return
      }
      if (typing) return
      if (cmd || e.altKey) return

      const now = Date.now()
      if (pendingG && now - pendingG < 1200) {
        pendingG = 0
        const go = { i: 'important', s: 'starred', d: 'archive', h: 'snoozed', t: 'sent' }[key]
        if (go) {
          e.preventDefault()
          s.setView(go === 'important' ? { kind: 'split', splitId: 'important' } : { kind: 'folder', name: go as 'starred' })
        }
        return
      }

      const run = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      switch (key) {
        case 'j':
        case 'ArrowDown':
          return run(() => st.move(1))
        case 'k':
        case 'ArrowUp':
          return run(() => st.move(-1))
        case 'Enter':
        case 'o':
          return run(() => void st.openThread())
        case 'Escape':
          return run(() => {
            if (st.open) st.closeThread()
            else if (st.view.kind === 'search') {
              setQuery('')
              st.setSearching(false)
              st.setView({ kind: 'split', splitId: 'important' })
            }
          })
        case 'e':
        case 'y':
          return run(() => void st.act('archive'))
        case '#':
        case 'Delete':
          return run(() => void st.act('trash'))
        case 'h':
          return run(() => st.setOverlay('snooze'))
        case 'z':
          return run(() => st.undoLast())
        case 'u':
          return run(() => void st.act('unread'))
        case 'U':
          return run(() => void st.act('read'))
        case 's':
          return run(toggleStar)
        case 'r':
          return run(() => st.startCompose('reply'))
        case 'a':
          return run(() => st.startCompose('replyAll'))
        case 'f':
          return run(() => st.startCompose('forward'))
        case 'c':
          return run(() => st.startCompose('new'))
        case '/':
          return run(startSearch)
        case '?':
          return run(() => st.setOverlay('help'))
        case 'g':
          pendingG = now
          return
        case 'Tab':
          return run(() => {
            const order = splitOrder(st.splits)
            const cur = st.view.kind === 'split' ? order.indexOf(st.view.splitId) : -1
            const next = order[(cur + (e.shiftKey ? -1 : 1) + order.length) % order.length]
            if (next) st.setView({ kind: 'split', splitId: next })
          })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const target = s.open ?? s.threads[s.cursor]

  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        {s.searching || s.view.kind === 'search' ? (
          <form
            className="flex items-center gap-3 px-5 h-11 border-b border-line"
            onSubmit={(e) => {
              e.preventDefault()
              if (query.trim()) s.setView({ kind: 'search', query: query.trim() })
              searchRef.current?.blur()
            }}
          >
            <span className="text-faint">⌕</span>
            <input
              ref={searchRef}
              autoFocus
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setQuery('')
                  s.setSearching(false)
                  if (s.view.kind === 'search') s.setView({ kind: 'split', splitId: 'important' })
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              placeholder="Search all accounts · from: to: subject: is:unread has:attachment"
              className="flex-1 bg-transparent outline-none placeholder:text-faint"
            />
            <kbd>esc</kbd>
          </form>
        ) : (
          <SplitTabs />
        )}
        {s.open ? <ThreadView /> : <ThreadList />}
        <footer className="h-8 shrink-0 border-t border-line flex items-center gap-4 px-5 text-[11px] text-faint">
          <span><kbd>{mod}K</kbd> commands</span>
          <span><kbd>c</kbd> compose</span>
          <span><kbd>/</kbd> search</span>
          <span><kbd>?</kbd> shortcuts</span>
        </footer>
      </main>

      {s.compose && <Composer />}
      {s.overlay === 'palette' && <Palette commands={commands} />}
      {s.overlay === 'help' && <Help />}
      {s.overlay === 'settings' && <Settings />}
      {s.overlay === 'snooze' && target && (
        <TimePicker
          title="Snooze until"
          onClose={() => s.setOverlay(null)}
          onPick={(at) => {
            s.setOverlay(null)
            void s.act('snooze', at)
          }}
        />
      )}
      {s.overlay === 'sendLater' && s.compose && (
        <TimePicker
          title="Send at"
          onClose={() => s.setOverlay(null)}
          onPick={(at) => void s.send(at)}
        />
      )}
      {s.overlay === 'remind' && (
        <TimePicker
          title={s.compose ? 'Send now, remind me if no reply by' : 'Remind me if no reply by'}
          onClose={() => s.setOverlay(null)}
          onPick={async (at) => {
            if (s.compose) return void s.send(undefined, at)
            s.setOverlay(null)
            if (!target) return
            await api.remindersSet(target.id, at, true)
            s.notify('Reminder set')
          }}
        />
      )}
      <Notices />
    </div>
  )
}
