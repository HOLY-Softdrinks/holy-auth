# Connect your app to the HOLY Hub

The **HOLY Hub** (https://apps.holy.com) is the central login for internal HOLY apps. Your app stops
running its own Google/OAuth login and instead **trusts the Hub**: people sign in once at the Hub,
and your app receives a Hub-issued identity. The Hub decides **who may open your app** (a simple
per-user grant); your app keeps its **own roles and data**, keyed to the Hub user id.

This repo is everything you need. It targets **Next.js (App Router) + Supabase** apps.

Pick your path:
- **Path 1 — your app has no login yet.** Greenfield. Shortest.
- **Path 2 — your app already has Supabase Auth + Google login.** You migrate onto the Hub while
  keeping your existing data and roles. Same steps whether you have a few test users or many — more
  users just means more care in the id mapping.

---

## What only a Hub admin can do (request these)

You cannot do these from your side — ask whoever runs the Hub:

1. **Register your app** — they add it to the Hub with a `slug` (lowercase-hyphen, e.g. `my-tool`)
   and expect it at `https://<slug>.apps.holy.com`.
2. **Grant your initial users** — by email. They don't need to have logged into the Hub before;
   the admin can pre-create them so the grant applies on their first login.

Everything else below you do yourself.

## Hub facts (fixed)

- **Hub:** https://apps.holy.com — issuer is ES256, JWKS at `…/auth/v1/.well-known/jwks.json`.
  The token `sub` claim is the Hub user's uuid — this is the id you key your data to.
- **Access API:** `GET https://apps.holy.com/api/access?app=<your-slug>` with the user's Hub Bearer
  token → `200 {ok:true,allowed:boolean}` / `401` / `404`. Revocation is reflected immediately.
- **Session hand-off:** the Hub session cookie is scoped to `.apps.holy.com`. Your app **must** be
  served from a `<slug>.apps.holy.com` subdomain, or it cannot read the Hub session.

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
  authenticated as the Hub user, so your RLS sees `auth.uid()` = the Hub uuid.

**Exports:** `requireAppAccess()`, `checkAppAccess()`, `getHubSession()`, `createHubClient<Db>()`,
`jitProvision()`, `createHubProxyGuard()`.

## Step B — Trust the Hub on your Supabase (both paths)

The Supabase dashboard's Third-Party Auth UI only lists Firebase/Clerk/WorkOS/Auth0/Cognito, so this
must be done via the Management API with a Supabase personal access token:

```
POST https://api.supabase.com/v1/projects/<your-project-ref>/config/auth/third-party-auth
{ "oidc_issuer_url": "https://xbeytzortgbwqruihxka.supabase.co/auth/v1" }
```
Verify with a `GET` on the same path — a working response resolves the Hub's ES256 JWKS. Do **not**
add or keep a Google provider as the primary path (Path 2 removes it at the end).

### ⚠ Do this BEFORE Step B takes effect: audit your RLS
The moment the Hub is trusted, **every** Hub user (whether granted your app or not) can call your
Supabase REST API as the `authenticated` role using just your public anon key. Any policy that is
`to authenticated` with `USING (true)` (or otherwise not scoped to the specific user) is now exposed.
Before registering trust, make sure every table's policies require the caller to be a real user of
*your* app (a row in your profile table — see the paths below), not merely `authenticated`. If in
doubt, add `AS RESTRICTIVE` policies requiring that profile row — they're additive and instantly
revertable. Also: for any `SECURITY DEFINER` function, `revoke execute from public` (not just
`anon`) and re-grant to `authenticated`/`service_role`.

---

## Path 1 — No existing login

Build your role model fresh, keyed to the Hub id.

1. Create a profile/roles table keyed by the Hub uuid: `hub_user_id uuid primary key` (= `auth.uid()`
   under a Hub token). Add whatever role columns you need.
2. RLS policies key on `(select auth.uid()) = hub_user_id`.
3. JIT-provision the profile on first entry:
   ```ts
   const hubUser = await requireAppAccess()
   await jitProvision({
     table: 'profiles', primaryKeyColumn: 'hub_user_id',
     row: { hub_user_id: hubUser.id, email: hubUser.email, full_name: hubUser.fullName },
   })
   ```
4. Seed your first admin directly in the DB (or a "first user becomes admin" rule).

Done — skip to **Deploy**.

---

## Path 2 — You already have Supabase Auth + Google login

Goal: move onto the Hub **without losing your data or roles**, with the old login staying available
as a fallback until you're confident. Do it additively; nothing destructive until the final step.

Your tables currently reference your local `auth.users(id)` and your RLS uses `auth.uid()` = that
local id. Under a Hub token, `auth.uid()` becomes the **Hub** uuid, which is different. You bridge
the two, then cut over.

1. **Keep both logins live.** Register Hub trust (Step B) but leave your Google provider in place for
   now. Both work simultaneously.
2. **Add a `hub_user_id` column** (nullable, uuid) to every table that references a user — alongside
   the existing local user-id column. Don't drop anything yet.
3. **Map old → Hub ids.** Match each of your existing users to their Hub identity by `google_sub`
   (most reliable) with email as fallback. The Hub exposes each user's `google_sub`, so ask the Hub
   admin for the mapping of your granted users, or read it from the token on first Hub login. Persist
   the mapping in a service-role-only table and **produce an explicit report of any unmatched users**
   — never silently drop them. (With a handful of test users this is quick; the same step scales.)
4. **Backfill `hub_user_id`** from the mapping. ⚠ If you backfill several columns/tables, use
   separate `UPDATE` statements — two `UPDATE`s to the same table inside one CTE will silently skip
   rows the first one touched.
5. **Add new RLS policies keyed on `(select auth.uid()) = hub_user_id`, alongside the existing ones**
   (both live during transition). If you have a `SECURITY DEFINER` helper like `is_admin()` that many
   policies call, re-key **that one function** to look up by `hub_user_id` — it re-keys every
   dependent policy at once. Tip: if you key *new* profile rows by the Hub uuid itself
   (`id = hub_user_id`), your legacy `id = auth.uid()` policies keep matching under Hub tokens with
   no change.
6. **Relax foreign keys** that point at your local `auth.users` (profile id, any `user_id`,
   `created_by`, etc.) — Hub-only users have no row in your local `auth.users`. This is a constraint
   change, no data change.
7. **Cut over.** Point your default login at the Hub (`requireAppAccess` / `createHubClient`), gated
   by an env flag (e.g. `HUB_LOGIN_DEFAULT=true`) so you can flip back instantly. Verify a real user
   end to end: Hub → your app → correct role → RLS correct → revoke in Hub blocks them.
8. **Decommission** only after a safe rollback window: remove the Google provider and old login UI,
   then drop the old user-id columns, the mapping table, and the superseded RLS policies.

---

## Deploy

Add `<slug>.apps.holy.com` as a domain on your Vercel project. `pnpm install` pulls `@holy/auth`
anonymously (public repo), so no build-time secrets are needed.

## Verify (acceptance)

1. A granted user reaches your app via the Hub, is provisioned, gets the right role, RLS works.
2. A signed-out visitor to your app is redirected to the Hub login and returns after signing in.
3. A Hub user without a grant hits the Hub "Request access" screen.
4. An admin revokes the grant in the Hub → the user is blocked on their next navigation.
5. Before go-live: confirm no table answers a bare `authenticated` query it shouldn't (the RLS audit).

## Known limitations (inherited; not your bug to fix)

- **No fleet-wide sign-out yet.** Clearing your app's local session doesn't end the Hub session; the
  shared cookie re-authenticates on the next visit. Link to the Hub's logout for a true sign-out.
- **The Access API is on your request hot path.** `requireAppAccess` calls the Hub on every
  navigation (that's what makes revocation instant). If Hub latency matters you may cache the verdict
  for ~60s (accepting slower revocation); don't cache longer without checking with a Hub admin.
