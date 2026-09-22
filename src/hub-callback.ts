import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getAppSlug, getHubMeta, getHubUrl, isChildSessionEnabled } from './config'
import { CHILD_COOKIE_NAME, childCookieOptions } from './session-cookie'

// Hub-login handoff. The child app holds its OWN Supabase session (an
// independent refresh-token family) so it can refresh without rotating the
// Portal's shared `.apps.holy.com` cookie. It obtains that session by
// exchanging a one-time magiclink token the Portal mints, via verifyOtp —
// exactly the dev/preview flow, now also for production.
//
//   - dev/preview: the Portal's /dev-handoff confirm page mints the token
//     (origin is not registry-verified, so a human confirms).
//   - production: the Portal's /api/app-handoff mints it silently for a
//     registry-verified origin (no confirm). See .pandaos/api-specs/portal-app-handoff.md.

// Protocol constants — must match holy-hub. Kept as `dev-callback` for backward
// compatibility (custom proxies route DEV_CALLBACK_PATH); HUB_CALLBACK_PATH is
// the mode-neutral alias for new code.
export const DEV_CALLBACK_PATH = '/__hub/dev-callback'
export const HUB_CALLBACK_PATH = DEV_CALLBACK_PATH

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1'])

// Login-CSRF guard: the callback only accepts a token if the handoff was
// started from this same browser. The nonce lives in an HttpOnly cookie set
// when we redirect out, is echoed back by the Portal as `state`, and must
// match — otherwise an attacker could hand a victim a token for the
// ATTACKER's account and silently fix the victim's session onto it.
const STATE_COOKIE = '__hub_dev_handoff_state'
const STATE_TTL_SECONDS = 10 * 60

// Redirect-loop guard for the SILENT production handoff. Without a confirm
// screen to break the cycle, a persistently failing exchange would bounce a
// user forever. We mark one attempt; a second arrival with the marker still set
// goes to /login instead of re-entering the handoff.
const ATTEMPT_COOKIE = '__hub_handoff_attempt'
const ATTEMPT_TTL_SECONDS = 60

export function isLocalDevRequest(request: NextRequest): boolean {
  return (
    process.env.NODE_ENV === 'development' && LOCAL_HOSTNAMES.has(request.nextUrl.hostname)
  )
}

// Vercel preview deployments can't read the Hub cookie either (they live on
// *.vercel.app). VERCEL_ENV is set by the platform and is 'production' on the
// real domain — a server-controlled gate, deliberately not derived from the
// request. The Portal only hands tokens to hosts on OUR Vercel team suffix,
// so a preview gate here never widens where tokens can go.
export function isPreviewRequest(): boolean {
  return process.env.VERCEL_ENV === 'preview'
}

// Umbrella gate for the dev/preview handoff surface. Custom proxies should use
// this (not isLocalDevRequest) so previews work too.
export function isDevHandoffRequest(request: NextRequest): boolean {
  return isLocalDevRequest(request) || isPreviewRequest()
}

// The real production domain (server-controlled, not request-derived).
export function isProductionRequest(): boolean {
  return process.env.VERCEL_ENV === 'production'
}

// Production handoff opt-in. Stays OFF until the Portal's /api/app-handoff
// endpoint is deployed and its security review (F-001 Gate 3) has passed —
// then set HOLY_AUTH_PROD_HANDOFF=1. Off by default so production behaviour is
// unchanged (shared-cookie read) and there is no silent-redirect risk on real
// users before the Portal half exists.
export function isProdHandoffEnabled(): boolean {
  return isChildSessionEnabled() && isProductionRequest() && process.env.HOLY_AUTH_PROD_HANDOFF === '1'
}

// True when this deployment should run the callback exchange at all.
function isHandoffContext(request: NextRequest): boolean {
  return isDevHandoffRequest(request) || isProdHandoffEnabled()
}

// Same-origin relative paths only — reject `//host` and backslash variants.
function sanitizeReturnTo(rawReturnTo: string | null): string {
  if (!rawReturnTo) return '/'
  if (rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') && !rawReturnTo.includes('\\')) {
    return rawReturnTo
  }
  return '/'
}

function setStateCookie(response: NextResponse, state: string, isSecure: boolean): void {
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/',
    secure: isSecure,
  })
}

