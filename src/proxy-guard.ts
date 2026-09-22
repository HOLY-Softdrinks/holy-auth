import { NextResponse, type NextRequest } from 'next/server'
import { getHubMeta, getHubUrl, isChildSessionEnabled } from './config'
import {
  HUB_CALLBACK_PATH,
  handleHubCallback,
  isDevHandoffRequest,
  isProdHandoffEnabled,
  redirectToDevHandoff,
  redirectToHubHandoff,
} from './hub-callback'
import { expireChildCookies, refreshChildSession } from './refresh-session'

// Lightweight route protection for the child's proxy.ts (Next.js 16):
//
//   import { createHubProxyGuard } from '@holy/auth'
//   export const proxy = createHubProxyGuard({ publicPaths: ['/', '/login'] })
//
// The proxy is the ONLY place Next.js lets us write cookies, so it is where the
// child's own Hub session is refreshed (refreshChildSession) and, in
// production, established via a silent handoff. Page-level requireAppAccess()
// still does the authoritative identity + grant check.
export function createHubProxyGuard(options?: { publicPaths?: string[] }) {
  const publicPaths = options?.publicPaths ?? ['/']

  const isPublicPath = (pathname: string) =>
    publicPaths.some((publicPath) =>
      publicPath === '/' ? pathname === '/' : pathname.startsWith(publicPath),
    )

  const loginRedirect = (request: NextRequest): NextResponse =>
    NextResponse.redirect(`${getHubUrl()}/login?next=${encodeURIComponent(request.url)}`)

  const hasPortalCookie = async (request: NextRequest) => {
    const meta = await getHubMeta()
    const projectRef = new URL(meta.supabaseUrl).hostname.split('.')[0]
    return request.cookies
      .getAll()
      .some((cookie) => cookie.name.startsWith(`sb-${projectRef}-auth-token`))
  }

  return async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl
    const isSecure = request.nextUrl.protocol === 'https:'

    if (pathname === HUB_CALLBACK_PATH) {
      return handleHubCallback(request)
    }
    if (pathname.startsWith('/_next') || pathname.includes('.')) {
      return NextResponse.next()
    }

    // Kill switch: behave like the pre-F-001 redirect-only guard — shared-cookie
    // presence, no refresh, no handoff (DECISION-4). Go straight to Portal
    // /login when signed out; NOT the dev handoff, which would write a child
    // cookie this path then ignores and loop forever on localhost.
    if (!isChildSessionEnabled()) {
      if (isPublicPath(pathname)) return NextResponse.next()
      if (await hasPortalCookie(request)) return NextResponse.next()
      return loginRedirect(request)
    }

    // 1. Child session present → refresh it.
    const { outcome, response, staleCookies } = await refreshChildSession(request)
    // Fresh/refreshed ⇒ authenticated. 'unavailable' ⇒ cookie present but Hub
    // unreachable; pass through and let requireAppAccess surface the transient
    // error (never destroy a probably-valid session over a blip).
    if (outcome === 'fresh' || outcome === 'refreshed' || outcome === 'unavailable') {
      return response
    }

    // 'invalid' clears must ride whatever response we ultimately return.
    const finalize = (result: NextResponse): NextResponse => {
      if (outcome === 'invalid') expireChildCookies(result, staleCookies, isSecure)
      return result
    }

    if (isPublicPath(pathname)) return finalize(response)

    // No usable child session on a protected path.
    if (await hasPortalCookie(request)) {
      // 2. Production (opt-in): the user has a Portal session but no child
      //    session yet — silently hand off to mint our own independent session.
      if (isProdHandoffEnabled()) {
        return finalize(redirectToHubHandoff(request))
      }
      // Otherwise keep the shared Portal cookie as the live session; the page's
      // requireAppAccess() verifies it. Unchanged production path until
      // HOLY_AUTH_PROD_HANDOFF is enabled.
      return finalize(response)
    }

    // 3/4. No Portal cookie either → dev/preview handoff, or Portal login.
    if (isDevHandoffRequest(request)) return finalize(redirectToDevHandoff(request))
    return finalize(loginRedirect(request))
  }
}
