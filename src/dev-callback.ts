import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { getAppSlug, getHubMeta, getHubUrl } from './config'

// Localhost dev-login handoff (Hub F-006). In local development the Hub's
// production cookie on `.apps.holy.com` is unreachable, so the Portal's
// /dev-handoff page mints a one-time magiclink token and redirects here.
// We exchange it with verifyOtp — that creates an INDEPENDENT Hub session
// (own refresh-token family, no rotation collision with the Portal session)
// and writes the sb-* cookies onto localhost, where getHubSession() finds them.

export const DEV_CALLBACK_PATH = '/__hub/dev-callback'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1'])

export function isLocalDevRequest(request: NextRequest): boolean {
  return (
    process.env.NODE_ENV === 'development' && LOCAL_HOSTNAMES.has(request.nextUrl.hostname)
  )
}

// Where the child sends the developer to pick up a token: the Portal's confirm
// page, carrying this app's callback URL and the page to land on afterwards.
export function buildDevHandoffUrl(request: NextRequest): string {
  const search = new URLSearchParams({
    next: `${request.nextUrl.origin}${DEV_CALLBACK_PATH}`,
    return_to: request.nextUrl.pathname + request.nextUrl.search,
    app: getAppSlug(),
  })
  return `${getHubUrl()}/dev-handoff?${search.toString()}`
}

export async function handleDevCallback(request: NextRequest): Promise<NextResponse> {
  const tokenHash = request.nextUrl.searchParams.get('token_hash')
  if (!tokenHash) {
    return NextResponse.redirect(buildDevHandoffUrl(request))
  }

  // Same-origin relative paths only — reject `//host` and backslash variants.
  const rawReturnTo = request.nextUrl.searchParams.get('return_to') ?? '/'
  const returnTo =
    rawReturnTo.startsWith('/') && !rawReturnTo.startsWith('//') && !rawReturnTo.includes('\\')
      ? rawReturnTo
      : '/'

  const response = NextResponse.redirect(new URL(returnTo, request.nextUrl.origin))

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
    return NextResponse.redirect(buildDevHandoffUrl(request))
  }

  return response
}
