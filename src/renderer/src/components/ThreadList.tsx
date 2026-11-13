import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { formatWhen } from '../time'
import { useStore } from '../state'

const ROW = 52

export function ThreadList() {
  const { threads, cursor, setCursor, openThread, accounts, loaded, view } = useStore()
  const parent = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: threads.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 12 })
  const colors = new Map(accounts.map((a) => [a.id, a.color]))
  const multi = accounts.length > 1

  useEffect(() => {
    if (threads.length) v.scrollToIndex(cursor, { align: 'auto' })
  }, [cursor, threads.length])

  if (loaded && !accounts.length) return <Empty title="No accounts yet" body="Open Settings to add Gmail, Outlook, iCloud or Proton Mail, or try the demo." />
  if (loaded && !threads.length) {
    return view.kind === 'search' ? <Empty title="No results" body="Try fewer words, or from:, to:, subject:, is:unread, has:attachment." /> : <Empty title="All done" body="Nothing left here." />
  }

  return (
    <div ref={parent} className="flex-1 overflow-y-auto" role="listbox" aria-label="Conversations" data-testid="thread-list">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((item) => {
          const t = threads[item.index]
          const active = item.index === cursor
          const unread = t.unreadCount > 0
          return (
            <div
              key={t.id}
              role="option"
              aria-selected={active}
              data-testid="thread-row"
              onClick={() => setCursor(item.index)}
              onDoubleClick={() => void openThread(t.id)}
              className={`absolute inset-x-0 flex items-center gap-3 px-5 cursor-default border-l-2 ${active ? 'bg-raised border-accent' : 'border-transparent hover:bg-panel'}`}
              style={{ height: ROW, transform: `translateY(${item.start}px)` }}
            >
              {multi && <span className="size-1.5 rounded-full shrink-0" style={{ background: colors.get(t.accountId) }} />}
              <span className={`w-44 shrink-0 truncate ${unread ? 'font-semibold text-fg' : 'text-dim'}`}>
                {t.fromName || t.fromAddr}
                {t.messageCount > 1 && <span className="ml-1 text-faint font-normal text-[12px]">{t.messageCount}</span>}
              </span>
              <span className="flex-1 min-w-0 truncate">
                {t.reminded === 2 && <span className="mr-2 text-[11px] text-accent">No reply</span>}
                {t.reminded === 1 && <span className="mr-2 text-[11px] text-accent">Snoozed</span>}
                <span className={unread ? 'font-semibold text-fg' : 'text-fg/90'}>{t.subject || '(no subject)'}</span>
                <span className="text-faint"> · {t.snippet}</span>
              </span>
              {t.starred && <span className="text-accent text-[12px]">★</span>}
              {t.hasAttachments && <span className="text-faint text-[12px]">📎</span>}
              <span className="w-20 shrink-0 text-right text-[12px] text-faint">{formatWhen(t.snoozedUntil ?? t.date)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex-1 grid place-items-center text-center" data-testid="empty">
      <div>
        <div className="text-lg text-fg">{title}</div>
        <div className="text-dim mt-1 max-w-sm">{body}</div>
      </div>
    </div>
  )
}
