import { Command } from 'cmdk'
import { useStore } from '../state'

export interface PaletteCommand {
  id: string
  label: string
  keys?: string
  run: () => void
}

export function Palette({ commands }: { commands: PaletteCommand[] }) {
  const { setOverlay } = useStore()
  return (
    <div className="fixed inset-0 z-40 bg-black/40 grid place-items-start justify-center pt-[16vh]" onClick={() => setOverlay(null)}>
      <div onClick={(e) => e.stopPropagation()} data-testid="palette">
        <Command label="Command palette" className="w-[540px] rounded-xl bg-panel border border-line shadow-2xl overflow-hidden" loop>
          <Command.Input autoFocus placeholder="Type a command…" className="w-full bg-transparent px-4 py-3.5 outline-none border-b border-line text-[15px] placeholder:text-faint" />
          <Command.List className="max-h-[360px] overflow-y-auto py-1.5">
            <Command.Empty className="px-4 py-3 text-faint">No matching command</Command.Empty>
            {commands.map((c) => (
              <Command.Item
                key={c.id}
                value={c.label}
                onSelect={() => {
                  setOverlay(null)
                  c.run()
                }}
                className="flex items-center px-4 py-2 cursor-default"
              >
                <span className="flex-1">{c.label}</span>
                {c.keys && <kbd>{c.keys}</kbd>}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
