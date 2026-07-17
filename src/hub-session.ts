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
// sets its cookie on `.holy.com` in production so children can read it).
// Returns null when there is no (or an expired) Hub session.
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
  if (!session || session.expires_at === undefined) return null
  if (session.expires_at * 1000 < Date.now()) return null

  // The signature is verified downstream: the Hub's Access API verifies the
  // token against its auth server, and the child's PostgREST verifies it
  // against the Hub JWKS. Here we only surface identity claims for display.
  const user = session.user
  const fullName =
    typeof user.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null

  return {
    id: user.id,
    email: user.email ?? null,
    fullName,
    accessToken: session.access_token,
  }
}
