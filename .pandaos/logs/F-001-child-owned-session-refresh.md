# Log — F-001: Child-owned session refresh

## 2026-09-21 — planning

**Input:** `hub-logout-bug.md` handoff issue — child apps bounce users to `HUB_URL/login` ~hourly.

**Recon performed**
- Read all of `src/` (`config.ts`, `dev-callback.ts`, `hub-client.ts`, `hub-session.ts`,
  `index.ts`, `proxy-guard.ts`, `require-app-access.ts`), `README.md`, git log.
- Verified the failure chain against the code: `hub-session.ts:34` no-op `setAll` →
  `hub-session.ts:48` `getUser` on an expired JWT → `require-app-access.ts:19` `null` becomes
  `unauthenticated` → `require-app-access.ts:52` redirect. The issue's diagnosis is correct.
- Confirmed against current Supabase docs (Context7): refresh-token reuse detection revokes the
  whole session outside the ~10s reuse interval / parent-token exceptions; and
  *"Since Server Components can't write cookies, you need a Proxy to refresh expired Auth
  tokens"* — the refresh must live in the proxy, which the issue did not identify.
- No prior refresh work in git history. `autoRefreshToken: false` appears only on the
  service-role admin client (`hub-client.ts:42`), which is correct and out of scope.

**Findings beyond the issue**
1. The issue's two preferred fixes (child writes the rotated shared cookie / proxy refreshes the
   shared token) are the *riskiest* options — both rotate a refresh-token family that the Portal
   and every sibling app share. Not flagged in the issue.
2. `README.md:70` claims the localhost session "refreshes on its own". It does not; the no-op
   `setAll` is environment-independent. **Dev and preview have the same hourly bug.** Not in the
   issue at all, and it turned out to be the zero-risk beachhead (Slice 1).
3. Cookie *name* collision (not just domain) between a child-owned session and the Portal's,
   since both come from the same Supabase project. Drove the `holy-app-auth` rename.
4. `package.json` declares `next: >=15.0.0` but the package targets `proxy.ts` (Next 16). On
   Next 15 that file never runs, so proxy-based refresh would silently do nothing (RISK-4).

**Decisions taken** — see DECISION-1..4 in the feature doc. Headline: each child app gets its
own independent Supabase session (own refresh-token family, host-only `holy-app-auth` cookie),
refreshed in the proxy. No child ever rotates the Portal's shared token.

**User input**
- Silent redirect hop on first entry to each app: **approved**.
- Portal repo (`holy-hub`) in scope: **yes** — planned as a written contract
  (`.pandaos/api-specs/portal-app-handoff.md`, task 3.1) since that repo is not in this checkout.
- First framing of the Portal question was too jargon-heavy and had to be re-asked in plain terms.

**Open**
- Gate 0: `@supabase/ssr` is not installed in this checkout, so `cookieOptions.name` (RISK-3)
  could not be verified during planning. Fallback documented.

## 2026-09-21 — approved

- Plan **approved** by Diego.
- DECISION-3 **resolved**: Portal logout not ending child sessions is accepted. Slice 5
  downgraded from a `sessions_valid_from` build to "bound with token TTL + document". The
  `sessions_valid_from` design (user-level timestamp bumped on logout, checked by `/api/access`
  which already runs on every protected render at `require-app-access.ts:21`) is parked here in
  case the product decision reverses.
- No open product questions remain. Gate 0's `@supabase/ssr` API check is the only unknown and it
  is the builder's first step (fallback already documented, so it cannot block the approach).

**Status:** building. Next stage: builder (backend-only, no UI — Designer not required).

## Review — 2026-09-22
**Result:** Changes Requested

Scope: all 10 changed files read in full against the feature doc. `tsc --noEmit` clean; repo has
no lint/test tooling. Phase-2 completeness check passed — every `[x]` task is genuinely
implemented in code (not just checked off); 3.5 correctly left open (other repo). Note: I did the
mechanical pass by hand rather than via `ai-code-review`'s auto-fixing agents, because that skill
fixes code and the Reviewer must not author fixes; the diff is ~800 lines and was read in full.

