import { redirect } from 'next/navigation'
import { getAppSlug, getHubUrl } from './config'
import { getHubSessionResult, type HubUser } from './hub-session'

export type AccessResult =
  | { status: 'authorized'; user: HubUser }
  | { status: 'unauthenticated' }
  | { status: 'stale' }
  | { status: 'forbidden'; user: HubUser }
  | { status: 'error'; code: number }

// Non-redirecting access check. Use this in API routes (return 401/403) and in
// dual-auth apps that fall through to another login. Never throws for a normal
// deny — only surfaces an 'error' status when the Hub itself is unreachable/5xx.
//
// 'stale' means a session cookie is present but the Hub couldn't verify it
// right now due to a transient error (not a rejection). API routes should treat
// this as retryable (e.g. 503), NOT as a logout — the user is probably still
// signed in and the proxy will refresh on the next navigation.
export async function checkAppAccess(): Promise<AccessResult> {
  const hubUrl = getHubUrl()
  const appSlug = getAppSlug()

  const session = await getHubSessionResult()
  if (session.status === 'none') return { status: 'unauthenticated' }
  if (session.status === 'stale') {
    // Transient (Hub blip): retryable, don't treat as a logout. Non-transient
    // (token rejected): a genuine re-auth.
    return session.transient ? { status: 'stale' } : { status: 'unauthenticated' }
  }
  const hubUser = session.user

  try {
    const response = await fetch(`${hubUrl}/api/access?app=${encodeURIComponent(appSlug)}`, {
      headers: { Authorization: `Bearer ${hubUser.accessToken}` },
      cache: 'no-store',
    })

    if (response.status === 401) return { status: 'unauthenticated' }
    if (!response.ok) return { status: 'error', code: response.status }

    const verdict = (await response.json()) as { ok: boolean; allowed?: boolean }
    if (!verdict.ok || verdict.allowed !== true) return { status: 'forbidden', user: hubUser }

    return { status: 'authorized', user: hubUser }
  } catch {
    // Network failure reaching the Hub (DNS, ECONNREFUSED, timeout) or a
    // malformed body. Honour the contract — never throw for a deny — and report
    // it as a retryable error.
    return { status: 'error', code: 503 }
  }
}

// Redirect wrapper for protected Server Components / pages:
//
//   export const dynamic = 'force-dynamic'   // until v0.2.0's cookies()-first fix ships everywhere
//   const hubUser = await requireAppAccess()
//
// - No Hub session -> Hub login   - Grant missing -> Hub "Request access"
// - Hub unreachable/5xx or transient verify failure -> throw (child error
//   boundary shows it, and the user retries) rather than a spurious login bounce
export async function requireAppAccess(options?: { returnTo?: string }): Promise<HubUser> {
  const hubUrl = getHubUrl()
  const appSlug = getAppSlug()
  const nextParam = options?.returnTo ? `?next=${encodeURIComponent(options.returnTo)}` : ''

  const result = await checkAppAccess()
  switch (result.status) {
    case 'authorized':
      return result.user
    case 'unauthenticated':
      redirect(`${hubUrl}/login${nextParam}`)
    case 'stale':
      // Session present, transiently unverifiable. Redirecting to login would
      // log out a still-valid user over a momentary Hub blip; surface it to the
      // error boundary instead, same as a Hub outage.
      throw new Error(`@holy/auth: Hub session for "${appSlug}" could not be verified (transient)`)
    case 'forbidden':
      redirect(`${hubUrl}/request?app=${encodeURIComponent(appSlug)}`)
    case 'error':
      throw new Error(`@holy/auth: access check for "${appSlug}" failed (${result.code})`)
  }
}
