# @holy/auth

HOLY fleet auth for child apps. No Google, no OAuth wiring — trust the Hub.

**Connecting an app? Start with [ONBOARDING.md](./ONBOARDING.md)** — the step-by-step guide, with a
path for apps that have no login yet and a path for apps already using Supabase + Google auth.

## Setup (the whole thing)

Installed as a git dependency (public repo — clones anonymously, no token needed
anywhere: local, Vercel, and GitHub Actions all just work):

```bash
pnpm add "@holy/auth@github:HOLY-Softdrinks/holy-auth#semver:^0.2.0"
```

The package ships TypeScript source, so add it to `transpilePackages` in
`next.config.ts`:

```ts
const nextConfig = { transpilePackages: ['@holy/auth'] }
```

```env
HUB_URL=https://apps.holy.com        # the Hub
APP_SLUG=my-app                      # this app's slug in the Hub registry
# plus your app's own Supabase (standard):
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...        # only if you use jitProvision()
```

One-time on your Supabase project (no Google provider!): register the Hub as a
third-party issuer — see ADR-001 in the holy-hub repo.

Next config: `transpilePackages: ['@holy/auth']` (the package ships TS source).

## Usage

```ts
// proxy.ts
import { createHubProxyGuard } from '@holy/auth'
export const proxy = createHubProxyGuard({ publicPaths: ['/'] })

// app/protected/page.tsx
import { requireAppAccess, createHubClient } from '@holy/auth'
const hubUser = await requireAppAccess()          // login + grant check, or redirect
const supabase = createHubClient<Database>()      // your DB, RLS sees the Hub user
```
