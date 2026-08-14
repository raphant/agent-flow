import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'
import { PiSessionWatcher, resolvePiSessionLocation } from '../src/pi-session-watcher'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-pi-watcher-'))
  dirs.push(dir)
  return dir
}

function entry(value: Record<string, unknown>): string {
  return JSON.stringify(value) + '\n'
}

function writeSession(filePath: string, values: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, values.map(entry).join(''))
}

function watch(workspace: string, options: ConstructorParameters<typeof PiSessionWatcher>[1]) {
  const watcher = new PiSessionWatcher(workspace, options)
  const events: AgentEvent[] = []
  const lifecycle: SessionLifecycleEvent[] = []
  watcher.onEvent(event => events.push(event))
  watcher.onSessionLifecycle(event => lifecycle.push(event))
  watcher.start()
  return { watcher, events, lifecycle }
}

describe('PiSessionWatcher', () => {
  it('discovers workspace descendants and fresh children with another cwd', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    const descendant = path.join(workspace, 'repo')
    fs.mkdirSync(descendant, { recursive: true })
    const sessions = path.join(root, 'agent', 'sessions')
    const started = Date.now()
    const mainFile = path.join(sessions, '--workspace--', 'main.jsonl')
    const descendantFile = path.join(sessions, '--descendant--', 'descendant.jsonl')
    writeSession(mainFile, [
      { type: 'session', id: 'main-session', timestamp: started, cwd: workspace },
      { type: 'message', id: 'main-user', parentId: 'main-session', timestamp: started + 1, message: { role: 'user', content: 'Root prompt' } },
      { type: 'message', id: 'main-assistant', parentId: 'main-user', timestamp: started + 2, message: { role: 'assistant', model: 'gpt-5.6-sol', stopReason: 'stop', usage: { totalTokens: 100 }, content: [{ type: 'text', text: 'Root answer' }] } },
    ])
    writeSession(descendantFile, [
      { type: 'session', id: 'descendant-session', timestamp: started, cwd: descendant },
      { type: 'message', id: 'descendant-user', timestamp: started + 1, message: { role: 'user', content: 'Descendant prompt' } },
      { type: 'message', id: 'descendant-assistant', timestamp: started + 2, message: { role: 'assistant', stopReason: 'stop', usage: { totalTokens: 50 }, content: [{ type: 'text', text: 'Done' }] } },
    ])
    const childFile = path.join(path.dirname(mainFile), 'main', '4c85f1e1', 'run-0', 'session.jsonl')
    writeSession(childFile, [
      { type: 'session', id: 'child-session', timestamp: started + 3, cwd: path.join(root, 'other-repo') },
      { type: 'session_info', id: 'child-info', parentId: 'child-session', timestamp: started + 4, name: 'subagent-delegate-4c85f1e1-1' },
      { type: 'message', id: 'child-user', parentId: 'child-info', timestamp: started + 5, message: { role: 'user', content: 'Child task' } },
      { type: 'message', id: 'child-assistant', parentId: 'child-user', timestamp: started + 6, message: { role: 'assistant', stopReason: 'stop', usage: { totalTokens: 25 }, content: [{ type: 'text', text: 'Child answer' }] } },
    ])

    const { watcher, events } = watch(workspace, { agentDir: path.join(root, 'agent'), env: {}, homeDir: root })
    assert.deepEqual(watcher.getActiveSessions().map(session => session.id).sort(), ['descendant-session', 'main-session'])
    const childSpawn = events.find(event => event.type === 'agent_spawn' && event.payload.parent === 'orchestrator')
    assert.equal(childSpawn?.payload.name, 'delegate-4c85f1e1-1')
    assert.equal(childSpawn?.payload.runtime, 'pi')
    assert.ok(events.some(event => event.type === 'message' && event.payload.content === 'Child task'))
    watcher.dispose()
  })

  it('classifies named fork children and suppresses copied parent entries', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    const sessionDir = path.join(root, 'sessions')
    const started = Date.now()
    const parentFile = path.join(sessionDir, 'parent.jsonl')
    writeSession(parentFile, [
      { type: 'session', id: 'parent-session', timestamp: started, cwd: workspace },
      { type: 'message', id: 'copied-user', timestamp: started + 1, message: { role: 'user', content: 'Parent prompt' } },
    ])
    writeSession(path.join(sessionDir, 'fork.jsonl'), [
      { type: 'session', id: 'fork-session', timestamp: started + 2, cwd: path.join(root, 'other'), parentSession: parentFile },
      { type: 'message', id: 'copied-user', timestamp: started + 1, message: { role: 'user', content: 'Parent prompt' } },
      { type: 'session_info', id: 'fork-info', timestamp: started + 3, name: 'subagent-reviewer-bfbf344a-1' },
      { type: 'message', id: 'fork-user', timestamp: started + 4, message: { role: 'user', content: 'Fork task' } },
    ])

    const { watcher, events } = watch(workspace, { sessionDir, env: {}, homeDir: root })
    assert.deepEqual(watcher.getActiveSessions().map(session => session.id), ['parent-session'])
    const messages = events.filter(event => event.type === 'message').map(event => event.payload.content)
    assert.deepEqual(messages, ['Parent prompt', 'Fork task'])
    assert.ok(events.some(event => event.type === 'agent_spawn' && event.payload.name === 'reviewer-bfbf344a-1'))
    watcher.dispose()
  })

  it('uses persisted activity time for completion and later reactivation', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    const sessionDir = path.join(root, 'sessions')
    const file = path.join(sessionDir, 'old.jsonl')
    const old = Date.now() - 60_000
    writeSession(file, [
      { type: 'session', id: 'old-session', timestamp: old, cwd: workspace },
      { type: 'message', id: 'old-user', timestamp: old + 1, message: { role: 'user', content: 'Old prompt' } },
    ])

    const { watcher, lifecycle } = watch(workspace, { sessionDir, env: {}, homeDir: root, inactivityMs: 10 })
    assert.equal(watcher.getActiveSessions()[0].status, 'completed')
    const resumed = Date.now()
    fs.appendFileSync(file, entry({ type: 'message', id: 'new-user', timestamp: resumed, message: { role: 'user', content: 'Resume' } }))
    ;(watcher as unknown as { scanForSessions(): void }).scanForSessions()
    assert.equal(watcher.getActiveSessions()[0].status, 'active')
    assert.equal(watcher.getActiveSessions()[0].lastActivityTime, resumed)
    assert.ok(lifecycle.some(event => event.type === 'ended'))
    assert.ok(lifecycle.filter(event => event.type === 'started').length >= 2)
    watcher.dispose()
  })

  it('follows session-directory precedence', () => {
    const root = tempDir()
    const workspace = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    fs.mkdirSync(path.join(workspace, '.pi'), { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: 'global-sessions' }))
    fs.writeFileSync(path.join(workspace, '.pi', 'settings.json'), JSON.stringify({ sessionDir: 'project-sessions' }))

    assert.equal(resolvePiSessionLocation(workspace, { agentDir, env: {}, homeDir: root }).root, path.join(workspace, 'project-sessions'))
    assert.equal(resolvePiSessionLocation(workspace, { agentDir, env: { PI_CODING_AGENT_SESSION_DIR: 'env-sessions' }, homeDir: root }).root, path.join(workspace, 'env-sessions'))
    assert.equal(resolvePiSessionLocation(workspace, { agentDir, sessionDir: 'explicit-sessions', env: { PI_CODING_AGENT_SESSION_DIR: 'env-sessions' }, homeDir: root }).root, path.join(workspace, 'explicit-sessions'))
  })
})
