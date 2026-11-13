import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Settings } from '../shared/types'

export type OAuthKind = 'gmail' | 'outlook'

interface Endpoints {
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: string
  clientSecret?: string
  extraAuthParams?: Record<string, string>
}

export function endpoints(kind: OAuthKind, s: Settings): Endpoints {
  if (kind === 'gmail') {
    if (!s.googleClientId) throw new Error('Add your Google OAuth client ID in Settings first (see docs/setup.md)')
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://mail.google.com/', 'openid', 'email', 'profile'],
      clientId: s.googleClientId,
      // Google issues a "secret" for desktop clients; it is not confidential.
      clientSecret: s.googleClientSecret || undefined,
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    }
  }
  if (!s.microsoftClientId) throw new Error('Add your Microsoft application (client) ID in Settings first (see docs/setup.md)')
  return {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'offline_access',
      'openid',
      'email',
      'profile',
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ],
    clientId: s.microsoftClientId,
    extraAuthParams: { prompt: 'select_account' },
  }
}

const b64url = (b: Buffer) => b.toString('base64url')

/**
 * Desktop OAuth: opens the system browser and receives the code on a one-shot
 * localhost listener (RFC 8252), with PKCE.
 */
export async function signIn(
  kind: OAuthKind,
  settings: Settings,
  openExternal: (url: string) => Promise<void>,
  timeoutMs = 5 * 60_000,
): Promise<{ email: string; name: string; refreshToken: string }> {
  const ep = endpoints(kind, settings)
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const redirectUri = kind === 'outlook' ? `http://localhost:${port}` : `http://127.0.0.1:${port}`

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), timeoutMs)
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const ok = !err && url.searchParams.get('state') === state && url.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><title>Sign-in</title><body style="font:16px system-ui;padding:3em">${
            ok ? 'Signed in. You can close this tab and return to the app.' : 'Sign-in failed. Return to the app and try again.'
          }</body>`,
        )
        clearTimeout(timer)
        if (ok) resolve(url.searchParams.get('code')!)
        else reject(new Error(err ? `Sign-in was declined (${err})` : 'Sign-in failed'))
      })
      const auth = new URL(ep.authUrl)
      const params: Record<string, string> = {
        client_id: ep.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: ep.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...ep.extraAuthParams,
      }
      for (const [k, v] of Object.entries(params)) auth.searchParams.set(k, v)
      openExternal(auth.toString()).catch(reject)
    })

    const tokens = await tokenRequest(ep, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    })
    if (!tokens.refresh_token) throw new Error('The provider did not return a refresh token')
    const claims = decodeJwt(tokens.id_token)
    const email = String(claims.email ?? claims.preferred_username ?? '').toLowerCase()
    if (!email) throw new Error('Could not read the account email address')
    return { email, name: String(claims.name ?? email), refreshToken: tokens.refresh_token }
  } finally {
    server.close()
  }
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
}

async function tokenRequest(ep: Endpoints, body: Record<string, string>): Promise<TokenResponse> {
  const form = new URLSearchParams({ client_id: ep.clientId, ...body })
  if (ep.clientSecret) form.set('client_secret', ep.clientSecret)
  if (ep.tokenUrl.includes('microsoftonline')) form.set('scope', ep.scopes.join(' '))
  let res: Response
  try {
    res = await fetch(ep.tokenUrl, { method: 'POST', body: form })
  } catch (e) {
    throw Object.assign(new Error('Offline'), { code: 'OFFLINE', cause: e })
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
  if (!res.ok) {
    const e = new Error(json.error_description || json.error || `Token request failed (${res.status})`)
    // invalid_grant = the user revoked access or the refresh token expired: needs a new sign-in.
    throw Object.assign(e, { code: json.error === 'invalid_grant' ? 'REAUTH' : res.status >= 500 ? 'ETIMEDOUT' : 'OAUTH' })
  }
  return json
}

function decodeJwt(token: string | undefined): Record<string, unknown> {
  if (!token) return {}
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/** Caches an access token and refreshes it a minute before it expires. */
export class TokenSource {
  private token: { value: string; expires: number } | null = null

  constructor(
    private kind: OAuthKind,
    private settings: () => Settings,
    private refreshToken: string,
    /** Microsoft can rotate refresh tokens; persist the new one. */
    private onRotate: (refreshToken: string) => void,
  ) {}

  get = async (): Promise<string> => {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value
    const r = await tokenRequest(endpoints(this.kind, this.settings()), { grant_type: 'refresh_token', refresh_token: this.refreshToken })
    if (r.refresh_token && r.refresh_token !== this.refreshToken) {
      this.refreshToken = r.refresh_token
      this.onRotate(r.refresh_token)
    }
    this.token = { value: r.access_token, expires: Date.now() + r.expires_in * 1000 }
    return this.token.value
  }
}
