import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isTransientAuthError } from './auth-error'
import { getHubMeta } from './config'
import {
  CHILD_COOKIE_NAME,
  childCookieOptions,
  hasChildSessionCookie,
  isChildSessionCookie,
  SESSION_STATE_HEADER,
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
// Cookie writes are collected and applied once the outcome is known: the
// response is recreated with the mutated request headers (the canonical
// Supabase middleware pattern) so Server Components rendered later in the SAME
// request read the fresh token instead of re-refreshing it.
export async function refreshChildSession(request: NextRequest): Promise<RefreshResult> {
  // Why: a client must not pre-set the refusal marker; only this proxy's own
  // refused renewal may set it (CLA-21).
  const forwardHeaders = (unavailable = false): Headers => {
    const headers = new Headers(request.headers)
    headers.delete(SESSION_STATE_HEADER)
    if (unavailable) headers.set(SESSION_STATE_HEADER, 'unavailable')
    return headers
  }

  let response = NextResponse.next({ request: { headers: forwardHeaders() } })

  const requestCookies = request.cookies.getAll()
  if (!hasChildSessionCookie(requestCookies)) {
    return { outcome: 'absent', response, staleCookies: [] }
  }

  const isSecure = request.nextUrl.protocol === 'https:'
  const meta = await getHubMeta()
  // Why: on a refused refresh auth-js deletes the session through setAll; decide
  // what to write only once the outcome is known (CLA-21). The library reads its
  // own pending writes from memory, so deferring them is safe. Cookies merge by
  // name (last wins); headers merge across calls.
  const pending = {
    cookies: new Map<string, { name: string; value: string; options: CookieOptions }>(),
    headers: {} as Record<string, string>,
  }

  const supabase = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
    cookieOptions: { name: CHILD_COOKIE_NAME, ...childCookieOptions(isSecure) },
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const cookie of cookiesToSet) pending.cookies.set(cookie.name, cookie)
        Object.assign(pending.headers, headers ?? {})
      },
    },
  })

  const applyPending = (): boolean => {
    if (pending.cookies.size === 0) return false
    const cookiesToSet = [...pending.cookies.values()]
    for (const { name, value } of cookiesToSet) {
      request.cookies.set(name, value)
    }
    response = NextResponse.next({ request: { headers: forwardHeaders() } })
    for (const { name, value, options } of cookiesToSet) {
      response.cookies.set(name, value, options)
    }
    // The library hands us the exact no-store headers a refresh response must
    // carry so a CDN never caches one user's Set-Cookie for another.
    for (const [key, value] of Object.entries(pending.headers)) {
      response.headers.set(key, value)
    }
    return true
  }

  const { data, error } = await supabase.auth.getClaims()
  if (data?.claims) {
    return { outcome: applyPending() ? 'refreshed' : 'fresh', response, staleCookies: [] }
  }

  // No claims. Distinguish a transient Hub/network failure from a definitively
  // dead session. Destroying the cookies on a transient blip would log out a
  // valid user (the refresh token is on the hot path of every request), so ONLY
  // clear on a real rejection.
  if (isTransientAuthError(error)) {
    // Why: a renewal the server already committed must reach the browser, or the
    // next renewal reuses a spent token; pure deletions are dropped (CLA-21).
    const carriesNewSession = [...pending.cookies.values()].some((cookie) => cookie.value !== '')
    if (carriesNewSession) {
      // Why: the page now holds the fresh session, so it verifies normally (CLA-21).
      applyPending()
    } else {
      response = NextResponse.next({ request: { headers: forwardHeaders(true) } })
    }
    return { outcome: 'unavailable', response, staleCookies: [] }
  }

  // Definitive: token rejected (4xx) or getSession found nothing (data & error
  // both null). Signal the proxy to expire the cookies on whatever response it
  // returns.
  // Why: a renewal can split the session into new cookie pieces before the check
  // rejects it, and the library only clears names the request carried; so no
  // buffered write is applied and every piece, old or new, is expired (CLA-21).
  const staleCookies = [
    ...new Set([
      ...requestCookies.map((cookie) => cookie.name),
      ...pending.cookies.keys(),
    ]),
  ].filter(isChildSessionCookie)
  for (const name of staleCookies) request.cookies.set(name, '')
  response = NextResponse.next({ request: { headers: forwardHeaders() } })
  expireChildCookies(response, staleCookies, isSecure)
  for (const [key, value] of Object.entries(pending.headers)) {
    response.headers.set(key, value)
  }
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
