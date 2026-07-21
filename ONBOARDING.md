# Connect your app to the HOLY Portal

The **HOLY Portal** (https://apps.holy.com) is the central login for internal HOLY apps. Your app stops
running its own Google/OAuth login and instead **trusts the Portal**: people sign in once at the Portal,
and your app receives a Portal-issued identity. The Portal decides **who may open your app** (a simple
per-user grant); your app keeps its **own roles and data**, keyed to the Portal user id.

This repo is everything you need. It targets **Next.js (App Router) + Supabase** apps.

Pick your path:
- **Path 1 — your app has no login yet.** Greenfield. Shortest.
- **Path 2 — your app already has Supabase Auth + Google login.** You migrate onto the Portal while
  keeping your existing data and roles. Same steps whether you have a few test users or many — more
  users just means more care in the id mapping.

---

## What only a Portal admin can do (request these)

You cannot do these from your side — ask whoever runs the Portal:

1. **Register your app** — they add it to the Portal with a `slug` (lowercase-hyphen, e.g. `my-tool`)
   and expect it at `https://<slug>.apps.holy.com`.
2. **Grant your initial users** — by email. They don't need to have logged into the Portal before;
   the admin can pre-create them so the grant applies on their first login.

Everything else below you do yourself.

## Portal facts (fixed)

- **Portal:** https://apps.holy.com — issuer is ES256, JWKS at `…/auth/v1/.well-known/jwks.json`.
  The token `sub` claim is the Portal user's uuid — this is the id you key your data to.
- **Access API:** `GET https://apps.holy.com/api/access?app=<your-slug>` with the user's Portal Bearer
  token → `200 {ok:true,allowed:boolean}` / `401` / `404`. Revocation is reflected immediately.
- **Session hand-off:** the Portal session cookie is scoped to `.apps.holy.com`. Your app **must** be
  served from a `<slug>.apps.holy.com` subdomain, or it cannot read the Portal session.

---

## Step A — Install and wire `@holy/auth` (both paths)

```bash
pnpm add "@holy/auth@github:HOLY-Softdrinks/holy-auth#semver:^0.2.0"
```

Public repo — clones with no token, in local dev, Vercel, and GitHub Actions alike.

- `next.config.ts`: `transpilePackages: ['@holy/auth']` (the package ships TypeScript source).
- Env vars:
  ```env
  HUB_URL=https://apps.holy.com
  APP_SLUG=<your-slug>
  NEXT_PUBLIC_SUPABASE_URL=...        # your app's own Supabase
  NEXT_PUBLIC_SUPABASE_ANON_KEY=...
  SUPABASE_SERVICE_ROLE_KEY=...       # only if you use jitProvision()
  ```
- `proxy.ts`: `export const proxy = createHubProxyGuard({ publicPaths: ['/'] })`
- Protected pages (Server Components): `const hubUser = await requireAppAccess()` and add
  `export const dynamic = 'force-dynamic'`.
- API routes / anywhere you must NOT redirect: `const result = await checkAppAccess()` and branch on
  `result.status` (`authorized` / `unauthenticated` / `forbidden` / `error`).
- Data access: `const supabase = createHubClient<Database>()` — talks to **your** Supabase,
  authenticated as the Portal user, so your RLS sees `auth.uid()` = the Portal uuid.

**Exports:** `requireAppAccess()`, `checkAppAccess()`, `getHubSession()`, `createHubClient<Db>()`,
`jitProvision()`, `createHubProxyGuard()`.

## Step B — Trust the Portal on your Supabase (both paths)

The Supabase dashboard's Third-Party Auth UI only lists Firebase/Clerk/WorkOS/Auth0/Cognito, so this
must be done via the Management API with a Supabase personal access token:

```
POST https://api.supabase.com/v1/projects/<your-project-ref>/config/auth/third-party-auth
{ "oidc_issuer_url": "https://xbeytzortgbwqruihxka.supabase.co/auth/v1" }
```
Verify with a `GET` on the same path — a working response resolves the Portal's ES256 JWKS. Do **not**
add or keep a Google provider as the primary path (Path 2 removes it at the end).

### ⚠ Do this BEFORE Step B takes effect: audit your RLS
The moment the Portal is trusted, **every** Portal user (whether granted your app or not) can call your
Supabase REST API as the `authenticated` role using just your public anon key. Any policy that is
`to authenticated` with `USING (true)` (or otherwise not scoped to the specific user) is now exposed.
Before registering trust, make sure every table's policies require the caller to be a real user of
*your* app (a row in your profile table — see the paths below), not merely `authenticated`. If in
doubt, add `AS RESTRICTIVE` policies requiring that profile row — they're additive and instantly
revertable. Also: for any `SECURITY DEFINER` function, `revoke execute from public` (not just
`anon`) and re-grant to `authenticated`/`service_role`.

---

## Path 1 — No existing login

Build your role model fresh, keyed to the Portal id.

1. Create a profile/roles table keyed by the Portal uuid: `hub_user_id uuid primary key` (= `auth.uid()`
   under a Portal token). Add whatever role columns you need.
2. RLS policies key on `(select auth.uid()) = hub_user_id`.
3. JIT-provision the profile on first entry — and **use the row it returns**:
   ```ts
   const hubUser = await requireAppAccess()
   const provisioned = await jitProvision({
     table: 'profiles', primaryKeyColumn: 'hub_user_id',
     row: { hub_user_id: hubUser.id, email: hubUser.email, full_name: hubUser.fullName },
   })
   if (!provisioned.ok) throw new Error('Profile setup failed')
   const profile = provisioned.row   // ← use this; see warning below
   ```

   > ⚠ **First-login gotcha:** do NOT provision and then immediately *re-query* the profile
   > through the RLS-scoped client in the same request. That read-after-write crosses two
   > different DB clients and can come back empty on the very first login — your app then
   > wrongly shows "no access / not invited", and the second attempt works. Use the row
   > `jitProvision` returns (it reads back with the same service client), and always upsert
   > (never insert) so layout + page provisioning in parallel can't collide on the primary key.

4. Seed your first admin directly in the DB (or a "first user becomes admin" rule).

Done — skip to **Deploy**.

---

## Path 2 — You already have Supabase Auth + Google login

Goal: move onto the Portal **without losing your data or roles**, with the old login staying available
as a fallback until you're confident. Do it additively; nothing destructive until the final step.

Your tables currently reference your local `auth.users(id)` and your RLS uses `auth.uid()` = that
local id. Under a Portal token, `auth.uid()` becomes the **Portal** uuid, which is different. You bridge
the two, then cut over.

1. **Keep both logins live.** Register Portal trust (Step B) but leave your Google provider in place for
   now. Both work simultaneously.
2. **Add a `hub_user_id` column** (nullable, uuid) to every table that references a user — alongside
   the existing local user-id column. Don't drop anything yet.
3. **Map old → Portal ids.** Match each of your existing users to their Portal identity by `google_sub`
   (most reliable) with email as fallback. The Portal exposes each user's `google_sub`, so ask the Portal
   admin for the mapping of your granted users, or read it from the token on first Portal login. Persist
   the mapping in a service-role-only table and **produce an explicit report of any unmatched users**
   — never silently drop them. (With a handful of test users this is quick; the same step scales.)
4. **Backfill `hub_user_id`** from the mapping. ⚠ If you backfill several columns/tables, use
   separate `UPDATE` statements — two `UPDATE`s to the same table inside one CTE will silently skip
   rows the first one touched.
5. **Add new RLS policies keyed on `(select auth.uid()) = hub_user_id`, alongside the existing ones**
   (both live during transition). If you have a `SECURITY DEFINER` helper like `is_admin()` that many
   policies call, re-key **that one function** to look up by `hub_user_id` — it re-keys every
   dependent policy at once. Tip: if you key *new* profile rows by the Portal uuid itself
   (`id = hub_user_id`), your legacy `id = auth.uid()` policies keep matching under Portal tokens with
   no change.
6. **Relax foreign keys** that point at your local `auth.users` (profile id, any `user_id`,
   `created_by`, etc.) — Portal-only users have no row in your local `auth.users`. This is a constraint
   change, no data change.
7. **Cut over.** If you JIT-provision profiles on first Portal entry, use the row `jitProvision`
   returns — see the first-login gotcha in Path 1 step 3 (re-querying through the RLS client right
   after provisioning can miss the fresh row and wrongly show "no access").
   Point your default login at the Portal (`requireAppAccess` / `createHubClient`), gated
   by an env flag (e.g. `HUB_LOGIN_DEFAULT=true`) so you can flip back instantly. Verify a real user
   end to end: Portal → your app → correct role → RLS correct → revoke in the Portal blocks them.
8. **Decommission** only after a safe rollback window: remove the Google provider and old login UI,
   then drop the old user-id columns, the mapping table, and the superseded RLS policies.

---

## Local development (no local Portal needed)

Production auth is cookie sharing on `.apps.holy.com` — your app on `localhost` can never read
that cookie, so plain login is impossible there. From `@holy/auth` v0.3.0 the proxy guard solves
this automatically when `NODE_ENV=development` and the request host is `localhost`/`127.0.0.1`:

1. You open a protected page → the guard sends you to the Portal's `/dev-handoff` confirm screen
   (log in there normally if you aren't yet).
2. You click **Continue to localhost:PORT** → the Portal mints a one-time login token and
   redirects to `/__hub/dev-callback` on your app.
3. The guard exchanges the token into an independent Hub session cookie on localhost and drops
   you on the page you asked for.

Notes:
- Keep `HUB_URL` and `APP_SLUG` exactly as in production. Your app must be registered in the
  Portal (status `development` is fine) and you need a grant for it — otherwise you'll land on
  the Portal's "Request access" screen, which is the system working, not a bug.
- The token is single-use and short-lived. The localhost session is independent of your Portal
  session (own refresh-token family) — signing out of one does not affect the other.
- Only confirm a handoff for an app you are running yourself.
- **Vercel previews work the same way** (v0.4.0+): with `VERCEL_ENV=preview` the guard
  runs the identical handoff on `*.vercel.app` preview URLs. The Portal only hands tokens
  to hosts on HOLY's own Vercel team suffix, so previews must be deployed inside the HOLY
  team. Each new preview URL is a new host → one fresh confirm click per deployment.

## Deploy

Add `<slug>.apps.holy.com` as a domain on your Vercel project. `pnpm install` pulls `@holy/auth`
anonymously (public repo), so no build-time secrets are needed.

## Verify (acceptance)

1. A granted user reaches your app via the Portal, is provisioned, gets the right role, RLS works.
2. A signed-out visitor to your app is redirected to the Portal login and returns after signing in.
3. A Portal user without a grant hits the Portal "Request access" screen.
4. An admin revokes the grant in the Portal → the user is blocked on their next navigation.
5. Before go-live: confirm no table answers a bare `authenticated` query it shouldn't (the RLS audit).

## Known limitations (inherited; not your bug to fix)

- **No fleet-wide sign-out yet.** Clearing your app's local session doesn't end the Portal session; the
  shared cookie re-authenticates on the next visit. Link to the Portal's logout for a true sign-out.
- **The Access API is on your request hot path.** `requireAppAccess` calls the Portal on every
  navigation (that's what makes revocation instant). If Portal latency matters you may cache the verdict
  for ~60s (accepting slower revocation); don't cache longer without checking with a Portal admin.
