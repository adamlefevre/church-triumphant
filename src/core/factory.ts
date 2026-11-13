import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderFactory } from './core'
import { TokenSource } from './oauth'
import { FakeMailbox, FakeProvider } from './providers/fake'
import { ImapProvider } from './providers/imap'
import { profileFor } from './providers/profiles'

/** Builds the provider for an account. Demo mailboxes are saved to `dataDir` so they survive restarts. */
export function providerFactory(dataDir: string, demoBoxes: Map<number, FakeMailbox>): ProviderFactory {
  return async (account, secret, core) => {
    if (account.provider === 'demo') return new FakeProvider(demoMailbox(dataDir, account.id, demoBoxes), { withBodies: true })
    const profile = profileFor(account.provider, account.config)
    if (profile.auth === 'oauth') {
      if (!secret.refreshToken) throw new Error('Sign in again to reconnect this account')
      const kind = account.provider as 'gmail' | 'outlook'
      const tokens = new TokenSource(kind, () => core.settingsGet(), secret.refreshToken, (rt) => {
        void core.updateSecret(account.id, { refreshToken: rt })
      })
      return new ImapProvider(profile, { user: account.email, accessToken: tokens.get })
    }
    return new ImapProvider(profile, { user: account.email, password: secret.password })
  }
}

export function demoMailbox(dataDir: string, accountId: number, cache: Map<number, FakeMailbox>): FakeMailbox {
  let box = cache.get(accountId)
  if (box) return box
  const file = join(dataDir, `demo-${accountId}.json`)
  box = existsSync(file) ? new FakeMailbox(JSON.parse(readFileSync(file, 'utf8'))) : new FakeMailbox()
  let timer: ReturnType<typeof setTimeout> | null = null
  box.onMutate = () => {
    timer ??= setTimeout(() => {
      timer = null
      writeFileSync(file, JSON.stringify(box))
    }, 200)
  }
  cache.set(accountId, box)
  return box
}