// Start (or restart) the DEV/PREVIEW handoff: mint a state nonce, remember it in
// an HttpOnly cookie, and send the developer to the Portal's confirm page.
// `returnTo` defaults to the current page; error branches of the callback MUST
// pass the sanitized return_to instead — the callback's own URL (with a stale
// token) would otherwise become the landing page and loop forever.
export function redirectToDevHandoff(
  request: NextRequest,
  options?: { returnTo?: string; error?: string },
): NextResponse {
  const state = crypto.randomUUID()
  const search = new URLSearchParams({
    next: `${request.nextUrl.origin}${HUB_CALLBACK_PATH}`,
    return_to: options?.returnTo ?? request.nextUrl.pathname + request.nextUrl.search,
    app: getAppSlug(),
    state,
  })
  if (options?.error) search.set('error', options.error)

  const response = NextResponse.redirect(`${getHubUrl()}/dev-handoff?${search.toString()}`)
  setStateCookie(response, state, request.nextUrl.protocol === 'https:')
  return response
}

// Start the SILENT production handoff to the Portal's /api/app-handoff. No
// confirm screen (the origin is registry-verified by the Portal). Loop-guarded:
// a second arrival still carrying the attempt marker goes to /login instead.
export function redirectToHubHandoff(
  request: NextRequest,
  options?: { returnTo?: string },
): NextResponse {
  const isSecure = request.nextUrl.protocol === 'https:'
  const returnTo = options?.returnTo ?? request.nextUrl.pathname + request.nextUrl.search

  if (request.cookies.get(ATTEMPT_COOKIE)?.value) {
    // We already tried a handoff this cycle and still have no child session —
    // stop looping and fall back to a normal login. `next` must be the sanitized
    // returnTo (the page the user wanted), NOT request.url: when we're reached
    // from the callback, request.url carries a spent token_hash, and landing
    // back on it after login would just restart the loop.
    const target = new URL(returnTo, request.nextUrl.origin).toString()
    const loginUrl = `${getHubUrl()}/login?next=${encodeURIComponent(target)}`
    const bail = NextResponse.redirect(loginUrl)
    bail.cookies.set(ATTEMPT_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })
    return bail
  }

  const state = crypto.randomUUID()
  const search = new URLSearchParams({
    next: `${request.nextUrl.origin}${HUB_CALLBACK_PATH}`,
    return_to: returnTo,
    app: getAppSlug(),
    state,
  })
  const response = NextResponse.redirect(`${getHubUrl()}/api/app-handoff?${search.toString()}`)
  setStateCookie(response, state, isSecure)
  response.cookies.set(ATTEMPT_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ATTEMPT_TTL_SECONDS,
    path: '/',
    secure: isSecure,
  })
  return response
}

// Restart the handoff in whichever mode this deployment uses, on a callback error.
function restartHandoff(
  request: NextRequest,
  options: { returnTo: string; error: string },
): NextResponse {
  if (isDevHandoffRequest(request)) {
    return redirectToDevHandoff(request, options)
  }
  // Production: silent restart (loop-guarded inside redirectToHubHandoff).
  return redirectToHubHandoff(request, { returnTo: options.returnTo })
}

// Exchange a one-time magiclink token into the child's own session cookie.
// Shared by dev, preview and production — the exchange is identical; only how
// the token was minted (confirm vs. registry-verified) differs upstream.
export async function handleHubCallback(request: NextRequest): Promise<NextResponse> {
  // Defense in depth: only run the exchange in a handoff-enabled deployment.
  if (!isHandoffContext(request)) {
    return NextResponse.redirect(new URL('/', request.nextUrl.origin))
  }

  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get('return_to'))

  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  if (!tokenHash) return restartHandoff(request, { returnTo, error: 'missing_token' })

  const state = request.nextUrl.searchParams.get('state')
  const expectedState = request.cookies.get(STATE_COOKIE)?.value
  if (!state || !expectedState || state !== expectedState) {
    return restartHandoff(request, { returnTo, error: 'state_mismatch' })
  }

  const response = NextResponse.redirect(new URL(returnTo, request.nextUrl.origin))
  response.cookies.set(STATE_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })
  // Success clears the loop-guard marker so future navigations start clean.
  response.cookies.set(ATTEMPT_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })

  const meta = await getHubMeta()
  const isSecure = request.nextUrl.protocol === 'https:'
  // Mint the session under the child's OWN cookie name (host-only), not the
  // Portal's shared `sb-<ref>-auth-token`. This is the session the proxy's
  // refreshChildSession() will later rotate — an independent refresh-token
  // family that never collides with the Portal's.
  const hubAuth = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
    cookieOptions: { name: CHILD_COOKIE_NAME, ...childCookieOptions(isSecure) },
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        )
      },
    },
  })

  const { error } = await hubAuth.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
  if (error) {
    // Expired or already-used token — restart for a fresh one.
    return restartHandoff(request, { returnTo, error: 'verify_failed' })
  }

  return response
}

// Backward-compatible alias — custom proxies (v0.3.1+) import and route this.
export const handleDevCallback = handleHubCallback
