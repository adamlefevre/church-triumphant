import type { FolderView, View } from '../../../shared/types'
import { useStore } from '../state'

const FOLDERS: { name: FolderView; label: string }[] = [
  { name: 'all', label: 'All inbox' },
  { name: 'starred', label: 'Starred' },
  { name: 'snoozed', label: 'Snoozed' },
  { name: 'reminders', label: 'Reminders' },
  { name: 'sent', label: 'Sent' },
  { name: 'archive', label: 'Done' },
]

export function same(a: View, b: View) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'split' && b.kind === 'split') return a.splitId === b.splitId
  if (a.kind === 'folder' && b.kind === 'folder') return a.name === b.name
  return a.kind === 'search'
}

export function Sidebar() {
  const { accounts, view, setView, outbox, setOverlay } = useStore()
  const pending = outbox.filter((o) => o.state !== 'failed').length
  const failed = outbox.filter((o) => o.state === 'failed').length
  return (
    <nav className="w-52 shrink-0 border-r border-line bg-panel flex flex-col py-3" aria-label="Folders">
      <div className="px-4 pb-3 text-[13px] font-semibold tracking-wide text-dim">Church Triumphant</div>
      {FOLDERS.map((f) => {
        const v: View = { kind: 'folder', name: f.name }
        return (
          <button
            key={f.name}
            onClick={() => setView(v)}
            className={`text-left px-4 py-1.5 text-[13px] ${same(view, v) ? 'text-fg bg-raised' : 'text-dim hover:text-fg'}`}
          >
            {f.label}
          </button>
        )
      })}
      {(pending > 0 || failed > 0) && (
        <div className="px-4 pt-3 text-[12px] text-faint">
          {pending > 0 && <div>{pending} waiting to send</div>}
          {failed > 0 && <div className="text-danger">{failed} failed to send</div>}
        </div>
      )}
      <div className="mt-auto px-4 pt-4 space-y-1.5">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-2 text-[12px] text-dim" title={a.error ?? a.email}>
            <span className="size-2 rounded-full shrink-0" style={{ background: a.color }} />
            <span className="truncate">{a.email}</span>
            {a.state === 'syncing' && <span className="text-faint">…</span>}
            {a.state === 'error' && <span className="text-danger">!</span>}
          </div>
        ))}
        <button onClick={() => setOverlay('settings')} className="text-[12px] text-faint hover:text-fg pt-2">
          Settings and accounts
        </button>
      </div>
    </nav>
  )
}
