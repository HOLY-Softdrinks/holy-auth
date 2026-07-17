import { redirect } from 'next/navigation'
import { getAppSlug, getHubUrl } from './config'
import { getHubSession, type HubUser } from './hub-session'

// The whole child-side auth story in one call. Use at the top of every
// protected Server Component / page:
//
//   const hubUser = await requireAppAccess()
//
// - No Hub session      -> redirect to the Hub login
// - Grant missing       -> redirect to the Hub "Request access" screen
// - Hub unreachable/4xx -> throw (child error boundary shows it)
export async function requireAppAccess(): Promise<HubUser> {
  const hubUrl = getHubUrl()
  const appSlug = getAppSlug()

  const hubUser = await getHubSession()
  if (!hubUser) redirect(`${hubUrl}/login`)

  const response = await fetch(`${hubUrl}/api/access?app=${encodeURIComponent(appSlug)}`, {
    headers: { Authorization: `Bearer ${hubUser.accessToken}` },
    cache: 'no-store',
  })

  if (response.status === 401) redirect(`${hubUrl}/login`)
  if (!response.ok) {
    throw new Error(`@holy/auth: access check for "${appSlug}" failed (${response.status})`)
  }

  const verdict = (await response.json()) as { ok: boolean; allowed?: boolean }
  if (!verdict.ok || verdict.allowed !== true) {
    redirect(`${hubUrl}/request?app=${encodeURIComponent(appSlug)}`)
  }

  return hubUser
}
