import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server.js'
import { isolate } from './helpers.mjs'

// Real @supabase/ssr + auth-js; only the Hub meta lookup and the network are faked.
isolate()
const configUrl = new URL('../src/config.ts', import.meta.url).href
const realConfig = await import(configUrl)
mock.module(configUrl, {
  exports: {
    ...realConfig,
    getHubMeta: async () => ({
      supabaseUrl: 'http://127.0.0.1:1',
      supabaseAnonKey: 'test-anon-key',
      issuer: 'http://127.0.0.1:1',
    }),
  },
})
const { refreshChildSession } = await import(new URL('../src/refresh-session.ts', import.meta.url).href)

const b64url = (text) => Buffer.from(text).toString('base64url')
const now = () => Math.floor(Date.now() / 1000)
// HS256 makes getClaims verify through GET /auth/v1/user, which the fake server answers.
const jwt = (exp) =>
  `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub: 'user-1', exp, role: 'authenticated', aud: 'authenticated' }),
  )}.sig`
const session = (exp, refreshToken) => ({
  access_token: jwt(exp),
  refresh_token: refreshToken,
  expires_at: exp,
  expires_in: exp - now(),
  token_type: 'bearer',
  user: { id: 'user-1', aud: 'authenticated' },
})
const OLD_COOKIE = `base64-${b64url(JSON.stringify(session(now() - 60, 'r-old')))}`
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeAuthServer({ token, user }) {
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input)
    if (url.includes('/auth/v1/token')) return token()
    if (url.includes('/auth/v1/user')) return user()
    throw new Error(`unexpected network call: ${url}`)
  }
}

const childRequest = () =>
  new NextRequest('http://localhost:3000/products', { headers: { cookie: `holy-app-auth=${OLD_COOKIE}` } })
const childCookieLines = (response) =>
  response.headers.getSetCookie().filter((line) => line.startsWith('holy-app-auth'))
const USER = { id: 'user-1', aud: 'authenticated', role: 'authenticated' }

// Reassemble the child session from name/value pairs (single cookie or numbered pieces).
function decodeSession(pairs) {
  const parts = pairs.filter(([name, value]) => /^holy-app-auth(\.\d+)?$/.test(name) && value)
  const single = parts.find(([name]) => name === 'holy-app-auth')
  const joined = single
    ? single[1]
    : parts
        .sort(([a], [b]) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
        .map(([, value]) => value)
        .join('')
  assert.ok(joined.startsWith('base64-'), 'no session cookie')
  return JSON.parse(Buffer.from(joined.slice('base64-'.length), 'base64url').toString())
}
const browserSession = (response) =>
  decodeSession(
    childCookieLines(response).map((line) => {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      return [pair.slice(0, eq), pair.slice(eq + 1)]
    }),
  )
const requestSession = (request) =>
  decodeSession(request.cookies.getAll().map((cookie) => [cookie.name, cookie.value]))

// Why: auth-js deletes the session on a refused refresh; a 429 must not sign the user out (CLA-21).
test('a rate-limited refresh keeps the session cookie', async () => {
  fakeAuthServer({
    token: () => json(429, { error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }),
    user: () => json(200, USER),
  })
  const request = childRequest()
  const result = await refreshChildSession(request)
  assert.equal(result.outcome, 'unavailable')
  assert.deepEqual(childCookieLines(result.response), [])
  assert.equal(request.cookies.get('holy-app-auth')?.value, OLD_COOKIE)
  assert.equal(result.response.headers.get('x-middleware-request-x-holy-auth-session'), 'unavailable')
})

test('a rejected refresh still clears the session', async () => {
  fakeAuthServer({
    token: () => json(400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }),
    user: () => json(200, USER),
  })
  const result = await refreshChildSession(childRequest())
  assert.equal(result.outcome, 'invalid')
  assert.deepEqual(result.staleCookies, ['holy-app-auth'])
})

// Why: the server has already rotated the token; dropping it signs the user out on the next renewal (CLA-21).
test('a rotated session is saved even when the check after it hits a blip', async () => {
  fakeAuthServer({
    token: () => json(200, session(now() + 3600, 'r-new')),
    user: () => json(503, { msg: 'unavailable' }),
  })
  const request = childRequest()
  const result = await refreshChildSession(request)
  assert.equal(result.outcome, 'unavailable')
  assert.equal(browserSession(result.response).refresh_token, 'r-new')
  assert.equal(requestSession(request).refresh_token, 'r-new')
})

// Why: an unsaved renewal repeats on every request, which is what drains the limit (CLA-21).
test('a successful refresh is saved for the browser and this request', async () => {
  fakeAuthServer({
    token: () => json(200, session(now() + 3600, 'r-new')),
    user: () => json(200, USER),
  })
  const request = childRequest()
  const result = await refreshChildSession(request)
  assert.equal(result.outcome, 'refreshed')
  assert.equal(browserSession(result.response).refresh_token, 'r-new')
  assert.equal(requestSession(request).refresh_token, 'r-new')
  assert.match(result.response.headers.get('cache-control') ?? '', /no-store/)
})

// Why: a client must not be able to pre-set the proxy's marker (CLA-21).
test('an incoming session marker is stripped', async () => {
  fakeAuthServer({
    token: () => json(200, session(now() + 3600, 'r-new')),
    user: () => json(200, USER),
  })
  const request = new NextRequest('http://localhost:3000/products', {
    headers: { cookie: `holy-app-auth=${OLD_COOKIE}`, 'x-holy-auth-session': 'unavailable' },
  })
  const result = await refreshChildSession(request)
  assert.equal(result.outcome, 'refreshed')
  const override = result.response.headers.get('x-middleware-override-headers')
  assert.ok(override, 'override header list missing')
  assert.ok(!override.split(',').map((name) => name.trim()).includes('x-holy-auth-session'))
  assert.equal(result.response.headers.get('x-middleware-request-x-holy-auth-session'), null)
})

// Why: a session renewed into several cookie pieces and then rejected must not survive in the browser (CLA-21).
test('a rejected session leaves no new cookie pieces behind', async () => {
  const big = session(now() + 3600, 'r-new')
  big.user = { ...big.user, user_metadata: { pad: 'x'.repeat(5000) } }
  fakeAuthServer({
    token: () => json(200, big),
    user: () => json(401, { error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' }),
  })
  const request = childRequest()
  const result = await refreshChildSession(request)
  assert.equal(result.outcome, 'invalid')
  assert.ok(result.staleCookies.includes('holy-app-auth.0'), `staleCookies: ${result.staleCookies}`)
  assert.ok(result.staleCookies.includes('holy-app-auth.1'), `staleCookies: ${result.staleCookies}`)
  const lines = childCookieLines(result.response)
  for (const line of lines) {
    assert.match(line, /^holy-app-auth(\.\d+)?=;/, `non-empty child cookie survived: ${line.slice(0, 40)}`)
    assert.match(line, /Max-Age=0/i)
  }
  for (const name of result.staleCookies) assert.ok(!request.cookies.get(name)?.value, `request still carries ${name}`)
})
