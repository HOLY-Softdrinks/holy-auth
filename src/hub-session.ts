import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { isTransientAuthError } from './auth-error'
import { getHubMeta, isChildSessionEnabled, type HubMeta } from './config'
import { isProdHandoffEnabled } from './hub-callback'
import { CHILD_COOKIE_NAME, hasChildSessionCookie } from './session-cookie'

export type HubUser = {
  id: string
  email: string | null
  fullName: string | null
  accessToken: string
}

// Result of trying to establish the current Hub user:
// - 'active'  verified user in hand
// - 'none'    no session cookie at all — genuinely signed out
// - 'stale'   a session cookie is present but identity is not verifiable right
//             now. `transient` distinguishes a Hub auth-server blip (getUser
//             threw / 5xx — the session is probably fine) from a token the Hub
//             actively rejected (`transient: false`). Callers use this to avoid
//             bouncing a still-signed-in user to login on a transient error.
export type HubSessionResult =
  | { status: 'active'; user: HubUser }
  | { status: 'none' }
  | { status: 'stale'; transient: boolean }

type CookieStore = Awaited<ReturnType<typeof cookies>>
type ReadResult = { status: 'active'; user: HubUser } | { status: 'none' } | { status: 'stale'; transient: boolean }

// Reads a Hub session from a specific cookie. `cookieName` selects the child's
// own session (CHILD_COOKIE_NAME) or, when omitted, the Portal's shared
// `sb-<ref>-auth-token`. Read-only: this runs in Server Components, which
// cannot write cookies, so `setAll` is a no-op. That is correct, not a bug —
// the proxy (refreshChildSession) owns rotation, and getSession() itself
// refreshes an expired token in-memory for this request. See DECISION-2.
//
// SECURITY: the `user` object in the cookie is attacker-writable independently
// of the signed access_token, so we NEVER trust it. We take only the
// access_token from the cookie and re-verify it against the Hub's auth server
// with getUser(token) — the returned user is cryptographically trustworthy and
// is the sole source of identity claims (id/email/name).
async function readSession(
  meta: HubMeta,
  cookieStore: CookieStore,
  cookiePresent: boolean,
  cookieName?: string,
): Promise<ReadResult> {
  const hubAuth = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
    ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll() {
        // Server Components can't write cookies; the proxy owns refresh.
      },
    },
  })

  const {
    data: { session },
    error: sessionError,
  } = await hubAuth.auth.getSession()
  // getSession() already tried an in-memory refresh. No session now means either
  // no cookie (none), a dead refresh token (stale), or a transient failure to
  // refresh (stale+transient — a retryable refresh error with an expired token
  // surfaces here as a null session, not as a getUser error).
  if (!session?.access_token) {
    if (!cookiePresent) return { status: 'none' }
    return { status: 'stale', transient: isTransientAuthError(sessionError) }
  }

  const {
    data: { user },
    error,
  } = await hubAuth.auth.getUser(session.access_token)
  if (error || !user) {
    // A session exists but the Hub did not confirm identity. A 4xx means the
    // token was rejected (re-auth needed); a network error / 5xx is a transient
    // Hub blip and the session is probably still good.
    return { status: 'stale', transient: isTransientAuthError(error) }
  }

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null

  return {
    status: 'active',
    user: {
      id: user.id,
      email: user.email ?? null,
      fullName,
      accessToken: session.access_token,
    },
  }
}

// Full result form: distinguishes "no session" from "present but unverifiable".
//
// Prefers the child app's OWN session cookie (refreshed by the proxy). Falls
// back to the Portal's shared cookie when there is no active child session —
// which keeps production working before the production handoff lands, and backs
// the HOLY_AUTH_CHILD_SESSION kill switch (DECISION-4).
export async function getHubSessionResult(): Promise<HubSessionResult> {
  // Call cookies() FIRST so Next marks the route dynamic. If getHubMeta()
  // (which reads HUB_URL) runs first, Next may try to statically prerender a
  // Hub-guarded page and the build crashes wherever HUB_URL is unset (CI).
  const cookieStore = await cookies()
  const meta = await getHubMeta()
  const allCookies = cookieStore.getAll()

  const childPresent = isChildSessionEnabled() && hasChildSessionCookie(allCookies)
  if (childPresent) {
    const child = await readSession(meta, cookieStore, true, CHILD_COOKIE_NAME)
    if (child.status === 'active') return child
    if (child.status === 'stale' && child.transient) return child
    // Non-transient child failure: fall through and try the shared cookie.
  }

  // Once the production handoff owns the session, NEVER read the shared Portal
  // cookie here: getSession() would on-demand-refresh it and rotate the Portal's
  // shared refresh token (the reuse-detection collision this feature exists to
  // avoid). The proxy handles bootstrapping a child session instead.
  if (isProdHandoffEnabled()) {
    return childPresent ? { status: 'stale', transient: false } : { status: 'none' }
  }

  const projectRef = new URL(meta.supabaseUrl).hostname.split('.')[0]
  const sharedPresent = allCookies.some((cookie) =>
    cookie.name.startsWith(`sb-${projectRef}-auth-token`),
  )
  const shared = await readSession(meta, cookieStore, sharedPresent)
  if (shared.status === 'active') return shared

  if (childPresent || sharedPresent) {
    return { status: 'stale', transient: shared.status === 'stale' ? shared.transient : false }
  }
  return { status: 'none' }
}

// Returns the current Hub user, or null when there is no verified session.
// Thin wrapper over getHubSessionResult for callers that only need the user
// (e.g. createHubClient's token accessor).
export async function getHubSession(): Promise<HubUser | null> {
  const result = await getHubSessionResult()
  return result.status === 'active' ? result.user : null
}
