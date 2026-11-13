import { useState } from 'react'
import type { AddPasswordAccount, Settings as SettingsT } from '../../../shared/types'
import { api } from '../api'
import { useStore } from '../state'

type Tab = 'accounts' | 'splits' | 'signin' | 'prefs'

export function Settings() {
  const { setOverlay } = useStore()
  const [tab, setTab] = useState<Tab>('accounts')
  const tabs: [Tab, string][] = [
    ['accounts', 'Accounts'],
    ['splits', 'Split inbox'],
    ['signin', 'Sign-in apps'],
    ['prefs', 'Preferences'],
  ]
  return (
    <div className="fixed inset-0 z-40 bg-black/50 grid place-items-center p-6" onClick={() => setOverlay(null)}>
      <div className="w-full max-w-2xl h-[560px] max-h-full rounded-xl bg-panel border border-line shadow-2xl flex" onClick={(e) => e.stopPropagation()} data-testid="settings">
        <div className="w-40 border-r border-line py-4 flex flex-col">
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} className={`text-left px-4 py-1.5 text-[13px] ${tab === id ? 'text-fg bg-raised' : 'text-dim hover:text-fg'}`}>
              {label}
            </button>
          ))}
          <button onClick={() => setOverlay(null)} className="mt-auto text-left px-4 text-[12px] text-faint hover:text-fg">
            Close <kbd>esc</kbd>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 select-text">
          {tab === 'accounts' && <Accounts />}
          {tab === 'splits' && <Splits />}
          {tab === 'signin' && <SignIn />}
          {tab === 'prefs' && <Prefs />}
        </div>
      </div>
    </div>
  )
}

const input = 'w-full bg-raised rounded px-2.5 py-1.5 text-[13px] outline-none border border-transparent focus:border-accent'
const btn = 'px-3 py-1.5 rounded-md border border-line text-[13px] hover:border-accent disabled:opacity-50'
const h2 = 'text-[12px] text-faint uppercase tracking-wide mb-3'

function useRun() {
  const { notify, refresh } = useStore()
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) notify(done)
      await refresh()
      return true
    } catch (e) {
      notify((e as Error).message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

function Accounts() {
  const { accounts } = useStore()
  const { busy, run } = useRun()
  const [form, setForm] = useState<AddPasswordAccount | null>(null)
  const label = { gmail: 'Gmail', outlook: 'Outlook', icloud: 'iCloud', proton: 'Proton Mail', imap: 'IMAP', demo: 'Demo' }
  return (
    <div>
      <div className={h2}>Connected</div>
      {!accounts.length && <div className="text-dim text-[13px] mb-4">No accounts yet.</div>}
      <div className="space-y-2 mb-6">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 text-[13px]">
            <span className="size-2 rounded-full" style={{ background: a.color }} />
            <span className="flex-1 truncate">
              {a.email} <span className="text-faint">· {label[a.provider]}</span>
              {a.error && <div className="text-danger text-[12px]">{a.error}</div>}
            </span>
            <button
              className="text-[12px] text-faint hover:text-danger"
              onClick={() => confirm(`Remove ${a.email}? Its local copy of mail is deleted; nothing changes on the server.`) && run(() => api.accountsRemove(a.id))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className={h2}>Add an account</div>
      <div className="flex flex-wrap gap-2 mb-4">
        <button className={btn} disabled={busy} onClick={() => run(() => api.accountsAddOAuth('gmail'), 'Gmail account added')}>
          Gmail
        </button>
        <button className={btn} disabled={busy} onClick={() => run(() => api.accountsAddOAuth('outlook'), 'Outlook account added')}>
          Outlook
        </button>
        <button className={btn} onClick={() => setForm({ provider: 'icloud', email: '', name: '', password: '' })}>
          iCloud
        </button>
        <button className={btn} onClick={() => setForm({ provider: 'proton', email: '', name: '', password: '' })}>
          Proton Mail
        </button>
        <button className={btn} onClick={() => setForm({ provider: 'imap', email: '', name: '', password: '', imapPort: 993, smtpPort: 465 })}>
          Other IMAP
        </button>
        <button className={btn} disabled={busy} onClick={() => run(() => api.accountsAddDemo(), 'Demo accounts added')} data-testid="add-demo">
          Try demo mail
        </button>
      </div>
      {busy && <div className="text-[12px] text-dim mb-3">Waiting for sign-in in your browser…</div>}
      {form && (
        <form
          className="space-y-2.5 rounded-lg border border-line p-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await run(() => api.accountsAddPassword(form), `${form.email} added`)) setForm(null)
          }}
        >
          <Hint provider={form.provider} />
          <input className={input} placeholder="Email address" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} placeholder="Your name (shown to recipients)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input
            className={input}
            placeholder={form.provider === 'icloud' ? 'App-specific password' : form.provider === 'proton' ? 'Bridge password' : 'Password'}
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          {form.provider === 'imap' && (
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <input className={input} placeholder="IMAP server" required value={form.imapHost ?? ''} onChange={(e) => setForm({ ...form, imapHost: e.target.value })} />
              <input className={input} type="number" value={form.imapPort} onChange={(e) => setForm({ ...form, imapPort: Number(e.target.value) })} />
              <input className={input} placeholder="SMTP server" required value={form.smtpHost ?? ''} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} />
              <input className={input} type="number" value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) })} />
            </div>
          )}
          {form.provider === 'proton' && (
            <div className="grid grid-cols-2 gap-2">
              <input className={input} type="number" placeholder="IMAP port (1143)" value={form.imapPort ?? ''} onChange={(e) => setForm({ ...form, imapPort: Number(e.target.value) || undefined })} />
              <input className={input} type="number" placeholder="SMTP port (1025)" value={form.smtpPort ?? ''} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) || undefined })} />
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button className={`${btn} bg-accent text-black border-accent`} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" className={btn} onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

