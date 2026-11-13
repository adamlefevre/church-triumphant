import { mod } from '../api'
import { useStore } from '../state'

const KEYS: [string, string][] = [
  ['j / k', 'Next / previous conversation'],
  ['enter or o', 'Open conversation'],
  ['esc', 'Back to list'],
  ['e', 'Mark done (archive)'],
  ['#', 'Trash'],
  ['h', 'Snooze'],
  ['z', 'Undo'],
  ['u', 'Mark unread'],
  ['shift+u', 'Mark read'],
  ['s', 'Star / unstar'],
  ['r / a / f', 'Reply / reply all / forward'],
  ['c', 'Compose'],
  ['/', 'Search'],
  ['tab / shift+tab', 'Next / previous split'],
  ['g then i / s / d / h', 'Go to inbox / starred / done / snoozed'],
  [`${mod}+k`, 'Command palette'],
  [`${mod}+enter`, 'Send'],
  [`${mod}+shift+l`, 'Send later'],
  [`${mod}+shift+r`, 'Send and remind if no reply'],
  ['?', 'This list'],
]

export function Help() {
  const { setOverlay } = useStore()
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-center" onClick={() => setOverlay(null)}>
      <div className="w-[460px] rounded-xl bg-panel border border-line shadow-2xl p-5" data-testid="help">
        <div className="text-[12px] text-faint uppercase tracking-wide mb-3">Keyboard shortcuts</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-[13px]">
          {KEYS.map(([k, d]) => (
            <div key={k} className="contents">
              <kbd className="justify-self-start">{k}</kbd>
              <span className="text-dim">{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
