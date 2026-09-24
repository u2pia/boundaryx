import { createHash, randomBytes } from 'node:crypto'
import { AppError } from './types.ts'

/**
 * GitHub OAuth App (authorization code + PKCE S256). The only thing the control plane takes from GitHub is who the user
 * is: the access token is used once to read `/user` and then dropped — it is never stored, logged or returned. The
 * client secret stays in the environment and never enters the database.
 */
export type GithubOAuthConfig = {
  clientId: string
  clientSecret: string
  /** https://github.com, or a GitHub Enterprise host. Overridable so tests can stand up a fake. */
  oauthBaseUrl: string
  apiBaseUrl: string
  redirectUri: string
  /** Where the browser lands after the callback. */
  uiUrl: string
}

function trimSlash(value: string) {
  return value.replace(/\/+$/u, '')
}

export function githubOAuthConfigFromEnv(env: NodeJS.ProcessEnv, defaultPublicUrl: string): GithubOAuthConfig | undefined {
  const clientId = env.CONTROL_PLANE_GITHUB_CLIENT_ID?.trim()
  const clientSecret = env.CONTROL_PLANE_GITHUB_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return undefined
  const publicUrl = trimSlash(env.CONTROL_PLANE_PUBLIC_URL?.trim() || defaultPublicUrl)
  return {
    clientId,
    clientSecret,
    oauthBaseUrl: trimSlash(env.CONTROL_PLANE_GITHUB_OAUTH_BASE?.trim() || 'https://github.com'),
    apiBaseUrl: trimSlash(env.CONTROL_PLANE_GITHUB_API_BASE?.trim() || 'https://api.github.com'),
    redirectUri: `${publicUrl}/api/auth/github/callback`,
    uiUrl: trimSlash(env.CONTROL_PLANE_UI_URL?.trim() || publicUrl),
  }
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function githubAuthorizeUrl(config: GithubOAuthConfig, state: string, challenge: string) {
  const url = new URL(`${config.oauthBaseUrl}/login/oauth/authorize`)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  // read:user is the narrowest scope that returns the numeric id; nothing here can touch repositories.
  url.searchParams.set('scope', 'read:user')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('allow_signup', 'false')
  return url.toString()
}

export async function fetchGithubIdentity(config: GithubOAuthConfig, code: string, codeVerifier: string): Promise<{ subject: string; login: string }> {
  if (!code) throw new AppError(400, 'OAuth code is missing', 'github_code_missing')
  let exchange: Response
  try {
    exchange = await fetch(`${config.oauthBaseUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new AppError(502, 'Could not reach GitHub to exchange the OAuth code', 'github_unreachable')
  }
  const token = await exchange.json().catch(() => ({})) as { access_token?: unknown; error?: unknown }
  // Only GitHub's error code is surfaced; the response body may echo request details.
  if (!exchange.ok || typeof token.access_token !== 'string') throw new AppError(502, `GitHub rejected the OAuth code${typeof token.error === 'string' ? ` (${token.error})` : ''}`, 'github_exchange_failed')
  let user: Response
  try {
    user = await fetch(`${config.apiBaseUrl}/user`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'aperture-control-plane', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new AppError(502, 'Could not reach GitHub to read the signed-in user', 'github_unreachable')
  }
  const profile = await user.json().catch(() => ({})) as { id?: unknown; login?: unknown }
  if (!user.ok || (typeof profile.id !== 'number' && typeof profile.id !== 'string') || typeof profile.login !== 'string') throw new AppError(502, 'GitHub did not return a user identity', 'github_user_unavailable')
  return { subject: String(profile.id), login: profile.login }
}
