import { useState } from 'react'
import { api } from '../api'
import { useStore } from '../state'
import { formatFull, formatWhen } from '../time'
import { MessageBody } from './MessageBody'

export function ThreadView() {
  const { open, accounts, settings, notify } = useStore()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  if (!open) return null
  const account = accounts.find((a) => a.id === open.accountId)
  const lastId = open.messages[open.messages.length - 1]?.id
  return (
    <div className="flex-1 overflow-y-auto" data-testid="thread-view">
      <div className="max-w-3xl mx-auto px-8 py-6">
        <div className="flex items-start gap-3 mb-5">
          <h1 className="text-xl font-semibold flex-1 selectable">{open.subject || '(no subject)'}</h1>
          {account && (
            <span className="text-[12px] text-dim flex items-center gap-1.5 pt-1.5">
              <span className="size-2 rounded-full" style={{ background: account.color }} />
              {account.email}
            </span>
          )}
        </div>
        {open.snoozedUntil && <Banner>Snoozed until {formatFull(open.snoozedUntil)}</Banner>}
        {open.reminderAt && <Banner>Reminder {formatFull(open.reminderAt)} if nobody replies</Banner>}
        <div className="space-y-3">
          {open.messages.map((m) => {
            const isOpen = m.id === lastId || !m.seen || expanded.has(m.id)
            return (
              <article key={m.id} className="rounded-lg border border-line bg-panel" data-testid="message">
                <header
                  className="flex items-center gap-3 px-4 py-3 cursor-default"
                  onClick={() => setExpanded((s) => new Set(s.has(m.id) ? [...s].filter((x) => x !== m.id) : [...s, m.id]))}
                >
                  <span className="font-semibold">{m.isSent ? 'Me' : m.from.name || m.from.address}</span>
                  {isOpen ? (
                    <span className="text-[12px] text-faint truncate selectable">
                      {m.from.address} to {[...m.to, ...m.cc].map((a) => a.name || a.address).join(', ')}
                    </span>
                  ) : (
                    <span className="text-faint truncate flex-1">{m.snippet}</span>
                  )}
                  <span className="ml-auto text-[12px] text-faint shrink-0" title={formatFull(m.date)}>
                    {formatWhen(m.date)}
                  </span>
                </header>
                {isOpen && (
                  <div className="px-4 pb-4 selectable">
                    {m.bodyState === 'missing' ? (
                      <div className="text-faint">Couldn't load this message. It will load when you're back online.</div>
                    ) : (
                      <MessageBody html={m.html} text={m.text} remoteImages={!!settings?.loadRemoteImages} />
                    )}
                    {m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-3">
                        {m.attachments.map((a) => (
                          <button
                            key={a.index}
                            onClick={() => api.attachmentOpen(m.id, a.index).catch((e) => notify((e as Error).message, 'error'))}
                            className="text-[12px] px-2.5 py-1 rounded border border-line hover:border-accent"
                          >
                            {a.filename} <span className="text-faint">{Math.ceil(a.size / 1024)} KB</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
        <div className="text-[12px] text-faint mt-5 flex gap-4">
          <span><kbd>r</kbd> reply</span>
          <span><kbd>a</kbd> reply all</span>
          <span><kbd>f</kbd> forward</span>
          <span><kbd>e</kbd> done</span>
          <span><kbd>h</kbd> snooze</span>
          <span><kbd>esc</kbd> back</span>
        </div>
      </div>
    </div>
  )
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-[13px] text-accent">{children}</div>
}
