import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getHubSession } from './hub-session'

// The child's OWN Supabase project (third-party auth trusting the Hub issuer),
// authenticated with the current user's Hub token. RLS in the child sees
// auth.uid() = the Hub user id.
//
// Generic over the child's Database type:
//   const supabase = createHubClient<Database>()
export function createHubClient<Db = unknown>(): SupabaseClient<Db> {
  const childUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const childAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!childUrl || !childAnonKey) {
    throw new Error(
      '@holy/auth: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY (child project) are not set',
    )
  }

  return createClient<Db>(childUrl, childAnonKey, {
    accessToken: async () => {
      const hubUser = await getHubSession()
      return hubUser?.accessToken ?? null
    },
  })
}

// JIT provisioning: upsert the child's local user row on first authorized
// entry, keyed by the Hub user id. Uses the child's service role key because
// profile tables are typically not user-writable under RLS.
export async function jitProvision(input: {
  table: string
  primaryKeyColumn: string
  row: Record<string, unknown>
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const childUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!childUrl || !serviceRoleKey) {
    return { ok: false, error: '@holy/auth: child Supabase service credentials are not set' }
  }

  const admin = createClient(childUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error } = await admin
    .from(input.table)
    .upsert(input.row, { onConflict: input.primaryKeyColumn, ignoreDuplicates: true })
  if (error) return { ok: false, error: 'Provisioning failed' }
  return { ok: true }
}