🔴 **Critical** (must fix — blocks approval)
- **`src/refresh-session.ts:71-78`** — any `getClaims()` failure clears the child session cookies.
  `getClaims` fetches JWKS and can invoke `_callRefreshToken`, so a *transient* Hub/network blip
  returns an error and we destroy a perfectly valid session (the refresh token is wiped
  client-side; the user must re-handoff). This contradicts the feature's own acceptance criterion
  ("active user is not redirected to login as long as the Hub session is valid") and is
  inconsistent with `hub-session.ts`, which was built precisely to distinguish transient from
  definitive failures. It sits on every request's hot path, so one Hub wobble logs out the fleet.
  **Fix:** only clear on a definitive auth failure (`data === null && error === null`, or an
  `AuthError` with a 4xx status). On retryable errors leave the cookies untouched and return a
  non-destructive outcome (e.g. add `'unavailable'`) that the proxy passes through rather than
  treating as signed out.

🟡 **Significant** (should fix)
- **`src/hub-callback.ts:135`** — the loop-guard bail redirects to `/login?next=${request.url}`.
  When reached via `restartHandoff` from the callback, `request.url` IS the callback URL carrying a
  spent `token_hash`, so after login the user lands back on a dead token → restart → loop. This is
  exactly the footgun documented at lines 101-103 for the dev path, reintroduced in the new bail.
  **Fix:** use the sanitized `returnTo` — `new URL(returnTo, request.nextUrl.origin)` — not `request.url`.
- **`src/hub-session.ts:117-121`** — the shared-cookie fallback calls `getSession()` on the
  Portal's cookie, which on-demand-refreshes and therefore **rotates the Portal's shared refresh
  token without persisting it** (Server-Component `setAll` is a no-op). That is the precise
  collision this feature exists to eliminate, still reachable through the fallback door. Harmless
  today (it is the current production path), but the moment `HOLY_AUTH_PROD_HANDOFF=1` it silently
  undoes the fix for any child whose session goes non-transiently stale.
  **Fix:** when `isProdHandoffEnabled()`, skip the shared fallback and return `stale`/`none` so the
  proxy hands off instead.
- **`src/config.ts:52-77`** — `cachedAt` only advances on success, so once the 5-min TTL lapses
  during an outage **every** request re-attempts the failing fetch before serving stale, and no
  `fetch` timeout is configured. The outage-resilience slice therefore adds a failed (possibly
  hanging) round-trip to every request for up to an hour, amplifying load on an already-sick Portal.
  **Fix:** record `lastFailureAt` and back off (~30s) before retrying; add `AbortSignal.timeout(...)`.
- **`src/proxy-guard.ts:64-82`** — on `outcome === 'invalid'` the cookie clears are written onto
  `response`, but every branch that returns a *redirect* (handoff or `redirectSignedOut`) discards
  that response, so the dead child cookie survives and re-triggers `'invalid'` on each subsequent
  request. **Fix:** have `refreshChildSession` return the names to clear and apply them to whichever
  response is actually returned.
- **`src/proxy-guard.ts:53-61`** — under the kill switch on localhost the guard loops: the dev
  callback still writes `holy-app-auth`, but `getHubSessionResult` ignores it (kill switch), so the
  guard sees no session and redirects to the handoff again, forever. The code comment claims it
  "degrades to repeated Portal logins" — it is actually an unbreakable handoff loop.
  **Fix:** under the kill switch go straight to Portal `/login` (skip `redirectToDevHandoff`), or
  exempt dev/preview from the switch. At minimum correct the comment.
- **`src/require-app-access.ts:33`** *(pre-existing, same failure class as Slice 4)* — the
  `/api/access` `fetch` is unguarded, so a DNS/ECONNREFUSED/timeout throws out of `checkAppAccess`,
  violating its own contract ("Never throws for a normal deny — only surfaces an 'error' status").
  API-route callers get an exception instead of a 503. **Fix:** wrap in try/catch → `{status:'error', code:503}`.

🟢 **Suggestions**
- `src/session-cookie.ts:18` — `CHILD_COOKIE_NAME` is interpolated into a `RegExp` unescaped. Safe
  today (the literal has no metacharacters); escape it if the name ever becomes configurable.
- Feature doc task 1.1 names a helper `readChildCookies(jar)`; the implementation has
  `hasChildSessionCookie`. Update the doc so plan and code agree.
