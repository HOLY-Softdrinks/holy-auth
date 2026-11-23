import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server.js'
import { boundary, loadSource } from './helpers.mjs'

const ORIGIN = 'http://localhost:3000'
const { handleHubCallback } = await loadSource('hub-callback')

function callback(returnTo) {
  const url = new URL('/__hub/dev-callback', ORIGIN)
  url.searchParams.set('token_hash', 'th')
  url.searchParams.set('state', 'abc')
  if (returnTo !== undefined) url.searchParams.set('return_to', returnTo)
  return handleHubCallback(
    new NextRequest(url, { headers: { cookie: '__hub_dev_handoff_state=abc' } }),
  )
}

// Why: a repeat would silently send a freshly signed-in user to a foreign site.
test('return paths stay within the supplied origin', async () => {
  const hostile = [
    '/\t/evil.example/x',
    '/\n/evil.example/x',
    '/\r/evil.example',
    '/\\evil.example',
    '//evil.example',
    'https://evil.example/',
    'not-a-path',
  ]
  for (const value of hostile) {
    const response = await callback(value)
    const location = new URL(response.headers.get('location'))
    assert.equal(location.origin, ORIGIN, `origin kept for ${JSON.stringify(value)}`)
    assert.equal(location.pathname + location.search, '/', `falls back to / for ${JSON.stringify(value)}`)
  }
  assert.deepEqual(boundary.fetchCalls, [])
})

test('ordinary paths round trip', async () => {
  const response = await callback('/reports?range=week#total')
  assert.equal(response.headers.get('location'), `${ORIGIN}/reports?range=week#total`)
  const encoded = await callback('/a%2Fb?q=%41')
  assert.equal(encoded.headers.get('location'), `${ORIGIN}/a%2Fb?q=%41`)
})
