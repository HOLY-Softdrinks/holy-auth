import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeReturnTo } from '../src/return-path.ts'

const ORIGIN = 'https://app.example.test'

// Why: the helper decides where a signed-in user lands; every refused shape
// must collapse to "/" and never leave the supplied origin.
test('return paths stay within the supplied origin', () => {
  for (const value of [null, '', 'reports', 'https://evil.example/', 'javascript:alert(1)']) {
    assert.equal(sanitizeReturnTo(value, ORIGIN), '/', JSON.stringify(value))
  }
  for (const value of [
    '//evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/./\t/evil.example',
    '/.//evil.example',
    '/a/..//evil.example',
    '/%5Cevil.example',
  ]) {
    const result = sanitizeReturnTo(value, ORIGIN)
    const url = new URL(result, ORIGIN)
    assert.equal(url.origin, ORIGIN, JSON.stringify(value))
    assert.ok(!result.startsWith('//'), JSON.stringify(value))
  }
  assert.equal(sanitizeReturnTo('/.//evil.example', ORIGIN), '/')
  // Malformed authority makes the URL parser throw; it must fall back to "/".
  assert.equal(sanitizeReturnTo('//[', ORIGIN), '/')
})

test('ordinary paths round trip', () => {
  assert.equal(sanitizeReturnTo('/reports?range=week#total', ORIGIN), '/reports?range=week#total')
  assert.equal(sanitizeReturnTo('/', ORIGIN), '/')
  // Encoded local characters are not decoded a second time.
  assert.equal(sanitizeReturnTo('/a%2Fb?q=%41', ORIGIN), '/a%2Fb?q=%41')
  assert.equal(sanitizeReturnTo('/a/../b', ORIGIN), '/b')
})
