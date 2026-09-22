# F-001: Child-owned session refresh

**Scale:** Epic · **Status:** done (approved with notes, 2026-09-22) · **Owner:** planner → builder → reviewer
**Repos:** `holy-auth` (this) + `holy-hub` (Portal, one endpoint)

## Objective

Users working continuously inside a `@holy/auth`-gated app are redirected to the Portal login
roughly every hour. The package reads the Portal's shared session cookie but has no way to
refresh it, so when the ~1h access-token JWT expires the next protected render fails
verification and bounces the user.

This feature makes **every child app own its own Supabase session** — its own refresh-token
family, in its own host-scoped cookie — and refreshes that session in the proxy, which is the
only place in Next.js that can write cookies. No child ever rotates the Portal's shared token,
so there is no cross-app rotation collision.

## Why this design (and not the obvious one)

The tempting fix is "let the child write the refreshed cookie back". That is the risky path.
Supabase applies **refresh-token reuse detection**: a refresh token may be used once (plus a
~10s reuse interval and a parent-token exception). Supabase's own docs have a section titled
*"Why does refreshing in two places sign users out?"* — a reuse attempt outside those exceptions
revokes **the entire session**. With one shared `.apps.holy.com` cookie consumed by the Portal
and N child apps, having children rotate it turns an hourly redirect into session-wide random
logouts, which the docs note is *"hard to trace, because it looks like users being signed out at
random rather than an error in your code."*

Independent sessions remove the hazard by construction rather than by careful reasoning. This
is also the pattern this codebase already chose for localhost — `dev-callback.ts:8-10` mints an
independent session explicitly for *"own refresh-token family, no rotation collision with the
Portal session"*. F-001 extends that proven pattern to preview and production.

Second confirmed root cause, from the Supabase Next.js guide: *"Since Server Components can't
write cookies, you need a Proxy to refresh expired Auth tokens and store them."* `@holy/auth`
does its session work in `hub-session.ts` (a Server Component path, `setAll` no-op at line 34)
and keeps `proxy-guard.ts` deliberately "redirect-only". That is exactly the documented
anti-pattern whose stated symptom is *"sessions never refresh and users get signed out."*
Refresh must move into the proxy.

## Scope correction found during recon

`README.md:70` claims the localhost session *"refreshes on its own"*. It does not — the no-op
`setAll` in `hub-session.ts:34` applies in every environment. **Dev and preview sessions die at
the same 1-hour mark as production.** They are in scope, and because those sessions are already
independent, fixing them carries provably zero collision risk. That is why Slice 1 targets them.

## Target architecture

| Cookie | Name | Scope | Written by | Refreshed by |
|---|---|---|---|---|
| Portal session | `sb-<ref>-auth-token` | `.apps.holy.com` | Portal only | Portal only |
| Child session (new) | `holy-app-auth` | host-only, e.g. `myapp.apps.holy.com` | this child | this child's proxy |

The child session is **separately named** as well as host-only. This is load-bearing: both
cookies come from the same Supabase project, so a host-only `sb-<ref>-auth-token` on the child
host and the domain-wide one on `.apps.holy.com` would arrive under the same name and be
ambiguous to reassemble. Distinct name = no collision, and it keeps the existing
`startsWith('sb-<ref>-auth-token')` Portal-cookie probe in `proxy-guard.ts:42` correct.

Request flow in the proxy, in order:

1. Child cookie present → refresh it if needed, continue.
2. No child cookie, Portal cookie present (production) → **silent** handoff to the Portal, come
   back with a child session.
3. No child cookie, dev/preview → existing confirm-click handoff (origin is not registry-verified).
4. Neither → Portal `/login`.

`getHubSession()` reads the child cookie when present and **falls back to the Portal shared
cookie when absent**. That fallback is what keeps production working unchanged through Slices
1–2, and it remains the permanent safety net behind the kill-switch.

## Slices

```
Slice 1: Proxy-owned refresh for child-owned sessions (dev + preview)  — no dependencies
Slice 4: Portal-outage resilience (stale hub-meta)                     — no dependencies  [parallel with 1]
Slice 2: Stale-but-refreshable is not "unauthenticated"                — depends on Slice 1
Slice 3: Production handoff, silent (+ Portal endpoint)                — depends on Slice 1
Slice 5: Single logout / revocation                                    — depends on Slice 3
Slice 6: Docs + release                                                — depends on all
```

Slices 1 and 4 may run in parallel. Slice 3 is the only one blocked on the other repo.

---

## Tasks

