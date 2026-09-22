import type { CookieOptions } from '@supabase/ssr'

// The child app's OWN Hub session cookie.
//
// This is deliberately NOT `sb-<ref>-auth-token` (the Portal's shared cookie on
// `.apps.holy.com`). Both come from the same Supabase project, so if the child
// stored its session under the default name it would collide with the Portal's
// cookie — same name, one host-only and one domain-wide — and cookie
// reassembly would be ambiguous. A distinct name keeps the two sessions
// completely separate: the child owns its refresh-token family and rotates it
// freely, the Portal owns its own, and neither invalidates the other.
export const CHILD_COOKIE_NAME = 'holy-app-auth'

// Matches the child cookie's base name and any of @supabase/ssr's numbered
// chunks (`holy-app-auth`, `holy-app-auth.0`, `holy-app-auth.1`, …). Mirrors
// the library's own CHUNK_LIKE_REGEX so presence and clearing stay in lockstep
// with how it writes large sessions.
const CHILD_CHUNK_REGEX = new RegExp(`^${CHILD_COOKIE_NAME}([.](0|[1-9][0-9]*))?$`)

export function isChildSessionCookie(name: string): boolean {
  return CHILD_CHUNK_REGEX.test(name)
}

// True when the request carries a child session cookie (base or any chunk).
// Used by the proxy to decide "refresh this session" vs "start a handoff".
export function hasChildSessionCookie(cookies: { name: string }[]): boolean {
  return cookies.some((cookie) => isChildSessionCookie(cookie.name))
}

// Host-only cookie options for the child session. Crucially NO `domain` — the
// cookie stays on this app's exact host and never rides along to the Portal or
// sibling apps (see the name comment above). The Supabase client merges these
// with its own defaults and drives maxAge; we only pin the security-relevant
// attributes.
export function childCookieOptions(isSecure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
  }
}
