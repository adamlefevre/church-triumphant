import { useStore } from '../state'

export function SplitTabs() {
  const { splits, view, setView } = useStore()
  const visible = splits.filter((s) => s.count > 0 || s.id === 'important' || s.kind === 'custom')
  return (
    <div className="flex items-center gap-1 px-5 h-11 border-b border-line overflow-x-auto" role="tablist">
      {visible.map((s) => {
        const active = view.kind === 'split' && view.splitId === s.id
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={active}
            onClick={() => setView({ kind: 'split', splitId: s.id })}
            className={`px-2.5 py-1 rounded-md text-[13px] whitespace-nowrap ${active ? 'text-fg bg-raised' : 'text-dim hover:text-fg'}`}
          >
            {s.name}
            {s.unread > 0 && <span className="ml-1.5 text-[11px] text-accent">{s.unread}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Ids of the tabs, in order, for Tab / Shift+Tab. */
export function splitOrder(splits: ReturnType<typeof useStore.getState>['splits']) {
  return splits.filter((s) => s.count > 0 || s.id === 'important' || s.kind === 'custom').map((s) => s.id)
}