- Gate 0's "confirm the Hub project's access-token TTL" is still unverified (needs Hub project
  access). It feeds the child-session TTL decision in the Portal contract — worth closing before
  the Portal endpoint is built.

**Summary:** The architecture is right and the hard part — proxy-owned refresh against an
independent refresh-token family, with the canonical `NextResponse.next({ request })` forwarding —
is implemented correctly, and the security property (identity only ever from `getUser`) holds
throughout. What lets it down is error *classification*: the builder carefully separated transient
from definitive failures in `hub-session.ts`, then didn't apply the same discipline in
`refresh-session.ts`, where a transient blip destroys the session outright. That one plus the
handoff bail-loop and the shared-fallback rotation should be fixed before this ships; none are
architectural, all are localized.

## Re-review — 2026-09-22 (after fixes)
**Result:** Changes Requested

6 of 7 findings from the first pass are correctly fixed and verified (details at the bottom). The
🔴 critical fix, however, does **not** actually work for the most common transient case, and the
same root cause turns out to exist in two further places I should have caught in round 1.

🔴 **Critical — transient classification misses network errors (`status: 0`)**

The guard used in both modules is:
```ts
const transient = httpStatus === undefined || httpStatus >= 500
```
But auth-js constructs `AuthRetryableFetchError` with **status `0`** for network-level failures
(verified in `@supabase/auth-js@2.110.7` `lib/fetch.js:28` and `:114` —
`throw new AuthRetryableFetchError(_getErrorMessage(error), 0)`). `0` is neither `undefined` nor
`>= 500`, so a DNS failure / connection reset / dropped socket to the Hub is classified as
**definitive**. That is precisely the "Hub wobble" case the fix was written for.

Three sites, one root cause:
1. **`src/refresh-session.ts:91-92`** — network blip → `transient === false` → falls through to
   `'invalid'` → **child session cookies cleared**. The critical finding is therefore still live.
2. **`src/hub-session.ts:77-78`** — same expression; the comment even says *"anything else (5xx,
   network) is a transient Hub blip"*, but network errors don't take that branch. Result:
   `stale{transient:false}` → `checkAppAccess` → `unauthenticated` → **login redirect on a network
   blip**. This is pre-existing from Slice 2 and defeats Slice 2's entire purpose; I missed it in
   round 1 (I flagged that `refresh-session` didn't classify at all, but didn't verify that the
   classifier it was told to copy was itself correct).
3. **`src/hub-session.ts:60-67`** — `getSession()`'s `error` is destructured away entirely, and a
   missing session is hardcoded to `transient: false`. But `GoTrueClient.__loadSession()` returns
   `{ session: null, error }` when `_callRefreshToken` fails **retryably** and the access token has
   already expired. So a transient refresh failure also presents as "no session" → non-transient →
   logout.

**Fix (one helper, used by all three):** `isAuthRetryableFetchError` is exported by
`@supabase/auth-js` but is **not** re-exported by `@supabase/supabase-js`, and auth-js is not a
declared dependency here — so do not add an import for it. Classify on the public error shape
instead:
```ts
function isTransientAuthError(error: unknown): boolean {
  if (!error) return false
  const { name, status } = error as { name?: string; status?: number }
  return name === 'AuthRetryableFetchError' || status === undefined || status === 0 || status >= 500
}
```
Apply at all three sites, and capture `error` from `getSession()` at site 3 so a retryable refresh
failure is reported as `stale{transient:true}` rather than a dead session.

🟢 **Suggestions**
- `src/require-app-access.ts` — `await response.json()` sits outside the new try/catch, so a 200
  with a malformed body still throws past the "never throws" contract. Move it inside.

**Verified fixed from round 1:**
- ✅ sig #1 `hub-callback.ts:132-141` — bail now uses `new URL(returnTo, origin)`, not the
  spent-token `request.url`. Loop closed.
- ✅ sig #2 `hub-session.ts:117-124` — shared-cookie fallback skipped under `isProdHandoffEnabled()`,
  so the Portal's token is no longer rotated once the handoff owns the session.
- ✅ sig #3 `config.ts` — `lastFailureAt` + 30s backoff and `AbortSignal.timeout(5s)`; backoff
  correctly does not misfire on first call (`lastFailureAt = 0`), and still fetches when there is
  nothing servable.
