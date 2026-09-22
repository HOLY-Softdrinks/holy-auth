// Child apps set exactly two env vars: HUB_URL and APP_SLUG.
// Everything about the Hub's Supabase is discovered from HUB_URL/api/hub-meta.

export type HubMeta = {
  supabaseUrl: string
  supabaseAnonKey: string
  issuer: string
}

let cachedMeta: HubMeta | null = null
let cachedAt = 0
let lastFailureAt = 0
let servingStale = false
const META_TTL_MS = 5 * 60 * 1000
// Hard ceiling for serving stale meta through a Portal outage. Long enough to
// ride out a deploy or a blip without logging anyone out, short enough that
// genuinely dead/rotated Hub coordinates surface instead of being served
// forever.
const META_STALE_CEILING_MS = 60 * 60 * 1000
// After a failed refetch, wait this long before trying again (while serving
// stale) so a sick Portal isn't hammered by one round-trip per request.
const META_RETRY_BACKOFF_MS = 30 * 1000
// Cap on the meta fetch itself so a hanging Portal can't stall every request.
const META_FETCH_TIMEOUT_MS = 5 * 1000

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

// Master kill switch (F-001 DECISION-4): HOLY_AUTH_CHILD_SESSION=0 turns off the
// whole child-owned-session path — the proxy stops refreshing/handing off and
// getHubSession reverts to reading the Portal's shared cookie. Cheap insurance
// for a fleet-wide auth change.
export function isChildSessionEnabled(): boolean {
  return process.env.HOLY_AUTH_CHILD_SESSION !== '0'
}

async function fetchHubMeta(): Promise<HubMeta> {
  const response = await fetch(`${getHubUrl()}/api/hub-meta`, {
    signal: AbortSignal.timeout(META_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`@holy/auth: failed to fetch hub meta (${response.status})`)
  }
  const meta = (await response.json()) as HubMeta & { ok: boolean }
  if (!meta.supabaseUrl || !meta.supabaseAnonKey) {
    throw new Error('@holy/auth: hub meta response is missing Supabase coordinates')
  }
  return meta
}

const isFresh = (now: number) => cachedMeta !== null && now - cachedAt < META_TTL_MS
const canServeStale = (now: number) => cachedMeta !== null && now - cachedAt < META_STALE_CEILING_MS

export async function getHubMeta(): Promise<HubMeta> {
  const now = Date.now()
  if (isFresh(now)) return cachedMeta as HubMeta

  // During an outage don't retry on every request: if we failed recently and
  // still have servable stale meta, serve it without another round-trip.
  if (now - lastFailureAt < META_RETRY_BACKOFF_MS && canServeStale(now)) {
    return cachedMeta as HubMeta
  }

  try {
    const meta = await fetchHubMeta()
    cachedMeta = meta
    cachedAt = now
    servingStale = false
    return meta
  } catch (error) {
    lastFailureAt = now
    // Portal briefly unreachable (deploy, 5xx, network blip, timeout). Keep
    // serving the last good meta so users with a valid session keep browsing
    // instead of hitting an error boundary — but only up to the staleness
    // ceiling. With no cache ever, or past the ceiling, surface the failure.
    if (canServeStale(now)) {
      if (!servingStale) {
        servingStale = true
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`@holy/auth: hub-meta refetch failed, serving cached meta (${message})`)
      }
      return cachedMeta as HubMeta
    }
    throw error
  }
}