function Hint({ provider }: { provider: AddPasswordAccount['provider'] }) {
  const text = {
    icloud: 'iCloud needs an app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
    proton: 'Proton Mail works through Proton Mail Bridge (paid plans). Start Bridge, then copy the username and password it shows for this address.',
    imap: 'Any provider with IMAP and SMTP. Ports 993 and 465 use TLS; 143 and 587 use STARTTLS.',
  }[provider]
  return <div className="text-[12px] text-dim">{text}</div>
}

function Splits() {
  const { splits, accounts } = useStore()
  const { run } = useRun()
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [account, setAccount] = useState('')
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
  return (
    <div>
      <div className={h2}>Your splits</div>
      <p className="text-[13px] text-dim mb-3">
        Built in: Important, Calendar, Newsletters and Other (automated mail), plus one per account. A custom split takes its mail out of the built-in ones.
      </p>
      <div className="space-y-1.5 mb-6">
        {splits
          .filter((s) => s.kind === 'custom')
          .map((s) => (
            <div key={s.id} className="flex items-center gap-3 text-[13px]">
              <span className="flex-1">
                {s.name} <span className="text-faint">· {s.count} conversations</span>
              </span>
              <button className="text-[12px] text-faint hover:text-danger" onClick={() => run(() => api.splitsDelete(s.id))}>
                Delete
              </button>
            </div>
          ))}
      </div>
      <div className={h2}>New split</div>
      <form
        className="space-y-2.5"
        onSubmit={async (e) => {
          e.preventDefault()
          const rule = {
            fromContains: list(from).length ? list(from) : undefined,
            subjectContains: list(subject).length ? list(subject) : undefined,
            accountIds: account ? [Number(account)] : undefined,
          }
          if (!rule.fromContains && !rule.subjectContains && !rule.accountIds) return
          if (await run(() => api.splitsSave({ name, rule }), `Split "${name}" created`)) {
            setName('')
            setFrom('')
            setSubject('')
            setAccount('')
          }
        }}
      >
        <input className={input} placeholder="Name, e.g. Team" required value={name} onChange={(e) => setName(e.target.value)} />
        <input className={input} placeholder="Sender contains (comma separated), e.g. @northwind.example, github" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className={input} placeholder="Subject contains (comma separated)" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <select className={input} value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">Any account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
        <button className={btn}>Create split</button>
      </form>
    </div>
  )
}

function SignIn() {
  const { settings } = useStore()
  const { run } = useRun()
  const [s, setS] = useState<Partial<SettingsT>>({})
  if (!settings) return null
  const v = { ...settings, ...s }
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), run(() => api.settingsSet(s), 'Saved'))}>
      <p className="text-[13px] text-dim">
        Gmail and Outlook sign in through your own app registrations, so your mail never passes through anyone else's server. docs/setup.md has the steps (about 10 minutes, once).
      </p>
      <div className={h2}>Google</div>
      <input className={input} placeholder="OAuth client ID" value={v.googleClientId} onChange={(e) => setS({ ...s, googleClientId: e.target.value.trim() })} />
      <input className={input} placeholder="Client secret" value={v.googleClientSecret} onChange={(e) => setS({ ...s, googleClientSecret: e.target.value.trim() })} />
      <div className={h2}>Microsoft</div>
      <input className={input} placeholder="Application (client) ID" value={v.microsoftClientId} onChange={(e) => setS({ ...s, microsoftClientId: e.target.value.trim() })} />
      <button className={btn}>Save</button>
    </form>
  )
}

function Prefs() {
  const { settings } = useStore()
  const { run } = useRun()
  if (!settings) return null
  const set = (patch: Partial<SettingsT>) => run(() => api.settingsSet(patch))
  return (
    <div className="space-y-4 text-[13px]">
      <label className="flex items-center gap-3">
        <span className="flex-1">Undo window for send, archive and trash</span>
        <select className="bg-raised rounded px-2 py-1" value={settings.undoSeconds} onChange={(e) => set({ undoSeconds: Number(e.target.value) })}>
          {[5, 10, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n} seconds
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3">
        <span className="flex-1">Keep mail from the last</span>
        <select className="bg-raised rounded px-2 py-1" value={settings.syncDays} onChange={(e) => set({ syncDays: Number(e.target.value) })}>
          {[30, 90, 180, 365].map((n) => (
            <option key={n} value={n}>
              {n} days
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3">
        <span className="flex-1">
          Load remote images
          <div className="text-[12px] text-faint">Off stops senders from knowing when you open their mail.</div>
        </span>
        <input type="checkbox" checked={settings.loadRemoteImages} onChange={(e) => set({ loadRemoteImages: e.target.checked })} />
      </label>
      <button className={btn} onClick={() => run(() => api.syncNow(), 'Syncing')}>
        Sync now
      </button>
    </div>
  )
}
