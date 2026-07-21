import { NextResponse, type NextRequest } from 'next/server'
import { getHubMeta, getHubUrl } from './config'
import {
  DEV_CALLBACK_PATH,
  handleDevCallback,
  isDevHandoffRequest,
  redirectToDevHandoff,
} from './dev-callback'

// Lightweight route protection for the child's proxy.ts (Next.js 16):
//
//   import { createHubProxyGuard } from '@holy/auth'
//   export const proxy = createHubProxyGuard({ publicPaths: ['/', '/login'] })
//
// Redirect-only: checks that a Hub auth cookie exists. The real verification
// happens in requireAppAccess() on the page — keep the proxy cheap.
//
// In local development (NODE_ENV=development on localhost) it also runs the
// dev-login handoff: unauthenticated requests go to the Hub's /dev-handoff
// confirm page instead of /login, and /__hub/dev-callback exchanges the
// returned one-time token into a Hub session cookie on localhost.
export function createHubProxyGuard(options?: { publicPaths?: string[] }) {
  const publicPaths = options?.publicPaths ?? ['/']

  return async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl

    if (isDevHandoffRequest(request) && pathname === DEV_CALLBACK_PATH) {
      return handleDevCallback(request)
    }
    const isPublic = publicPaths.some((publicPath) =>
      publicPath === '/' ? pathname === '/' : pathname.startsWith(publicPath),
    )
    if (isPublic || pathname.startsWith('/_next') || pathname.includes('.')) {
      return NextResponse.next()
    }

    const meta = await getHubMeta()
    const projectRef = new URL(meta.supabaseUrl).hostname.split('.')[0]
    const hasHubCookie = request.cookies
      .getAll()
      .some((cookie) => cookie.name.startsWith(`sb-${projectRef}-auth-token`))

    if (!hasHubCookie) {
      if (isDevHandoffRequest(request)) {
        return redirectToDevHandoff(request)
      }
      const returnTo = encodeURIComponent(request.url)
      return NextResponse.redirect(`${getHubUrl()}/login?next=${returnTo}`)
    }
    return NextResponse.next()
  }
}
