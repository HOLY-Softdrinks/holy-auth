import { NextResponse, type NextRequest } from 'next/server'
import { getHubMeta, getHubUrl } from './config'

// Lightweight route protection for the child's proxy.ts (Next.js 16):
//
//   import { createHubProxyGuard } from '@holy/auth'
//   export const proxy = createHubProxyGuard({ publicPaths: ['/', '/login'] })
//
// Redirect-only: checks that a Hub auth cookie exists. The real verification
// happens in requireAppAccess() on the page — keep the proxy cheap.
export function createHubProxyGuard(options?: { publicPaths?: string[] }) {
  const publicPaths = options?.publicPaths ?? ['/']

  return async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl
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
      return NextResponse.redirect(`${getHubUrl()}/login`)
    }
    return NextResponse.next()
  }
}