- ✅ sig #4 — `staleCookies` + `expireChildCookies` applied via `finalize()` on every returned
  response, including redirects. Dead cookies no longer linger.
- ✅ sig #5 `proxy-guard.ts:53-61` — kill switch goes to Portal `/login`; the localhost handoff loop
  is gone.
- ✅ sig #6 — `/api/access` fetch guarded → `{ status:'error', code:503 }`.
- ✅ New `'unavailable'` outcome passes through without granting anything: the page still runs
  `requireAppAccess`, which throws to the error boundary, so there is no auth hole.
- ✅ Dead `clearChildCookies` removed; `tsc --noEmit` clean; no import cycle from the new
  `hub-session → hub-callback` edge.

**Summary:** The structural fixes all landed correctly — the handoff loop, the shared-token
rotation, the outage backoff and the cookie-clear plumbing are genuinely resolved. What remains is
a single one-line predicate that is wrong in three places and silently turns every network-level
Hub failure into a logout. It is a small fix, but it is the whole point of the feature, so it
blocks again.

## Re-review #2 — 2026-09-22 (after transient-classification fix)
**Result:** Approved with Notes

The round-2 critical is properly resolved. `src/auth-error.ts` `isTransientAuthError()` classifies
on `name === 'AuthRetryableFetchError' || status === undefined || status === 0 || status >= 500`,
and is correctly applied at all three sites (`refresh-session.ts:91`, `hub-session.ts:71` and
`:82`), including the previously-discarded `getSession()` error.

I verified the classification against the actual auth-js error constructors rather than trusting
the predicate reads plausibly — this is the part that decides logout vs. keep-signed-in:

| Error | status | Classified | Correct? |
|---|---|---|---|
| `AuthRetryableFetchError` (network) | `0` | transient | ✅ session preserved |
| Server 5xx | `>=500` | transient | ✅ |
| `AuthSessionMissingError` | `400` | definitive | ✅ → login |
| `AuthInvalidJwtError` | `400` | definitive | ✅ → login |
| `AuthApiError` (refresh token rejected) | 4xx | definitive | ✅ → login |

So both directions hold: a Hub blip no longer logs anyone out, and a genuinely dead session still
routes to `HUB_URL/login` (acceptance criterion b).

**Acceptance criteria from the original issue — all satisfied in code:**
- (a) Active user beyond access-token lifetime isn't bounced → proxy refreshes AND persists the
  child cookie (`refreshChildSession` + canonical `NextResponse.next({ request })`). *Still needs
  the manual end-to-end run (t9) — not verifiable from this repo.*
- (b) Genuinely unauthenticated users still redirected to `HUB_URL/login` → verified above.
- (c) Identity claims only ever from `getUser(access_token)` → confirmed by grep: `getUser` appears
  once, in `hub-session.ts:77`; `getClaims` appears only in `refresh-session.ts:82` where it drives
  refresh and grants nothing (the proxy is not an authorization boundary — `requireAppAccess` is).

Also confirmed: `tsc --noEmit` clean, no dead code (every helper has live callers), no import
cycles from the new `auth-error` / `hub-session → hub-callback` edges, and the `require-app-access`
`response.json()` is now inside the try/catch.

🟢 **Open items** (none blocking)
- `AuthInvalidTokenResponseError` carries status **500**, so it classifies as transient. Rare
  (malformed token response) and arguably the right call, but it means that specific anomaly
  preserves the session rather than clearing it. Noted, not changed.
- `session-cookie.ts:18` — `CHILD_COOKIE_NAME` still interpolated into a `RegExp` unescaped. Safe
  while the name is a literal constant; escape if it ever becomes configurable.
- **t8**: the Portal `/api/app-handoff` endpoint and its security review remain outstanding.
  `HOLY_AUTH_PROD_HANDOFF` must stay unset until both are done — production behaviour is unchanged
  until then, which is what makes this safe to merge now.
- **t9**: manual QA of the Slice 1 AC (localhost session surviving past the access-token TTL).

**Summary:** Approved. The architecture was right from the start; the two review rounds were both
about error *classification*, and that is now correct and verified against the library's own error
constructors rather than assumed. The merge is low-risk because the production path is unchanged
until the Portal endpoint lands behind its opt-in flag — what ships today is the dev/preview logout
fix plus outage resilience. Status → done.
