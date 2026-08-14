import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent, SessionInfo } from './protocol'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { IncrementalJsonlReader } from './fs-utils'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME, SCAN_INTERVAL_MS,
  SESSION_ID_DISPLAY,
} from './constants'
import { createLogger } from './logger'
import { PiSessionParser } from './pi-session-parser'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('PiSessionWatcher')
const METADATA_READ_BYTES = 1024 * 1024

export interface PiWatcherOptions {
  sessionDir?: string
  agentDir?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  inactivityMs?: number
}

export interface PiSessionLocation {
  root: string
  defaultLayout: boolean
}

export interface PiSessionMetadata {
  id: string
  cwd: string
  timestamp: number | null
  parentSession?: string
  sessionName?: string
}

interface WatchedPiFile {
  filePath: string
  agentName: string
  parser: PiSessionParser
  reader: IncrementalJsonlReader
}

interface WatchedPiSession {
  sessionId: string
  rootFile: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  files: Map<string, WatchedPiFile>
  rootParser: PiSessionParser
}

export function resolvePiSessionLocation(workspace: string, options: PiWatcherOptions = {}): PiSessionLocation {
  const env = options.env ?? process.env
  const home = options.homeDir ?? os.homedir()
  const agentDir = expandHome(options.agentDir ?? env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), home)
  const explicit = options.sessionDir ?? env.AGENT_FLOW_PI_SESSION_DIR ?? env.PI_CODING_AGENT_SESSION_DIR
  if (explicit) return { root: resolveFromWorkspace(expandHome(explicit, home), workspace), defaultLayout: false }

  const projectSetting = readSessionDirSetting(path.join(workspace, '.pi', 'settings.json'))
  if (projectSetting) return { root: resolveFromWorkspace(expandHome(projectSetting, home), workspace), defaultLayout: false }

  const globalSetting = readSessionDirSetting(path.join(agentDir, 'settings.json'))
  if (globalSetting) return { root: resolveFromWorkspace(expandHome(globalSetting, home), workspace), defaultLayout: false }

  return { root: path.join(agentDir, 'sessions'), defaultLayout: true }
}

