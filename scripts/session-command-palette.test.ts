import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionInfo } from '../web/lib/bridge-types.ts'
import { filterAndSortSessions, formatRelativeTime } from '../web/lib/session-search.ts'

const sessions: SessionInfo[] = [
  { id: 'older-active', label: 'Older active', status: 'active', startTime: 1, lastActivityTime: 20 },
  { id: 'completed', label: 'Completed task', status: 'completed', startTime: 2, lastActivityTime: 40 },
  { id: 'newer-active', label: 'Newer active', status: 'active', startTime: 3, lastActivityTime: 30 },
]

test('pins active sessions before completed sessions and sorts each group by activity', () => {
  assert.deepEqual(
    filterAndSortSessions(sessions, '').map(session => session.id),
    ['newer-active', 'older-active', 'completed'],
  )
})

test('searches session labels, IDs, and status', () => {
  assert.deepEqual(filterAndSortSessions(sessions, 'completed').map(session => session.id), ['completed'])
  assert.deepEqual(filterAndSortSessions(sessions, 'newer-active').map(session => session.id), ['newer-active'])
})

test('formats relative activity times', () => {
  const now = 100_000
  assert.equal(formatRelativeTime(now - 30_000, now), 'now')
  assert.equal(formatRelativeTime(now - 120_000, now), '2m ago')
  assert.equal(formatRelativeTime(now - 7_200_000, now), '2h ago')
  assert.equal(formatRelativeTime(now - 172_800_000, now), '2d ago')
})
