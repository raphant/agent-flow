import assert from 'node:assert/strict'
import test from 'node:test'
import { INACTIVITY_TIMEOUT_MS } from '../src/constants'
import { remainingInactivityMs } from '../src/session-timing'

test('preserves elapsed inactivity when a watcher attaches', () => {
  const now = 1_000_000
  assert.equal(remainingInactivityMs(now - 60_000, now), INACTIVITY_TIMEOUT_MS - 60_000)
  assert.equal(remainingInactivityMs(now - INACTIVITY_TIMEOUT_MS, now), 0)
  assert.equal(remainingInactivityMs(now + 60_000, now), INACTIVITY_TIMEOUT_MS)
})
