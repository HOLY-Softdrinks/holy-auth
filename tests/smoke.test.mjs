import test from 'node:test'
import assert from 'node:assert/strict'
import { boundary, loadSource } from './helpers.mjs'

// Why: proves the harness loads the TypeScript source with no network access,
// so every other test runs against the real modules on an isolated boundary.
test('source modules import without touching the network', async () => {
  for (const name of ['hub-callback', 'hub-session', 'refresh-session']) {
    const mod = await loadSource(name)
    assert.ok(Object.keys(mod).length > 0, `${name} exports something`)
  }
  assert.deepEqual(boundary.fetchCalls, [])
})
