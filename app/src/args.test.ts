import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from './args'

describe('parseArgs', () => {
  it('accepts a Pi session-directory override', () => {
    assert.equal(parseArgs(['--pi-session-dir', '/tmp/pi-sessions']).piSessionDir, '/tmp/pi-sessions')
  })
})
