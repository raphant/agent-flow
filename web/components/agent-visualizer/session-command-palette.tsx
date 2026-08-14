'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { COLORS } from '@/lib/colors'
import { filterAndSortSessions, formatRelativeTime } from '@/lib/session-search'
import type { SessionInfo } from '@/lib/bridge-types'

interface SessionCommandPaletteProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

const RUNTIME_BADGES = {
  claude: { label: 'CLAUDE', color: COLORS.contextReasoning },
  codex: { label: 'CODEX', color: COLORS.complete },
  pi: { label: 'PI', color: COLORS.tool_calling },
} as const

export function SessionCommandPalette({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
}: SessionCommandPaletteProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const visibleSessions = useMemo(() => filterAndSortSessions(sessions, query), [sessions, query])
  const selectedSession = sessions.find(session => session.id === selectedSessionId) ?? sessions[0]

  const closePalette = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (isOpen) closePalette()
        else setIsOpen(true)
      } else if (event.key === 'Escape' && isOpen) {
        event.preventDefault()
        closePalette()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closePalette, isOpen])

  useEffect(() => {
    if (!isOpen) return
    inputRef.current?.focus()
    const handleOutsideClick = (event: MouseEvent) => {
      if (!paletteRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        closePalette()
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [closePalette, isOpen])

  useEffect(() => {
    if (!isOpen) return
    const selectedIndex = visibleSessions.findIndex(session => session.id === selectedSessionId)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
  }, [isOpen, query, selectedSessionId, visibleSessions])

  useEffect(() => {
    const activeSession = visibleSessions[activeIndex]
    if (isOpen && activeSession) {
      optionRefs.current.get(activeSession.id)?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, isOpen, visibleSessions])

  const selectSession = (id: string) => {
    onSelectSession(id)
    closePalette()
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (visibleSessions.length === 0) return
      setActiveIndex(index => Math.min(index + 1, visibleSessions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(Math.max(visibleSessions.length - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const session = visibleSessions[activeIndex]
      if (session) selectSession(session.id)
    }
  }

  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="session-command-palette"
        aria-keyshortcuts="Meta+K Control+K"
        aria-label={`Switch session. Current session: ${selectedSession.label}`}
        onClick={() => isOpen ? closePalette() : setIsOpen(true)}
        className="flex min-w-0 items-center gap-1.5 rounded px-2 py-1 transition-all"
        style={{
          maxWidth: 260,
          background: COLORS.tabSelectedBg,
          border: `1px solid ${COLORS.tabSelectedBorder}`,
          color: COLORS.holoBright,
        }}
      >
        <span
          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{
            background: selectedSession.status === 'active' ? COLORS.complete : COLORS.idle + '40',
            boxShadow: selectedSession.status === 'active' ? `0 0 4px ${COLORS.complete}` : 'none',
          }}
        />
        <span className="truncate">{selectedSession.label}</span>
        <span className="flex-shrink-0" style={{ color: COLORS.textMuted }}>({sessions.length})</span>
        <kbd className="ml-1 hidden flex-shrink-0 opacity-50 sm:inline">⌘/Ctrl K</kbd>
      </button>

      {isOpen && (
        <div
          ref={paletteRef}
          id="session-command-palette"
          role="dialog"
          aria-label="Switch session"
          className="glass-card absolute left-0 top-8 p-2"
          style={{ width: 'min(420px, calc(100vw - 24px))' }}
        >
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            aria-label="Search sessions"
            aria-controls="session-command-results"
            aria-activedescendant={visibleSessions[activeIndex] ? `session-option-${visibleSessions[activeIndex].id}` : undefined}
            placeholder="Search sessions..."
            className="w-full rounded px-2 py-1.5 text-[11px]"
          />

          <ul id="session-command-results" className="mt-2 max-h-80 space-y-1 overflow-y-auto" aria-label="Sessions">
            {visibleSessions.map((session, index) => {
              const isSelected = session.id === selectedSessionId
              const hasActivity = sessionsWithActivity.has(session.id)
              const isActive = session.status === 'active'
              const runtimeBadge = session.runtime ? RUNTIME_BADGES[session.runtime] : null
              return (
                <li
                  key={session.id}
                  className="flex items-center rounded"
                  style={{
                    background: index === activeIndex ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                    border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                  }}
                >
                  <button
                    ref={element => {
                      if (element) optionRefs.current.set(session.id, element)
                      else optionRefs.current.delete(session.id)
                    }}
                    id={`session-option-${session.id}`}
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectSession(session.id)}
                    className="min-w-0 flex-1 px-2 py-2 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{
                          background: isActive || hasActivity ? COLORS.complete : COLORS.idle + '40',
                          boxShadow: hasActivity && !isSelected ? `0 0 4px ${COLORS.complete}` : 'none',
                        }}
                      />
                      {runtimeBadge && (
                        <span
                          className="flex-shrink-0 rounded border px-1 py-0.5 text-[8px] font-semibold tracking-wide"
                          style={{ color: runtimeBadge.color, borderColor: `${runtimeBadge.color}60`, background: COLORS.holoBg05 }}
                        >
                          {runtimeBadge.label}
                        </span>
                      )}
                      <span className="truncate" style={{ color: isSelected ? COLORS.holoBright : COLORS.textPrimary }}>
                        {session.label}
                      </span>
                    </span>
                    <span className="mt-1 flex gap-2 pl-3.5 text-[9px]" style={{ color: COLORS.textMuted }}>
                      <span>{isActive ? 'Active' : 'Completed'}</span>
                      <span>Last activity {formatRelativeTime(session.lastActivityTime)}</span>
                      {hasActivity && !isSelected && <span style={{ color: COLORS.complete }}>New activity</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close session ${session.label}`}
                    onClick={() => onCloseSession(session.id)}
                    className="mr-2 rounded px-1 py-0.5 opacity-50 transition-opacity hover:opacity-100 focus:opacity-100"
                    style={{ color: COLORS.tabClose }}
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ul>

          {visibleSessions.length === 0 && (
            <div className="py-6 text-center text-[10px]" style={{ color: COLORS.textMuted }}>
              No matching sessions
            </div>
          )}

          <div className="mt-2 flex gap-3 border-t pt-2 text-[9px]" style={{ borderColor: COLORS.holoBorder08, color: COLORS.textMuted }}>
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>esc close</span>
          </div>
        </div>
      )}
    </div>
  )
}
