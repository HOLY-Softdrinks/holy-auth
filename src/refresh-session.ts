import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isTransientAuthError } from './auth-error'
import { getHubMeta } from './config'
import {
  CHILD_COOKIE_NAME,
  childCookieOptions,
  hasChildSessionCookie,
  isChildSessionCookie,
} from './session-cookie'

// Outcome of a child-session refresh attempt:
// - 'absent'      no child session cookie on the request (bootstrap / handoff needed)
// - 'fresh'       valid session, access token still good — nothing written
// - 'refreshed'   access token was stale; a new one was minted and written back
// - 'unavailable' child cookie present, but the Hub couldn't be reached to verify
//                 it (transient blip). Session is probably fine — do NOT destroy it.
// - 'invalid'     child cookie present but DEFINITIVELY dead (refresh token
//                 rejected/expired). The cookies should be cleared.
export type RefreshOutcome = 'absent' | 'fresh' | 'refreshed' | 'unavailable' | 'invalid'

export type RefreshResult = {
  outcome: RefreshOutcome
  response: NextResponse
  // Child cookie names to expire when outcome === 'invalid'. The proxy applies
  // these to whichever response it ultimately returns (a redirect discards the
  // response we wrote them on), so a dead cookie doesn't linger and re-trigger.
  staleCookies: string[]
}

// Refresh the child app's OWN Hub session, in the one place Next.js allows
// cookie writes: the proxy (middleware). Server Components cannot write cookies,
// so if this does not run the session can never rotate — which is the whole bug
// this package had. See DECISION-2 in the feature doc.
//
// Because the child session is an independent refresh-token family
// (CHILD_COOKIE_NAME, host-only), rotating it here never touches the Portal's
// shared token: no cross-app reuse-detection collision.
//
// On a write, the response is recreated with the mutated request headers (the
// canonical Supabase middleware pattern) so Server Components rendered later in
// the SAME request read the fresh token instead of re-refreshing it.
export async function refreshChildSession(request: NextRequest): Promise<RefreshResult> {
  let response = NextResponse.next({ request: { headers: request.headers } })

  const requestCookies = request.cookies.getAll()
  if (!hasChildSessionCookie(requestCookies)) {
    return { outcome: 'absent', response, staleCookies: [] }
  }

  const isSecure = request.nextUrl.protocol === 'https:'
  const meta = await getHubMeta()
  let wroteCookies = false

  const supabase = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
    cookieOptions: { name: CHILD_COOKIE_NAME, ...childCookieOptions(isSecure) },
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        wroteCookies = true
        // Update the REQUEST cookies, then rebuild the response from the
        // mutated request headers, so downstream Server Components see the
        // fresh token and don't each re-refresh it.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        response = NextResponse.next({ request: { headers: request.headers } })
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
        // The library hands us the exact no-store headers a refresh response
        // must carry so a CDN never caches one user's Set-Cookie for another.
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value)
        }
      },
    },
  })

  const { data, error } = await supabase.auth.getClaims()
  if (data?.claims) {
    return { outcome: wroteCookies ? 'refreshed' : 'fresh', response, staleCookies: [] }
  }

  // No claims. Distinguish a transient Hub/network failure from a definitively
  // dead session. Destroying the cookies on a transient blip would log out a
  // valid user (the refresh token is on the hot path of every request), so ONLY
  // clear on a real rejection.
  if (isTransientAuthError(error)) {
    return { outcome: 'unavailable', response, staleCookies: [] }
  }

  // Definitive: token rejected (4xx) or getSession found nothing (data & error
  // both null). Signal the cookies to clear.
  const staleCookies = requestCookies
    .filter((cookie) => isChildSessionCookie(cookie.name))
    .map((cookie) => cookie.name)
  return { outcome: 'invalid', response, staleCookies }
}

// Expire the given child cookie names on a response. Used by the proxy to carry
// an 'invalid' clear onto the redirect it actually returns.
export function expireChildCookies(
  response: NextResponse,
  names: string[],
  isSecure: boolean,
): void {
  const options = { ...childCookieOptions(isSecure), maxAge: 0 }
  for (const name of names) {
    response.cookies.set(name, '', options)
  }
}
