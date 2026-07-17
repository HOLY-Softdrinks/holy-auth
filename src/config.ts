// Child apps set exactly two env vars: HUB_URL and APP_SLUG.
// Everything about the Hub's Supabase is discovered from HUB_URL/api/hub-meta.

export type HubMeta = {
  supabaseUrl: string
  supabaseAnonKey: string
  issuer: string
}

let cachedMeta: HubMeta | null = null
let cachedAt = 0
const META_TTL_MS = 5 * 60 * 1000

export function getHubUrl(): string {
  const hubUrl = process.env.HUB_URL
  if (!hubUrl) throw new Error('@holy/auth: HUB_URL env var is not set')
  return hubUrl.replace(/\/$/, '')
}

export function getAppSlug(): string {
  const slug = process.env.APP_SLUG
  if (!slug) throw new Error('@holy/auth: APP_SLUG env var is not set')
  return slug
}

export async function getHubMeta(): Promise<HubMeta> {
  const now = Date.now()
  if (cachedMeta && now - cachedAt < META_TTL_MS) return cachedMeta

  const response = await fetch(`${getHubUrl()}/api/hub-meta`)
  if (!response.ok) {
    throw new Error(`@holy/auth: failed to fetch hub meta (${response.status})`)
  }
  const meta = (await response.json()) as HubMeta & { ok: boolean }
  if (!meta.supabaseUrl || !meta.supabaseAnonKey) {
    throw new Error('@holy/auth: hub meta response is missing Supabase coordinates')
  }

  cachedMeta = meta
  cachedAt = now
  return meta
}
