import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { boundary, loadSource } from './helpers.mjs'

const { checkAppAccess } = await loadSource('require-app-access')

afterEach(() => {
  boundary.getSession = null
  boundary.cookies = []
  boundary.requestHeaders = {}
})

// Why: a Portal rate-limit refusal used to sign users out mid-work (CLA-21).
test('a rate-limited Portal session check is retryable, not a sign-out', async () => {
  // Shared Portal cookie present (project ref of 127.0.0.1 is "127"); renewal refused.
  boundary.cookies = [{ name: 'sb-127-auth-token', value: 'base64-x' }]
  boundary.getSession = async () => ({
    data: { session: null },
    error: { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit' },
  })
  assert.deepEqual(await checkAppAccess(), { status: 'stale' })

  boundary.getSession = async () => ({
    data: { session: null },
    error: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' },
  })
  assert.deepEqual(await checkAppAccess(), { status: 'unauthenticated' })
})

const { getHubSessionResult } = await loadSource('hub-session')

// Why: a second renewal after the proxy's was refused spends the same limit again (CLA-21).
test('the page does not renew again after the proxy saw a refusal', async () => {
  let renewals = 0
  boundary.cookies = [{ name: 'holy-app-auth', value: 'base64-x' }]
  boundary.requestHeaders = { 'x-holy-auth-session': 'unavailable' }
  boundary.getSession = async () => {
    renewals += 1
    return { data: { session: null }, error: { name: 'AuthApiError', status: 429 } }
  }
  assert.deepEqual(await getHubSessionResult(), { status: 'stale', transient: true })
  assert.equal(renewals, 0)
})
