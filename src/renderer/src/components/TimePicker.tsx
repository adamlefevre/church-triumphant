import { useEffect, useState } from 'react'
import { presets } from '../time'

/** A small keyboard-driven list of times: number keys pick a preset, or type a custom date. */
export function TimePicker({ title, onPick, onClose }: { title: string; onPick: (at: number) => void; onClose: () => void }) {
  const list = presets()
  const [custom, setCustom] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const p = list.find((x) => x.key === e.key)
      if (p) {
        e.preventDefault()
        e.stopPropagation()
        onPick(p.at)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-start justify-center pt-[18vh]" onClick={onClose} data-testid="time-picker">
      <div className="w-80 rounded-xl bg-panel border border-line shadow-2xl py-2" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-1.5 text-[12px] text-faint uppercase tracking-wide">{title}</div>
        {list.map((p) => (
          <button key={p.key} onClick={() => onPick(p.at)} className="w-full flex items-center px-4 py-2 hover:bg-raised text-left">
            <span className="flex-1">{p.label}</span>
            <span className="text-[12px] text-faint mr-3">
              {new Date(p.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
            </span>
            <kbd>{p.key}</kbd>
          </button>
        ))}
        <form
          className="px-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            const t = new Date(custom).getTime()
            if (t > Date.now()) onPick(t)
          }}
        >
          <input type="datetime-local" aria-label="Custom time" value={custom} onChange={(e) => setCustom(e.target.value)} className="w-full bg-raised rounded px-2 py-1.5 text-[13px] outline-none [color-scheme:dark]" />
        </form>
      </div>
    </div>
  )
}
