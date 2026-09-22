# @holy/auth

HOLY fleet auth for child apps. No Google, no OAuth wiring — trust the Portal.

**Connecting an app? Start with [ONBOARDING.md](./ONBOARDING.md)** — the step-by-step guide, with a
path for apps that have no login yet and a path for apps already using Supabase + Google auth.

## Setup (the whole thing)

Installed as a git dependency (public repo — clones anonymously, no token needed
anywhere: local, Vercel, and GitHub Actions all just work):

```bash
pnpm add "@holy/auth@github:HOLY-Softdrinks/holy-auth#semver:^0.5.0"
```

The package ships TypeScript source, so add it to `transpilePackages` in
`next.config.ts`:

```ts
const nextConfig = { transpilePackages: ['@holy/auth'] }
```

```env
HUB_URL=https://apps.holy.com        # the Portal
APP_SLUG=my-app                      # this app's slug in the Portal registry
# plus your app's own Supabase (standard):
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        # only if you use jitProvision()
```

One-time on your Supabase project (no Google provider!): register the Portal as a
third-party issuer — see [ONBOARDING.md](./ONBOARDING.md) Step B.

## Usage

```ts
// proxy.ts
import { createHubProxyGuard } from '@holy/auth'
export const proxy = createHubProxyGuard({ publicPaths: ['/'] })

// app/protected/page.tsx
import { requireAppAccess, createHubClient } from '@holy/auth'
const hubUser = await requireAppAccess()          // login + grant check, or redirect
const supabase = createHubClient<Database>()      // your DB, RLS sees the Portal user
```

## Vercel previews (v0.4.0+)

Preview deployments can't read the Hub cookie either. When `VERCEL_ENV=preview`, the
proxy guard runs the same handoff automatically: open a protected page on the preview →
confirm on the Portal → signed in on that preview host. The Portal only accepts preview
targets on HOLY's own Vercel team suffix, and each new preview URL needs one fresh
confirm click. Custom proxies: gate on `isDevHandoffRequest(request)` (covers localhost
dev AND previews), not `isLocalDevRequest`.

## Local development (v0.3.0+)

Production auth works by cookie sharing on `.apps.holy.com`, which localhost can't read.
You do NOT need to run the Portal locally. With `NODE_ENV=development` on
`localhost`/`127.0.0.1`, the proxy guard runs a dev-login handoff automatically:

1. Hit any protected page → you're sent to the Portal's `/dev-handoff` confirm screen
2. Click **Continue to localhost:PORT** → the Portal mints a one-time login token
3. The guard exchanges it at `/__hub/dev-callback` into an independent Hub session
   cookie on localhost, and drops you back on the page you wanted

Keep `HUB_URL=https://apps.holy.com` in `.env.local` — same value as production.
The token is single-use; the resulting localhost session is the child's own
(`holy-app-auth`, host-only) and the **proxy refreshes it on every navigation**,
so it outlives the ~1h access-token lifetime and never interferes with your Portal
session. Only confirm handoffs for apps you are running yourself.

## How the session works (v0.5.0+)

Each child app holds its **own** Hub session in a host-only cookie named
`holy-app-auth` — separate from the Portal's shared `sb-<ref>-auth-token` on
`.apps.holy.com`. The proxy refreshes that child session (it's the only place
Next.js lets you write cookies), using an independent refresh-token family, so a
child never rotates the Portal's shared token. That's what stops the old
~hourly logout.

- **Requires Next.js 16** (`proxy.ts`). On Next 15 the proxy file never runs, so
  the session can't refresh — the peer range is `next >=16` for this reason.
- **Custom proxies:** call `refreshChildSession(request, response)` early in your
  proxy (before returning) so the session refreshes. Route `HUB_CALLBACK_PATH`
  to `handleHubCallback`.
- **Kill switch:** set `HOLY_AUTH_CHILD_SESSION=0` to disable the child-session
  path entirely and revert to reading the Portal's shared cookie.
- **Production handoff** (each app minting its own session on first entry) is
  opt-in via `HOLY_AUTH_PROD_HANDOFF=1`, and only after the Portal's
  `/api/app-handoff` endpoint is deployed. Until then production reads the shared
  cookie exactly as before.
- **Portal logout does not end child sessions.** A child session lives until it
  expires or the app signs out locally (accepted trade-off — see ONBOARDING). How long
  it can live is set by the Hub Supabase project's session-lifetime setting, which is
  **shared by the Portal and every child app** (they use one project), so it can't be
  tuned per app.
