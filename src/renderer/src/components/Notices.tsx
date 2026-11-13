import { useStore } from '../state'

export function Notices() {
  const { notices, dismiss } = useStore()
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2" aria-live="polite">
      {notices.map((n) => (
        <div
          key={n.id}
          data-testid="notice"
          className={`flex items-center gap-3 rounded-lg px-4 py-2 shadow-xl border text-[13px] ${n.kind === 'error' ? 'bg-[#2a1618] border-danger/40 text-danger' : 'bg-raised border-line'}`}
        >
          <span>{n.message}</span>
          {n.undo && (
            <button
              onClick={() => {
                void n.undo!()
                dismiss(n.id)
              }}
              className="text-accent font-medium"
            >
              Undo <kbd>z</kbd>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
