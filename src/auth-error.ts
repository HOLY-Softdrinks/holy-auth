// Classify a Supabase auth error as transient (retryable — a Hub blip, a
// network failure, a 5xx) vs. definitive (the token was actually rejected).
//
// This MUST NOT be a plain `status >= 500` check: auth-js constructs
// `AuthRetryableFetchError` with **status 0** for network-level failures
// (see @supabase/auth-js lib/fetch.js — `new AuthRetryableFetchError(msg, 0)`),
// so DNS/connection-reset/timeout errors would otherwise be misread as
// definitive and log out a valid user. `isAuthRetryableFetchError` is not
// re-exported by @supabase/supabase-js and auth-js is not a direct dependency,
// so we classify on the public error shape (name + status) instead.
export function isTransientAuthError(error: unknown): boolean {
  if (!error) return false
  const { name, status } = error as { name?: string; status?: number }
  return (
    name === 'AuthRetryableFetchError' ||
    status === undefined ||
    status === 0 ||
    status >= 500
  )
}
