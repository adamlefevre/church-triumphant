import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef } from 'react'
import { mod } from '../api'
import { useStore } from '../state'

export function Composer() {
  const { compose, accounts, updateCompose, send, setOverlay } = useStore()
  const toRef = useRef<HTMLInputElement>(null)
  const editor = useEditor({
    extensions: [StarterKit],
    content: compose?.draft.html ?? '',
    onUpdate: ({ editor }) =>
      updateCompose((c) => ({ draft: { ...c.draft, html: editor.getHTML(), text: editor.getText({ blockSeparator: '\n' }) } })),
  })

  // Reset the editor when a different draft is opened (e.g. after undo send).
  const draftKey = compose ? `${compose.replyTo ?? 'new'}:${compose.draft.subject}` : ''
  useEffect(() => {
    if (!compose || !editor) return
    if (editor.getHTML() !== compose.draft.html) editor.commands.setContent(compose.draft.html)
    if (compose.toText) {
      editor.commands.focus('start')
    } else toRef.current?.focus()
    if (!compose.draft.text) updateCompose((c) => ({ draft: { ...c.draft, text: editor.getText({ blockSeparator: '\n' }) } }))
  }, [draftKey, editor])

  if (!compose) return null
  const field = 'w-full bg-transparent outline-none py-1.5 text-[13px] placeholder:text-faint'
  return (
    <div className="fixed inset-0 z-30 bg-black/40 grid place-items-center p-6" data-testid="composer">
      <div className="w-full max-w-2xl rounded-xl bg-panel border border-line shadow-2xl flex flex-col max-h-full">
        <div className="px-5 pt-4 space-y-0.5 border-b border-line pb-2">
          {accounts.length > 1 && (
            <label className="flex items-center gap-3 text-[13px]">
              <span className="w-14 shrink-0 text-faint">From</span>
              <select
                value={compose.draft.accountId}
                onChange={(e) => updateCompose((c) => ({ draft: { ...c.draft, accountId: Number(e.target.value) } }))}
                className="bg-transparent outline-none py-1.5"
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-panel">
                    {a.name} &lt;{a.email}&gt;
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-faint text-[13px]">To</span>
            <input ref={toRef} aria-label="To" className={field} value={compose.toText} onChange={(e) => updateCompose({ toText: e.target.value })} />
            {!compose.showCc && (
              <button className="text-[12px] text-faint hover:text-fg whitespace-nowrap" onClick={() => updateCompose({ showCc: true })}>
                Cc Bcc
              </button>
            )}
          </label>
          {compose.showCc && (
            <>
              <label className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-faint text-[13px]">Cc</span>
                <input aria-label="Cc" className={field} value={compose.ccText} onChange={(e) => updateCompose({ ccText: e.target.value })} />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-faint text-[13px]">Bcc</span>
                <input aria-label="Bcc" className={field} value={compose.bccText} onChange={(e) => updateCompose({ bccText: e.target.value })} />
              </label>
            </>
          )}
          <label className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-faint text-[13px]">Subject</span>
            <input
              aria-label="Subject"
              className={field}
              value={compose.draft.subject}
              onChange={(e) => updateCompose((c) => ({ draft: { ...c.draft, subject: e.target.value } }))}
            />
          </label>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1 min-h-[200px]" onClick={() => editor?.commands.focus()}>
          <EditorContent editor={editor} aria-label="Message body" />
        </div>
        <div className="flex items-center gap-2 px-5 py-3 border-t border-line">
          <button data-testid="send" onClick={() => void send()} className="px-3.5 py-1.5 rounded-md bg-accent text-black font-medium text-[13px]">
            Send <span className="opacity-60 ml-1">{mod}↵</span>
          </button>
          <button onClick={() => setOverlay('sendLater')} className="px-3 py-1.5 rounded-md border border-line text-[13px] text-dim hover:text-fg">
            Send later <span className="opacity-60 ml-1">{mod}⇧L</span>
          </button>
          <button onClick={() => setOverlay('remind')} className="px-3 py-1.5 rounded-md border border-line text-[13px] text-dim hover:text-fg">
            Send + remind <span className="opacity-60 ml-1">{mod}⇧R</span>
          </button>
          <button onClick={() => useStore.setState({ compose: null })} className="ml-auto text-[13px] text-faint hover:text-fg">
            Discard <kbd>esc</kbd>
          </button>
        </div>
      </div>
    </div>
  )
}
