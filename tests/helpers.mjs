import { mock } from 'node:test'

// Shared state the mocked boundary reads, so a test can steer verifyOtp.
// getSession: optional fake for the Hub client's getSession. cookies: what
// next/headers returns for the current request.
export const boundary = { verifyOtpError: null, fetchCalls: [], getSession: null, cookies: [], requestHeaders: {} }

const srcUrl = (name) => new URL(`../src/${name}.ts`, import.meta.url).href

// No real Portal, Supabase or credentials: HUB_URL points at a dead local port
// and any fetch that slips through fails the test loudly.
export function isolate() {
  process.env.NODE_ENV = 'development'
  process.env.HUB_URL = 'http://127.0.0.1:1'
  process.env.APP_SLUG = 'test-app'
  delete process.env.VERCEL_ENV
  globalThis.fetch = async (input) => {
    boundary.fetchCalls.push(String(input))
    throw new Error(`unexpected network call: ${String(input)}`)
  }
}

let mocked = null

// Mock the network-facing edges once per process (modules can only be mocked once).
async function installMocks() {
  isolate()
  const realConfig = await import(srcUrl('config'))
  mock.module(srcUrl('config'), {
    exports: {
      ...realConfig,
      getHubMeta: async () => ({
        supabaseUrl: 'http://127.0.0.1:1',
        supabaseAnonKey: 'test-anon-key',
        issuer: 'http://127.0.0.1:1',
      }),
    },
  })
  mock.module('@supabase/ssr', {
    exports: {
      createServerClient: () => ({
        auth: {
          verifyOtp: async () => ({ error: boundary.verifyOtpError }),
          getSession: async () =>
            boundary.getSession ? boundary.getSession() : { data: { session: null }, error: null },
          getUser: async () => ({ data: { user: null }, error: null }),
        },
      }),
    },
  })
  mock.module('next/headers.js', {
    exports: {
      headers: async () => new Headers(boundary.requestHeaders),
      cookies: async () => ({
        getAll: () => boundary.cookies,
        get: (name) => boundary.cookies.find((cookie) => cookie.name === name),
        set() {},
      }),
    },
  })
}

// Dynamically import the source under test after the boundary is mocked.
export async function loadSource(name) {
  mocked ??= installMocks()
  await mocked
  return import(srcUrl(name))
}
