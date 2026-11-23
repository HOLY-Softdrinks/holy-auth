// Test-only resolver: the package ships TypeScript source with extensionless
// relative imports and Next subpaths, which Node's native resolver cannot load.
// Why: keep tests on the built-in runner with no loader dependency.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NEXT_SUBPATHS = new Set(['next/server', 'next/headers', 'next/navigation'])
const srcDir = new URL('../src/', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (NEXT_SUBPATHS.has(specifier)) return nextResolve(`${specifier}.js`, context)
    if (specifier.startsWith('./') && context.parentURL?.startsWith(srcDir.href)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (!specifier.endsWith('.ts') && existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