export function readPiSessionMetadata(filePath: string): PiSessionMetadata | null {
  let stat: fs.Stats
  try { stat = fs.statSync(filePath) } catch { return null }
  if (stat.size === 0) return null

  const fd = fs.openSync(filePath, 'r')
  try {
    const head = readRange(fd, 0, Math.min(METADATA_READ_BYTES, stat.size))
    const firstNewline = head.indexOf(0x0a)
    const headerText = head.subarray(0, firstNewline >= 0 ? firstNewline : head.length).toString('utf8')
    const header = JSON.parse(headerText) as Record<string, unknown>
    if (header.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') return null

    const tailStart = Math.max(0, stat.size - METADATA_READ_BYTES)
    const tail = tailStart === 0 ? head : readRange(fd, tailStart, stat.size - tailStart)
    const sessionName = findSessionName(tail.toString('utf8')) ?? findSessionName(head.toString('utf8'))
    return {
      id: header.id,
      cwd: header.cwd,
      timestamp: parseTimestamp(header.timestamp),
      ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
      ...(sessionName ? { sessionName } : {}),
    }
  } catch { return null }
  finally { fs.closeSync(fd) }
}

export class PiSessionWatcher implements AgentSessionWatcher {
  private readonly sessions = new Map<string, WatchedPiSession>()
  private readonly metadataCache = new Map<string, { size: number; mtimeMs: number; metadata: PiSessionMetadata }>()
  private readonly location: PiSessionLocation
  private readonly inactivityMs: number
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  private cwdMismatchWarned = false

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  constructor(private readonly workspace?: string | null, options: PiWatcherOptions = {}) {
    const base = workspace || process.cwd()
    this.location = resolvePiSessionLocation(base, options)
    this.inactivityMs = options.inactivityMs ?? INACTIVITY_TIMEOUT_MS
  }

  start(): void {
    if (this.workspace) this.workspacePath = resolvePath(this.workspace)
    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)
    log.info(`Watching ${this.location.root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  getWatchRoot(): string {
    return this.location.root
  }

  isActive(): boolean {
    return [...this.sessions.values()].some(session => session.sessionDetected && !session.sessionCompleted)
  }

  isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return !!session && session.sessionDetected && !session.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return [...this.sessions.values()].filter(session => session.sessionDetected).map(session => ({
      id: session.sessionId,
      label: session.label,
      status: session.sessionCompleted ? 'completed' : 'active',
      startTime: session.sessionStartTime,
      lastActivityTime: session.lastActivityTime,
    }))
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const session of this.sessions.values()) {
      if (!session.sessionDetected || (sessionIds && !sessionIds.includes(session.sessionId))) continue
      this._onSessionLifecycle.fire({ type: 'started', sessionId: session.sessionId, label: session.label })
    }
  }

  private scanForSessions(): void {
    const candidates = this.listRootCandidates()
    const metadata = new Map<string, PiSessionMetadata>()
    for (const filePath of candidates) {
      const parsed = this.readMetadata(filePath)
      if (parsed) metadata.set(normalizeFile(filePath), parsed)
    }

    const confirmedForks = new Map<string, string[]>()
    for (const [filePath, entry] of metadata) {
      if (!entry.parentSession || !entry.sessionName?.startsWith('subagent-')) continue
      const parent = normalizeFile(resolveFromWorkspace(entry.parentSession, path.dirname(filePath)))
      const files = confirmedForks.get(parent) ?? []
      files.push(filePath)
      confirmedForks.set(parent, files)
    }

    let skippedByCwd = 0
    for (const [filePath, entry] of metadata) {
      if (entry.parentSession && entry.sessionName?.startsWith('subagent-')) continue
      if (this.sessions.has(entry.id)) continue
      if (this.workspacePath && !pathMatchesWorkspace(resolvePath(entry.cwd), this.workspacePath)) {
        skippedByCwd++
        continue
      }

      const relatedFiles = [...this.findFreshChildFiles(filePath), ...(confirmedForks.get(filePath) ?? [])]
      const newestMtime = newestFileMtime([filePath, ...relatedFiles])
      if ((Date.now() - newestMtime) / 1000 > ACTIVE_SESSION_AGE_S) continue
      this.attachRoot(filePath, entry)
    }

    for (const session of this.sessions.values()) {
      const rootKey = normalizeFile(session.rootFile)
      for (const child of this.findFreshChildFiles(session.rootFile)) this.attachChild(session, child, false)
      for (const child of confirmedForks.get(rootKey) ?? []) this.attachChild(session, child, true)
      for (const watched of session.files.values()) this.readWatchedFile(session, watched)
      this.checkCompletion(session)
    }

    if (skippedByCwd > 0 && this.sessions.size === 0 && !this.cwdMismatchWarned) {
      this.cwdMismatchWarned = true
      log.warn(`Found ${skippedByCwd} recent Pi session(s), but none ran in ${this.workspacePath}.`)
    }
  }

  private readMetadata(filePath: string): PiSessionMetadata | null {
    const key = normalizeFile(filePath)
    const cached = this.metadataCache.get(key)
    if (cached && (!cached.metadata.parentSession || cached.metadata.sessionName)) return cached.metadata
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch { return null }
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.metadata
    const metadata = readPiSessionMetadata(filePath)
    if (metadata) this.metadataCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, metadata })
    return metadata
  }

  private listRootCandidates(): string[] {
    if (!fs.existsSync(this.location.root)) return []
    const files: string[] = []
    try {
      if (!this.location.defaultLayout) {
        for (const entry of fs.readdirSync(this.location.root, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(this.location.root, entry.name))
        }
        return files
      }
      for (const project of fs.readdirSync(this.location.root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        const projectDir = path.join(this.location.root, project.name)
        for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(projectDir, entry.name))
        }
      }
    } catch (err) { log.debug('Session scan failed:', err) }
    return files
  }

  private findFreshChildFiles(rootFile: string): string[] {
    const childRoot = path.join(path.dirname(rootFile), path.basename(rootFile, '.jsonl'))
    if (!fs.existsSync(childRoot)) return []
    const files: string[] = []
    try {
      for (const run of fs.readdirSync(childRoot, { withFileTypes: true })) {
        if (!run.isDirectory()) continue
        const runDir = path.join(childRoot, run.name)
        for (const child of fs.readdirSync(runDir, { withFileTypes: true })) {
          if (!child.isDirectory() || !child.name.startsWith('run-')) continue
          const sessionFile = path.join(runDir, child.name, 'session.jsonl')
          if (fs.existsSync(sessionFile)) files.push(sessionFile)
        }
      }
    } catch (err) { log.debug('Child session scan failed:', err) }
    return files
  }

  private attachRoot(filePath: string, metadata: PiSessionMetadata): void {
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) } catch { return }
    const sessionStartTime = metadata.timestamp ?? (stat.birthtimeMs || stat.mtimeMs)
    const label = `Pi ${metadata.id.slice(0, SESSION_ID_DISPLAY)}`
    const parser = new PiSessionParser({
      emit: event => this._onEvent.fire({ ...event, sessionId: metadata.id }),
      elapsed: timestamp => Math.max(0, ((timestamp ?? Date.now()) - sessionStartTime) / 1000),
      setLabel: newLabel => this.setLabel(metadata.id, newLabel),
    })
    const session: WatchedPiSession = {
      sessionId: metadata.id,
      rootFile: filePath,
      sessionStartTime,
      lastActivityTime: sessionStartTime,
      sessionDetected: false,
      sessionCompleted: false,
      label,
      files: new Map(),
      rootParser: parser,
    }
    session.files.set(normalizeFile(filePath), {
      filePath, agentName: ORCHESTRATOR_NAME, parser, reader: new IncrementalJsonlReader(),
    })
    this.sessions.set(metadata.id, session)
    this.readWatchedFile(session, session.files.get(normalizeFile(filePath))!)
    session.sessionDetected = true
    this._onSessionDetected.fire(metadata.id)
    this._onSessionLifecycle.fire({ type: 'started', sessionId: metadata.id, label: session.label })
    log.info(`Attached to Pi session ${metadata.id.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private attachChild(session: WatchedPiSession, filePath: string, forked: boolean): void {
    const key = normalizeFile(filePath)
    if (session.files.has(key)) return
    const metadata = this.readMetadata(filePath)
    if (!metadata) return
    const identity = deriveChildIdentity(filePath, metadata.sessionName)
    const parser = new PiSessionParser({
      emit: event => this._onEvent.fire({ ...event, sessionId: session.sessionId }),
      elapsed: timestamp => Math.max(0, ((timestamp ?? Date.now()) - session.sessionStartTime) / 1000),
    }, {
      agentName: identity.name,
      parentName: ORCHESTRATOR_NAME,
      isMain: false,
      task: identity.task,
      ...(forked ? { skipEntryIds: session.rootParser.getSeenEntryIds() } : {}),
    })
    const watched: WatchedPiFile = {
      filePath, agentName: identity.name, parser, reader: new IncrementalJsonlReader(),
    }
    session.files.set(key, watched)
    this.readWatchedFile(session, watched)
  }

  private readWatchedFile(session: WatchedPiSession, watched: WatchedPiFile): void {
    const result = watched.reader.read(watched.filePath)
    if (!result) return
    if (result.droppedLines > 0) log.warn(`Skipped ${result.droppedLines} oversized Pi JSONL line(s) in ${watched.filePath}`)
    let latest: number | null = null
    for (const line of result.lines) {
      try {
        const timestamp = watched.parser.processLine(line)
        if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp
      } catch (err) { log.debug('Pi parser threw on line:', err) }
    }
    if (latest === null || latest <= session.lastActivityTime) return

    const wasCompleted = session.sessionCompleted
    session.lastActivityTime = latest
    session.sessionCompleted = false
    if (wasCompleted) {
      this._onEvent.fire({
        time: Math.max(0, (latest - session.sessionStartTime) / 1000),
        type: 'agent_spawn',
        payload: {
          name: ORCHESTRATOR_NAME, isMain: true, task: session.label, runtime: 'pi',
          ...(session.rootParser.getModel() ? { model: session.rootParser.getModel() } : {}),
        },
        sessionId: session.sessionId,
      })
      if (watched.agentName !== ORCHESTRATOR_NAME) {
        this._onEvent.fire({
          time: Math.max(0, (latest - session.sessionStartTime) / 1000),
          type: 'agent_spawn',
          payload: { name: watched.agentName, parent: ORCHESTRATOR_NAME, isMain: false, task: 'Pi subagent', runtime: 'pi' },
          sessionId: session.sessionId,
        })
      }
      this._onSessionLifecycle.fire({ type: 'started', sessionId: session.sessionId, label: session.label })
    }
    this._onSessionLifecycle.fire({
      type: 'activity', sessionId: session.sessionId, label: session.label, lastActivityTime: latest,
    })
  }

  private checkCompletion(session: WatchedPiSession): void {
    if (session.sessionCompleted || Date.now() - session.lastActivityTime < this.inactivityMs) return
    session.sessionCompleted = true
    this._onEvent.fire({
      time: Math.max(0, (Date.now() - session.sessionStartTime) / 1000),
      type: 'agent_complete',
      payload: { name: ORCHESTRATOR_NAME, sessionEnd: true },
      sessionId: session.sessionId,
    })
    this._onSessionLifecycle.fire({ type: 'ended', sessionId: session.sessionId, label: session.label })
  }

  private setLabel(sessionId: string, label: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.label === label) return
    session.label = label
    this._onSessionLifecycle.fire({ type: 'updated', sessionId, label })
  }

  dispose(): void {
    if (this.scanInterval) clearInterval(this.scanInterval)
    this.sessions.clear()
    this.metadataCache.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}

function readSessionDirSetting(filePath: string): string | undefined {
  try {
    const value = (JSON.parse(fs.readFileSync(filePath, 'utf8')) as { sessionDir?: unknown }).sessionDir
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch { return undefined }
}

function expandHome(value: string, home: string): string {
  return value === '~' ? home : value.startsWith(`~${path.sep}`) ? path.join(home, value.slice(2)) : value
}

function resolveFromWorkspace(value: string, workspace: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspace, value)
}

function resolvePath(value: string): string {
  try { return fs.realpathSync(value) } catch { return path.resolve(value) }
}

function normalizeFile(value: string): string {
  const resolved = resolvePath(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathMatchesWorkspace(candidate: string, workspace: string): boolean {
  const foldedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const foldedWorkspace = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  return foldedCandidate === foldedWorkspace || foldedCandidate.startsWith(foldedWorkspace + path.sep)
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length)
  const bytesRead = fs.readSync(fd, buffer, 0, length, offset)
  return buffer.subarray(0, bytesRead)
}

function findSessionName(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('session_info')) continue
    try {
      const entry = JSON.parse(line) as { type?: unknown; name?: unknown }
      if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) return entry.name.trim()
    } catch { /* partial tail line */ }
  }
  return undefined
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function newestFileMtime(files: string[]): number {
  let newest = 0
  for (const file of files) {
    try { newest = Math.max(newest, fs.statSync(file).mtimeMs) } catch {}
  }
  return newest
}

function deriveChildIdentity(filePath: string, sessionName?: string): { name: string; task: string } {
  const runDir = path.basename(path.dirname(filePath))
  const runId = path.basename(path.dirname(path.dirname(filePath)))
  const runIndex = /^run-(\d+)$/.exec(runDir)?.[1]
  let base = 'subagent'
  let unique = runId.slice(0, 8)
  let index = runIndex ? Number(runIndex) + 1 : 1

  if (sessionName?.startsWith('subagent-')) {
    const raw = sessionName.slice('subagent-'.length)
    const nestedSuffix = runIndex ? `-${runId}-${index}` : ''
    if (nestedSuffix && raw.endsWith(nestedSuffix)) base = raw.slice(0, -nestedSuffix.length)
    else {
      const fork = /^(.*)-([0-9a-f]{8})-(\d+)$/i.exec(raw)
      if (fork) {
        base = fork[1]
        unique = fork[2]
        index = Number(fork[3])
      } else base = raw
    }
  }

  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'subagent'
  return { name: `${safeBase}-${unique}-${index}`, task: safeBase }
}
