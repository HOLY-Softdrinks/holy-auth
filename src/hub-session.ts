import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getHubMeta } from './config'

export type HubUser = {
  id: string
  email: string | null
  fullName: string | null
  accessToken: string
}

// Reads the Hub session from the shared auth cookie (same host in dev; the Hub
// sets its cookie on `.apps.holy.com` in production so children can read it).
// Returns null when there is no valid Hub session.
//
// SECURITY: the `user` object in the cookie is attacker-writable independently
// of the signed access_token, so we NEVER trust it. We take only the
// access_token from the cookie and re-verify it against the Hub's auth server
// with getUser(token) — the returned user is cryptographically trustworthy and
// is the sole source of identity claims (id/email/name), which downstream code
// persists via service-role writes.
export async function getHubSession(): Promise<HubUser | null> {
  const meta = await getHubMeta()
  const cookieStore = await cookies()

  const hubAuth = createServerClient(meta.supabaseUrl, meta.supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll() {
        // Children never write Hub cookies — the Hub owns its session.
      },
    },
  })

  const {
    data: { session },
  } = await hubAuth.auth.getSession()
  if (!session?.access_token) return null

  const {
    data: { user },
    error,
  } = await hubAuth.auth.getUser(session.access_token)
  if (error || !user) return null

  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null

  return {
    id: user.id,
    email: user.email ?? null,
    fullName,
    accessToken: session.access_token,
  }
}
