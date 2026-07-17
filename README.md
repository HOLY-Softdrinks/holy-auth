# @holy/auth

HOLY fleet auth for child apps. No Google, no OAuth wiring — trust the Hub.

## Setup (the whole thing)

Installed as a git dependency (private repo):

```bash
pnpm add "@holy/auth@github:HOLY-Softdrinks/holy-auth#semver:^0.2.0"
```

⚠ CI/CD needs git credentials for the private repo. Local dev works with your
gh auth, but Vercel build containers and GitHub Actions runners do NOT — `pnpm
install` fails with "could not read Username". Per-app fix (proven in HOLY Grail):
create a fine-grained PAT (Contents: read-only, ONLY the holy-auth repo), expose
it as `GH_DEPS_TOKEN`, and rewrite the git URL in the install step:

```json
// vercel.json
{ "installCommand": "git config --global url.\"https://x-access-token:${GH_DEPS_TOKEN}@github.com/HOLY-Softdrinks/\".insteadOf \"https://github.com/HOLY-Softdrinks/\" && pnpm install" }
```

(Add the same rewrite + a repo secret to any GitHub Actions workflow.) Longer
term this trick goes away by publishing to GitHub Packages (npm) — recommended
before onboarding more apps.

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
