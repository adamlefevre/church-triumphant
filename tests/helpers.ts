import { Core, type Host } from '../src/core/core'
import { FakeMailbox, FakeProvider } from '../src/core/providers/fake'
import type { CoreEvents, Toast } from '../src/shared/types'

export const host: Host = {
  encrypt: async (s) => `enc:${s}`,
  decrypt: async (s) => s.slice(4),
  openExternal: async () => {},
  openFile: async (name) => `/tmp/${name}`,
}

export const T0 = Date.UTC(2026, 10, 13, 12, 0, 0)
export const MIN = 60_000
export const DAY = 86_400_000

/** A core wired to in-memory mailboxes with a clock the test controls. */
export async function harness(emails = ['me@example.test']) {
  const clock = { now: T0 }
  const boxes = new Map<string, FakeMailbox>()
  const providers = new Map<string, FakeProvider>()
  const toasts: Toast[] = []
  for (const e of emails) {
    boxes.set(e, new FakeMailbox())
    providers.set(e, new FakeProvider(boxes.get(e)!))
  }
  const core = new Core({
    dbPath: ':memory:',
    host,
    now: () => clock.now,
    createProvider: async (account) => providers.get(account.email)!,
    emit: (event: keyof CoreEvents, payload: unknown) => {
      if (event === 'toast') toasts.push(payload as Toast)
    },
  })
  const accounts = []
  for (const e of emails) accounts.push(await core.addAccountRecord('demo', e, e.split('@')[0]))
  const sync = async () => {
    core.syncNow()
    await core.idle()
  }
  /** Advances the clock, runs the scheduler, and waits for the resulting work. */
  const advance = async (ms: number) => {
    clock.now += ms
    core.tick()
    await core.idle()
    await core.idle()
  }
  const box = boxes.get(emails[0])!
  const provider = providers.get(emails[0])!
  return { core, clock, boxes, providers, box, provider, accounts, account: accounts[0], sync, advance, toasts }
}

export const ann = { name: 'Ann Lee', address: 'ann@example.test' }
export const bob = { name: 'Bob Ray', address: 'bob@example.test' }
export const inboxView = { kind: 'folder', name: 'all' } as const
