import type { SessionInfo } from './bridge-types'

export function filterAndSortSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
  const normalizedQuery = query.trim().toLowerCase()

  return sessions
    .filter(session => !normalizedQuery || [session.label, session.id, session.status, session.runtime ?? '']
      .some(value => value.toLowerCase().includes(normalizedQuery)))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1
      if (a.lastActivityTime !== b.lastActivityTime) return b.lastActivityTime - a.lastActivityTime
      return a.label.localeCompare(b.label)
    })
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (elapsedSeconds < 60) return 'now'
  if (elapsedSeconds < 3600) return `${Math.floor(elapsedSeconds / 60)}m ago`
  if (elapsedSeconds < 86400) return `${Math.floor(elapsedSeconds / 3600)}h ago`
  return `${Math.floor(elapsedSeconds / 86400)}d ago`
}
