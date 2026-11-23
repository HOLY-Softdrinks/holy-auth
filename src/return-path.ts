// Why: values like `/.//host` normalise to a `//host` path that keeps this origin but becomes a foreign authority if reinterpreted, so they are refused.
export function sanitizeReturnTo(raw: string | null, origin: string): string {
  if (!raw || !raw.startsWith('/')) return '/'
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return '/'
  }
  if (url.origin !== new URL(origin).origin || url.pathname.startsWith('//')) return '/'
  return url.pathname + url.search + url.hash
}
