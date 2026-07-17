import { redirect } from 'next/navigation'
import { getAppSlug, getHubUrl } from './config'
import { getHubSession, type HubUser } from './hub-session'

export type AccessResult =
  | { status: 'authorized'; user: HubUser }
  | { status: 'unauthenticated' }
  | { status: 'forbidden'; user: HubUser }
  | { status: 'error'; code: number }

// Non-redirecting access check. Use this in API routes (return 401/403) and in
// dual-auth apps that fall through to another login. Never throws for a normal
// deny — only surfaces an 'error' status when the Hub itself is unreachable/5xx.
export async function checkAppAccess(): Promise<AccessResult> {
  const hubUrl = getHubUrl()
  const appSlug = getAppSlug()

  const hubUser = await getHubSession()
  if (!hubUser) return { status: 'unauthenticated' }

  const response = await fetch(`${hubUrl}/api/access?app=${encodeURIComponent(appSlug)}`, {
    headers: { Authorization: `Bearer ${hubUser.accessToken}` },
    cache: 'no-store',
  })

  if (response.status === 401) return { status: 'unauthenticated' }
  if (!response.ok) return { status: 'error', code: response.status }

  const verdict = (await response.json()) as { ok: boolean; allowed?: boolean }
  if (!verdict.ok || verdict.allowed !== true) return { status: 'forbidden', user: hubUser }

  return { status: 'authorized', user: hubUser }
}

// Redirect wrapper for protected Server Components / pages:
//
//   export const dynamic = 'force-dynamic'   // until v0.2.0's cookies()-first fix ships everywhere
//   const hubUser = await requireAppAccess()
//
// - No Hub session -> Hub login   - Grant missing -> Hub "Request access"
// - Hub unreachable/5xx -> throw (child error boundary shows it)
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
    case 'forbidden':
      redirect(`${hubUrl}/request?app=${encodeURIComponent(appSlug)}`)
    case 'error':
      throw new Error(`@holy/auth: access check for "${appSlug}" failed (${result.code})`)
  }
}