### Slice 1 — Proxy-owned refresh for child-owned sessions
**AC:** On localhost, a developer stays signed in across the access-token expiry boundary
(verifiable by shortening the Hub project's JWT expiry, or by clock-skewing the token) without
being sent back to `/dev-handoff`.
**Complexity:** Medium

- [x] **1.1 — Child session cookie module**
  Files: `src/session-cookie.ts` (new)
  Change: export `CHILD_COOKIE_NAME = 'holy-app-auth'`, host-only cookie option builder
  (no `domain`, `httpOnly`, `sameSite: 'lax'`, `secure` when https, `path: '/'`), plus
  chunk-aware helpers `hasChildSessionCookie(jar)` / `isChildSessionCookie(name)` (+ `expireChildCookies`
  in refresh-session) that handle the `.0` / `.1` numbered-chunk suffixes.

- [x] **1.2 — Refresh helper**
  Files: `src/refresh-session.ts` (new)
  Change: `refreshChildSession(request, response)` builds a `createServerClient` over the child
  cookie name with `getAll` from `request.cookies` and a **real** `setAll` that writes to
  *both* `request.cookies` (so Server Components in the same pass see the fresh token and do not
  re-refresh) and `response.cookies` (so the browser replaces it) — the three responsibilities
  the Supabase Next.js guide lists. Calls `getClaims()`. Returns
  `'fresh' | 'refreshed' | 'absent' | 'invalid'`. Sets `Cache-Control: private, no-store` on the
  response when it wrote a cookie, per the Supabase advanced guide, so no CDN caches `Set-Cookie`.

- [x] **1.3 — Wire refresh into the proxy guard**
  Files: `src/proxy-guard.ts`, `src/index.ts`
  Change: call `refreshChildSession` before the public-path short-circuit for non-asset routes;
  on `'invalid'` clear the child cookie and fall through to the handoff branch. Export
  `refreshChildSession` and `CHILD_COOKIE_NAME` for the custom-proxy apps that v0.3.1 already
  caters to.

- [x] **1.4 — Dev callback writes the child-named cookie**
  Files: `src/dev-callback.ts`
  Change: pass the child cookie name + host-only options to the `createServerClient` used by
  `handleDevCallback`, so the session it mints is the one the proxy can refresh. Existing
  localhost devs get one extra confirm click on first run after upgrade; acceptable in dev.

- [x] **1.5 — Read the child session, fall back to the shared cookie**
  Files: `src/hub-session.ts`
  Change: `getHubSession()` prefers the child cookie; when absent, falls back to today's shared
  Portal cookie read (unchanged production behaviour). Keep `setAll` a no-op and **replace the
  comment at line 34** — it is no longer "children never write Hub cookies", it is "the proxy
  owns refresh; Server Components cannot write cookies".

### Slice 2 — Stale-but-refreshable is not "unauthenticated"
**AC:** A request whose access token is expired but whose refresh token is valid, arriving on a
path the proxy did not cover (e.g. an API route), does not produce a login redirect.
**Complexity:** Low

- [x] **2.1 — Distinguish the two failure modes**
  Files: `src/hub-session.ts`
  Change: have the session read report *why* it failed — no session at all vs. session present
  with a stale access token — instead of collapsing both to `null`.

- [x] **2.2 — Surface it in the access result**
  Files: `src/require-app-access.ts`, `src/index.ts`
  Change: add a `'stale'` variant to `AccessResult`. `requireAppAccess()` attempts a refresh
  path / re-entry rather than redirecting to login; `checkAppAccess()` exposes `'stale'` so API
  routes can return 401-with-retry instead of bouncing a user who is really still signed in.
  **Note:** widening the exported `AccessResult` union can break consumers doing exhaustive
  `switch`es — minor version bump and a changelog line.

### Slice 3 — Production handoff (silent) + Portal endpoint
**AC:** A user active continuously in a production child app for well beyond the access-token
lifetime (verify at >2h) is never redirected to login while the Portal session is valid.
**Complexity:** High · **Blocked on:** Portal endpoint (`holy-hub`)

- [x] **3.1 — Write the Portal endpoint contract**
  Files: `.pandaos/api-specs/portal-app-handoff.md` (new)
  Change: specify `GET /api/app-handoff` — inputs (`app`, `next`, `return_to`, `state`),
  Portal-side preconditions (valid Portal session; `app` registered; **`next` origin matches
  that app's registered production origin**), one-time magiclink token minting, redirect shape,
  and error branches. This is the security-critical document — see RISK-1.

- [x] **3.2 — Generalise the callback to a production mode**
  Files: `src/dev-callback.ts` → `src/hub-callback.ts`, `src/index.ts`
  Change: extract the shared exchange (state-nonce check → `verifyOtp` → write child cookie) into
  `handleHubCallback`, with dev/preview and production entry points over it. Keep the existing
  `DEV_CALLBACK_PATH` and the v0.3.1 exports as re-exports so custom-proxy apps do not break.
  Watch `max_file_lines: 300` — split rather than grow `hub-callback.ts`.

- [x] **3.3 — Proxy bootstrap ordering**
  Files: `src/proxy-guard.ts`
  Change: implement the 4-step order from *Target architecture*. Production silent handoff only
  when a Portal cookie is actually present, so genuinely signed-out users still go to `/login`
  and we never introduce a redirect loop. Guard against looping: if we return from a handoff
  still without a child cookie, fail to `/login` rather than re-entering the handoff.

- [x] **3.4 — Kill switch**
  Files: `src/config.ts`, `src/proxy-guard.ts`
  Change: `HOLY_AUTH_CHILD_SESSION=0` disables the child-session path entirely and restores the
  shared-cookie read. Cheap insurance for an auth change deployed across the whole fleet.

- [ ] **3.5 — Implement the Portal endpoint** *(other repo — `holy-hub`)*
  Change: build `/api/app-handoff` to 3.1. Must be click-free for registered production origins
  (the user confirmed a silent hop, not a confirm screen).

### Slice 4 — Portal-outage resilience
**AC:** With `HUB_URL/api/hub-meta` returning 500, an already-authenticated user keeps browsing
instead of hitting an error boundary.
**Complexity:** Low · Parallel with Slice 1

- [x] **4.1 — Serve stale meta on fetch failure**
  Files: `src/config.ts`
  Change: on a failed re-fetch after `META_TTL_MS` (5 min, line 12), keep serving the last good
  `cachedMeta` instead of throwing; only throw when there has never been a successful fetch. Add
  a hard ceiling so genuinely dead meta is not served forever, and log once on first staleness.

### Slice 5 — Accept the logout gap, bound it with token lifetime
**AC:** The independent-session logout behaviour is documented, and a child session's maximum
survival past Portal logout is a known, bounded number (the refresh-token TTL) rather than "until
the browser is closed".
**Complexity:** Low · Depends on Slice 3
**Resolved by DECISION-3:** Diego accepted that Portal logout does not end child sessions. No
Portal single-logout mechanism is built.

- [x] **5.1 — Bound and document the gap**
  Files: `.pandaos/api-specs/portal-app-handoff.md`, `README.md`, `ONBOARDING.md`
  Change: specify the child session's refresh-token TTL on the Portal endpoint so the worst-case
  survival window is explicit and short-ish rather than indefinite; document that Portal logout
  does not propagate to child apps and that each app's own sign-out (or TTL expiry) ends its
  session. No code change in this repo beyond docs. If a future product need reverses this,
  the `sessions_valid_from` design considered here is recorded in the log for pickup.

### Slice 6 — Docs + release
**AC:** README/ONBOARDING describe the real model, and no doc claims behaviour the code does not have.
**Complexity:** Low

- [x] **6.1 — Correct and document**
  Files: `README.md`, `ONBOARDING.md`, `package.json`
  Change: fix the false `README.md:70` refresh claim; document the two-cookie model, the
  Next 15 vs 16 proxy requirement (RISK-4), the kill switch, and the custom-proxy upgrade step;
  bump the version and add the migration note.

---

## Risks

**RISK-1 — Token exfiltration via the handoff `next` parameter**
*Impact:* Account takeover. An unvalidated `next` lets an attacker have the Portal mint a
one-time login token for the victim and deliver it to an attacker-controlled host.
*Likelihood:* low (if specified correctly) / high (if forgotten)
*Mitigation:* The Portal must validate `next`'s origin against the app registry — never a
substring or suffix match, a parsed-origin equality check. This mirrors the existing preview
rule (only HOLY's Vercel team suffix) and the login-CSRF `state` nonce already in
`dev-callback.ts:22`. Keep the `state` nonce in the production path too. Treat as the review gate
for Slice 3.

**RISK-2 — Cookie name/domain collision between child and Portal sessions**
*Impact:* Ambiguous cookie reassembly, intermittent logouts that look exactly like the bug we are fixing.
*Likelihood:* high if the child cookie keeps the default name
*Mitigation:* Distinct name (`holy-app-auth`) + host-only. Explicitly assert in Slice 1 that the
child cookie never carries a `domain` attribute.

**RISK-3 — `cookieOptions.name` API assumption**
*Impact:* Slice 1 design detail invalid.
*Likelihood:* low
*Mitigation:* `@supabase/ssr` is **not installed in this checkout**, so this was not verifiable
during planning — it is a Gate 0 check. Fallback if the option does not exist: we own `getAll` /
`setAll`, so we can map names in the adapter ourselves. Either way the design holds.

**RISK-4 — Next.js 15 apps never run `proxy.ts`**
*Impact:* Those apps silently get no refresh — the bug persists with no error.
*Likelihood:* medium — `package.json` declares `next: >=15.0.0` but the repo targets `proxy.ts` (Next 16).
*Mitigation:* Supabase documents this explicitly: on Next 15 and earlier the file is
`middleware.ts` and `proxy.ts` is never called. Decide in Slice 6 whether to narrow the peer
range to `>=16` or ship a `middleware.ts` entry point; either way document it loudly.

**RISK-5 — Custom-proxy apps miss the refresh step**
*Impact:* Apps that build their own proxy (supported since v0.3.1) keep the hourly logout.
*Likelihood:* medium
*Mitigation:* Export `refreshChildSession`, document the one-line addition, and consider a
dev-only console warning when a protected render sees a child cookie the proxy never refreshed.

**RISK-6 — Chunked cookies**
*Impact:* Large sessions split across `…-auth-token.0/.1`; a dropped chunk breaks reassembly → logout.
*Likelihood:* low-medium
*Mitigation:* Chunk-aware read/clear helpers in task 1.1; when clearing, clear every chunk, not
just the base name. Reported as aggravator #2 in the original issue.

**RISK-7 — Concurrent refresh inside one child**
*Impact:* Parallel server requests both refresh the same child token.
*Likelihood:* low
*Mitigation:* Covered by Supabase's ~10s reuse interval, which exists for exactly this SSR case.
No locking needed; do not build any.

## Checkpoint Gates

- **Gate 0 — Recon complete.** Confirm `@supabase/ssr` supports `cookieOptions.name` (RISK-3) and
  confirm the Hub project's actual access-token TTL. Install deps first.
- **Gate 1 — Slice 1 passes.** Dev session survives expiry. *This proves the whole approach*: if
  proxy-owned refresh works for the independent dev session, the production slice is the same
  mechanism with a different bootstrap.
- **Gate 2 — Slices 2 + 4 pass.** No regression to the existing redirect behaviour for genuinely
  signed-out users.
- **Gate 3 — Slice 3 security review.** RISK-1 origin validation verified in the Portal before
  the endpoint ships. Non-negotiable.
- **Gate 4 — Slice 3 passes.** >2h continuous production session, no login redirect.
- **Gate Final — Acceptance criteria from the issue, re-verified:** (a) long-active user not
  redirected; (b) genuinely unauthenticated users still redirected to `HUB_URL/login`;
  (c) identity claims still come only from `getUser(access_token)`, never from the
  attacker-writable cookie `user` object (`hub-session.ts:16-21` — this property must survive
  every slice).

## Decisions

**DECISION-1 — Independent session per child, not shared-cookie refresh.**
Rationale in *Why this design*. Cost: one extra silent redirect on first entry to each app
(user-approved). Benefit: the rotation-collision class of bug becomes structurally impossible
rather than carefully avoided.

**DECISION-2 — Refresh lives in the proxy, not in `getHubSession()`.**
Forced by Next.js: Server Components cannot write cookies. This makes the existing no-op `setAll`
*correct* rather than broken — but only once the proxy does the work, and only for apps whose
proxy actually runs (RISK-4, RISK-5).

**DECISION-3 — Portal logout does not end child sessions. Accepted.** *(resolved 2026-09-21, Diego)*
Independent sessions mean Portal logout no longer implies child logout. Diego confirmed this is
fine. No single-logout mechanism is built; Slice 5 instead bounds the window with a defined
child-token TTL and documents the behaviour. The `sessions_valid_from` alternative is recorded in
the log should the product decision reverse later.

**DECISION-4 — The shared-cookie read stays as a fallback.** Not dead code: it is what keeps
production working during Slices 1–2 and it backs the `HOLY_AUTH_CHILD_SESSION=0` kill switch.

## Anti-rationalization check

Run against the skill's shortcut table:

- **"Build the foundation first."** Tempting here — a types/cookie-module-first pass across all
  files. Rejected: Slice 1 ships a working refresh for real users (developers and preview) rather
  than scaffolding. Each later slice carries its own foundation piece.
- **"Handle edge cases later."** Chunked cookies (RISK-6) and redirect-loop protection (task 3.3)
  are inside the slices that own that code, not deferred to a cleanup pass.
- **"Simple enough for one task."** Slice 3 was deliberately split into 5 tasks; the callback
  generalisation alone touches the security-critical exchange path.
- **"Testing at the end."** Every slice has a single verifiable AC and a gate. Gate 1 exists
  specifically to prove the mechanism before the expensive cross-repo slice starts.
- ⚠️ **Flagged:** task 3.2 renames `dev-callback.ts` → `hub-callback.ts` while changing its
  behaviour. Rename and behaviour change in one diff hides the security-relevant delta in a
  rename. **Builder must do the pure rename + re-exports as a separate commit from the
  production-mode logic.**
