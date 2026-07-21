import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getAppSlug, getHubMeta, getHubUrl } from './config'

// Localhost dev-login handoff (Hub F-006). In local development the Hub's
// production cookie on `.apps.holy.com` is unreachable, so the Portal's
// /dev-handoff page mints a one-time magiclink token and redirects here.
// We exchange it with verifyOtp — that creates an INDEPENDENT Hub session
// (own refresh-token family, no rotation collision with the Portal session)
// and writes the sb-* cookies onto localhost, where getHubSession() finds them.

// Protocol constants — must match holy-hub's lib/dev-handoff.ts.
export const DEV_CALLBACK_PATH = '/__hub/dev-callback'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1'])

// Login-CSRF guard: the callback only accepts a token if the handoff was
// started from this same browser. The nonce lives in an HttpOnly cookie set
// when we redirect out, is echoed back by the Portal as `state`, and must
// match — otherwise an attacker could hand a victim a token for the
// ATTACKER's account and silently fix the victim's local session onto it.
const STATE_COOKIE = '__hub_dev_handoff_state'
const STATE_TTL_SECONDS = 10 * 60

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

// Umbrella gate for every dev-handoff surface. Custom proxies should use this
// (not isLocalDevRequest) so previews work too.
export function isDevHandoffRequest(request: NextRequest): boolean {
  return isLocalDevRequest(request) || isPreviewRequest()
}

// Same-origin relative paths only — reject `//host` and backslash variants.
function sanitizeReturnTo(rawReturnTo: string | null): string {
  if (!rawReturnTo) return '/'
  if (rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') && !rawReturnTo.includes('\\')) {
    return rawReturnTo
  }
  return '/'
}

// Start (or restart) the handoff: mint a state nonce, remember it in an
// HttpOnly cookie, and send the developer to the Portal's confirm page.
// `returnTo` defaults to the current page; error branches of the callback
// MUST pass the sanitized return_to instead — the callback's own URL (with a
// stale token) would otherwise become the landing page and loop forever.
export function redirectToDevHandoff(
  request: NextRequest,
  options?: { returnTo?: string; error?: string },
): NextResponse {
  const state = crypto.randomUUID()
  const search = new URLSearchParams({
    next: `${request.nextUrl.origin}${DEV_CALLBACK_PATH}`,
    return_to: options?.returnTo ?? request.nextUrl.pathname + request.nextUrl.search,
    app: getAppSlug(),
    state,
  })
  if (options?.error) search.set('error', options.error)

  const response = NextResponse.redirect(`${getHubUrl()}/dev-handoff?${search.toString()}`)
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/',
    secure: request.nextUrl.protocol === 'https:',
  })
  return response
}

export async function handleDevCallback(request: NextRequest): Promise<NextResponse> {
  // Defense in depth: enforce the dev-only precondition here too, not just in
  // the proxy guard that routes to us.
  if (!isDevHandoffRequest(request)) {
    return NextResponse.redirect(new URL('/', request.nextUrl.origin))
  }

  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get('return_to'))

  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  if (!tokenHash) return redirectToDevHandoff(request, { returnTo })

  const state = request.nextUrl.searchParams.get('state')
  const expectedState = request.cookies.get(STATE_COOKIE)?.value
  if (!state || !expectedState || state !== expectedState) {
    return redirectToDevHandoff(request, { returnTo, error: 'state_mismatch' })
  }

  const response = NextResponse.redirect(new URL(returnTo, request.nextUrl.origin))
  response.cookies.set(STATE_COOKIE, '', { httpOnly: true, maxAge: 0, path: '/' })

  const meta = await getHubMeta()
  const hubAuth = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
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
    // Expired or already-used token — send the developer back for a fresh one.
    return redirectToDevHandoff(request, { returnTo, error: 'verify_failed' })
  }

  return response
}
