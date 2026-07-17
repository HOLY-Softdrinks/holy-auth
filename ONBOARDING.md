# Onboard a new app onto the HOLY Hub (Playbook B)

For a **Next.js + Supabase** app with little/no existing user data. This is the LIGHT path — no
user-id migration, no parallel-auth cutover, no decommission. If your app has lots of live users +
per-user data + its own roles to preserve, this is the wrong doc: you want the full retrofit
playbook (ask a Hub admin for the Grail retrofit handover).

Refined from the first live retrofit (HOLY Grail, 2026-07-17) — the gotchas below are real.

## What you're building

Your app stops doing its own login. Users sign in once at the Hub (https://apps.holy.com), click
your app's tile (or get redirected to the Hub if they hit your app signed-out), and land in your
app with a Hub-issued token. Your app keeps its OWN roles/data, keyed to the Hub user id. The Hub
decides *who can open your app* (a boolean grant); your app decides *what they can do inside*.

## Hub-side facts (fixed)

- **Hub:** https://apps.holy.com — issuer JWKS at `…/auth/v1/.well-known/jwks.json`, ES256. Token
  `sub` = the Hub user uuid.
- **Access API:** `GET https://apps.holy.com/api/access?app=<your-slug>` with the user's Hub Bearer
  token → `200 {ok,allowed}` / `401` / `404`. Revocation is immediate for app-level access.
- **Cookie hand-off:** the Hub session cookie lives on `.apps.holy.com`. Your app MUST be served
  from a `*.apps.holy.com` subdomain (e.g. `yourtool.apps.holy.com`) or it cannot read the session.

## Steps

### 1. Register your app in the Hub (ask a Hub admin, ~2 min)
An `apps` row: slug (lowercase-hyphen), name, url `https://<slug>.apps.holy.com`. Then grant the
initial users. If they've never logged into the Hub, the admin pre-provisions them by email so the
grant applies on their first Google login.

### 2. Trust the Hub on YOUR Supabase (one-time, Management API — NOT the dashboard)
The dashboard Third-Party Auth UI only lists Firebase/Clerk/WorkOS/Auth0/Cognito. Use the API with
a Supabase personal access token:
```
POST https://api.supabase.com/v1/projects/<your-ref>/config/auth/third-party-auth
{ "oidc_issuer_url": "https://xbeytzortgbwqruihxka.supabase.co/auth/v1" }
```
Verify with GET — a working response resolves the ES256 JWKS. Do NOT add a Google provider.

### 3. ⚠ Audit RLS BEFORE step 2 takes effect (this bit Grail)
The instant the Hub is trusted, EVERY Hub user (granted to your app or not) can call your Supabase
REST API as `authenticated` with just your public anon key. Any `to authenticated` / `USING (true)`
policy on sensitive data is exposed. Make sure every table's policies require a local profile row
(step 5), not bare `authenticated`; add `AS RESTRICTIVE` policies if unsure (additive, revertable).
For any `SECURITY DEFINER` function, `revoke execute from public` (not just `anon`) and re-grant to
`authenticated`/`service_role`.

### 4. Install `@holy/auth` + wire it
```bash
pnpm add "@holy/auth@github:HOLY-Softdrinks/holy-auth#semver:^0.2.0"
```
- `next.config.ts`: `transpilePackages: ['@holy/auth']`
- Env: `HUB_URL=https://apps.holy.com`, `APP_SLUG=<your-slug>`, plus your own
  `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` (+ `SUPABASE_SERVICE_ROLE_KEY` if you use `jitProvision`).
- `proxy.ts`: `export const proxy = createHubProxyGuard({ publicPaths: ['/'] })`
- Protected pages: `await requireAppAccess()` + `export const dynamic = 'force-dynamic'`.
- API routes / dual-auth: `checkAppAccess()` (returns a status, doesn't redirect).
- Data: `createHubClient<Database>()` — your Supabase, authed as the Hub user (RLS sees `auth.uid()`).

### 5. Build your role model FRESH, keyed to the Hub id
No legacy ids to migrate — key your profile/role table by the Hub uuid directly
(`hub_user_id uuid primary key` = `auth.uid()`), JIT-provisioned on first entry:
```ts
const hubUser = await requireAppAccess()
await jitProvision({ table: 'profiles', primaryKeyColumn: 'hub_user_id',
  row: { hub_user_id: hubUser.id, email: hubUser.email, full_name: hubUser.fullName } })
```
Seed your first admin in the DB. RLS keys on `(select auth.uid()) = hub_user_id`.

### 6. Deploy on `<slug>.apps.holy.com`
Add the subdomain to your Vercel project. **CI needs git auth for this private repo** — see the
README's "CI/CD" note for the `GH_DEPS_TOKEN` + install-command URL rewrite (Vercel/Actions runners
have no git credentials, so `pnpm install` fails without it).

## Verify (acceptance)
1. Granted user: Hub gallery → your tile → lands in your app, provisioned, correct role, RLS works.
2. Signed-out user hitting your app directly → bounced to Hub login → back after login.
3. Non-granted Hub user → Hub "Request access" screen.
4. Admin revokes the grant → user blocked on next navigation.
5. Before go-live: confirm no table answers a bare `authenticated` query it shouldn't (step 3).

## Known limitations (inherited; not your bug to fix)
- **No fleet-wide sign-out yet** — clearing your local session doesn't end the Hub session (shared
  cookie re-authenticates). Link to the Hub's logout for a real sign-out.
- **Access API is on your hot path** — `requireAppAccess` calls the Hub every navigation (makes
  revocation instant). You MAY cache the verdict ~60s if Hub latency matters (accepting slower
  revocation); don't cache longer without telling a Hub admin.
