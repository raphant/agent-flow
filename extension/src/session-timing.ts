import { INACTIVITY_TIMEOUT_MS } from './constants'

/** Time left before a session should be marked inactive. */
export function remainingInactivityMs(lastActivityTime: number, now = Date.now()): number {
  return Math.max(0, INACTIVITY_TIMEOUT_MS - Math.max(0, now - lastActivityTime))
}
