# Portal contract — production app-session handoff (`GET /api/app-handoff`)

**For:** the `holy-hub` (Portal) repo · **Requested by:** `@holy/auth` (holy-auth repo), v0.5.0
**Status:** ready to implement · **Reviewed:** 2026-09-22
**Security gate:** this endpoint mints login tokens. It must not ship without the origin/path
validation in §3 reviewed by a second pair of eyes.

---

## 1. Why this endpoint exists

Child apps (`*.apps.holy.com`) gate themselves with `@holy/auth`. Until now they read the Portal's
**shared** session cookie (`sb-<ref>-auth-token` on `.apps.holy.com`) and had no way to refresh it,
so users were bounced to `/login` roughly hourly.

The fix is that each child app holds **its own** Supabase session — its own refresh-token family,
in its own host-only cookie — which it refreshes itself. Crucially, a child must **never** refresh
the Portal's shared token: Supabase applies refresh-token reuse detection, and a token rotated by
one child invalidates the copy every other child and the Portal hold, which revokes the whole
session ("users signed out at random"). Independent sessions remove that hazard by construction.

To get an independent session a child needs a fresh sign-in event. That is what this endpoint
provides: the Portal mints a **one-time magiclink token**, the child exchanges it with `verifyOtp`.

This is the production twin of the existing `/dev-handoff` flow. The difference:

| | `/dev-handoff` (existing) | `/api/app-handoff` (this) |
|---|---|---|
| Target origin | arbitrary localhost / preview host | **registry-verified** production origin |
| User interaction | human clicks "Continue to…" | **none** — silent 302 |

The confirm click exists in dev precisely *because* the origin can't be trusted. Here the registry
check replaces it — which is why §3 is load-bearing.

---

## 2. Request

```
GET /api/app-handoff?app=<slug>&next=<url>&return_to=<path>&state=<nonce>
```

| Param | Required | Meaning |
|---|---|---|
| `app` | yes | the child app's slug in the Portal registry (its `APP_SLUG`) |
| `next` | yes | absolute URL of the child's callback — `<registered-origin>/__hub/dev-callback` |
| `return_to` | yes | same-origin **relative** path to land on after the exchange |
| `state` | yes | opaque login-CSRF nonce minted by the child; echo back **verbatim** |

Notes:
- **`GET` only.** The child arrives here by browser redirect.
- `state` is the child's to validate, not the Portal's. Treat it as an opaque string, echo it
  unchanged, do not store or interpret it. Reject absurd lengths (> 200 chars) as malformed.
- ⚠️ **The callback path is `/__hub/dev-callback`**, not `/__hub/hub-callback`. The constant is
  named `HUB_CALLBACK_PATH` in `@holy/auth` but its value is kept as `/__hub/dev-callback` for
  backward compatibility with apps already routing that path. Use the literal above if you
  validate the path (§3.3).

---

## 3. Preconditions — ALL must hold before a token is minted

**3.1 Valid Portal session.** The request carries a live Portal session cookie. If not, this is
*not* an error — redirect to `/login?next=<this full app-handoff URL>` so the user signs in and
comes back here. This is the normal first-login path.

**3.2 `app` is registered and active** in the Portal app registry.

**3.3 `next` must match the app's registered production callback — origin AND path.**

This is the token-exfiltration guard and the single most important line of this document.

- Parse `next` as a URL. Compare `url.origin` for **exact equality** against the origin registered
  for `app` in the Portal's own server-side config. Never a substring, prefix, suffix, `startsWith`
  or regex match — `https://evil-myapp.apps.holy.com.attacker.tld` must fail.
- Also require `url.pathname === '/__hub/dev-callback'`. Origin-only validation is not enough: any
  open redirect or user-content path on an otherwise-legitimate app origin would become a token
  delivery vector.
- The registered origin comes from server-side config, **never** from the request.
- On failure: **do not mint a token.** Redirect to a Portal error page on the *Portal's* origin
  with a generic message, and log the rejection (without the token).

**3.4 `return_to` must be a same-origin relative path** — starts with `/`, not `//`, no backslashes.
Otherwise default it to `/`. (The child re-sanitizes this too, but validate here as well.)

---

## 4. Behaviour on success

1. Mint a **one-time magiclink token** (`token_hash`) for the currently signed-in Portal user,
   scoped so that `verifyOtp({ type: 'magiclink', token_hash })` on the child creates an
   **INDEPENDENT** session — its own refresh-token family, not an alias of the Portal's session.
   (This is the same property the existing `/dev-handoff` relies on; please confirm it holds in the
   production Supabase config — see §7.2.)
2. Token TTL: **short — 60 seconds or less** — and strictly single-use. It travels in a URL and
   will land in browser history and any intermediary logs.
3. Respond **302** to:
   ```
   <next>?token_hash=<hash>&state=<state>&return_to=<return_to>
   ```
   No confirm screen.
4. Set `Cache-Control: private, no-store` on the response.
5. Do not log the full redirect URL (it contains the token). Log `app`, user id and outcome only.

---

## 5. Child-session lifetime — needs a decision from the Portal team

Portal logout does **not** propagate to child sessions. This was explicitly accepted as a product
decision (the child holds an independent session, so ending the Portal's does not end it).

That makes the **refresh-token TTL of the minted child session the only bound** on how long a child
session can outlive a Portal logout. Please set it deliberately rather than inheriting a default.

- Proposal: **7 days** inactivity / absolute cap — to be confirmed.
- ⚠️ Open: the Hub project's current access-token JWT TTL was never confirmed during this work
  (it needs Supabase project access). Worth reading off the dashboard before fixing the number above.

If the product decision is ever reversed and true single-logout is wanted, the parked design is: a
user-level `sessions_valid_from` timestamp bumped on Portal logout, checked by `/api/access` (which
`@holy/auth` already calls on every protected render), rejecting child tokens issued before it.

---

## 6. What the child does (already implemented, for your context)

- Proxy detects: no child session cookie + a Portal cookie present + production → redirects here.
- `/__hub/dev-callback` validates the `state` nonce against an HttpOnly cookie, then `verifyOtp`s
  the `token_hash` into a **host-only** cookie named `holy-app-auth` (deliberately *not*
  `sb-<ref>-auth-token`, to avoid colliding with the Portal's cookie of the same name on the parent
  domain). The proxy refreshes that cookie on every subsequent navigation.
- **Loop guard:** the child attempts the silent handoff at most **once** per cycle. If it comes back
  still without a session it stops and sends the user to `/login` instead of retrying. So a
  persistently failing endpoint degrades to a normal login, not an infinite bounce — but it does
  mean failures should be fast and deterministic rather than flaky.
- The whole path is off by default behind `HOLY_AUTH_PROD_HANDOFF=1`, so nothing changes in
  production until this endpoint exists and is enabled.

---

## 7. Open questions for the Portal team

1. Exact refresh-token TTL for child sessions (§5).
2. Does magiclink `verifyOtp` guarantee an independent refresh-token family under the production
   Supabase config, as `/dev-handoff` assumes? Please confirm for production before enabling.
3. Where should registered production origins live — an existing app-registry row, or a new column?
   (§3.3 needs a single authoritative server-side source.)
