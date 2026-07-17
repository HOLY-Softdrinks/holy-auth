# @holy/auth

HOLY fleet auth for child apps. No Google, no OAuth wiring — trust the Hub.

## Setup (the whole thing)

```bash
pnpm add @holy/auth
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
