import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

function entry(value) {
  return JSON.stringify(value) + '\n'
}

async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

test('the standalone app streams Pi replay and live file activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-pi-smoke-'))
  const workspace = path.join(root, 'workspace')
  const sessionDir = path.join(root, 'sessions')
  const mainFile = path.join(sessionDir, 'main.jsonl')
  const started = Date.now()
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(path.dirname(mainFile), { recursive: true })
  fs.writeFileSync(mainFile, [
    { type: 'session', id: 'pi-main', timestamp: started, cwd: workspace },
    { type: 'message', id: 'user-1', timestamp: started + 1, message: { role: 'user', content: 'Pi standalone smoke' } },
    { type: 'message', id: 'assistant-1', timestamp: started + 2, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'missing' } }] } },
    { type: 'message', id: 'result-1', timestamp: started + 3, message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, content: [{ type: 'text', text: 'not found' }] } },
  ].map(entry).join(''))

  const childFile = path.join(path.dirname(mainFile), 'main', 'child123', 'run-0', 'session.jsonl')
  fs.mkdirSync(path.dirname(childFile), { recursive: true })
  fs.writeFileSync(childFile, [
    { type: 'session', id: 'pi-child', timestamp: started + 4, cwd: path.join(root, 'other') },
    { type: 'session_info', id: 'child-info', timestamp: started + 5, name: 'subagent-reviewer-child123-1' },
    { type: 'message', id: 'child-user', timestamp: started + 6, message: { role: 'user', content: 'Review the relay' } },
  ].map(entry).join(''))

  const port = await freePort()
  const app = path.resolve('app/dist/app.js')
  const child = spawn(process.execPath, [app, '--port', String(port), '--no-open', '--pi-session-dir', sessionDir], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: root,
      PI_CODING_AGENT_DIR: path.join(root, '.opi'),
      AGENT_FLOW_RUNTIME: 'pi',
      AGENT_FLOW_TELEMETRY: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4_000) })

  let request
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Standalone app exited early: ${stderr}`)
      try { return (await fetch(`http://127.0.0.1:${port}/`)).ok } catch { return false }
    }, 'the standalone HTTP server')

    const messages = []
    let pending = ''
    request = http.get(`http://127.0.0.1:${port}/events`, response => response.on('data', chunk => {
      pending += chunk.toString()
      for (;;) {
        const end = pending.indexOf('\n\n')
        if (end < 0) break
        const line = pending.slice(0, end).split('\n').find(value => value.startsWith('data: '))
        pending = pending.slice(end + 2)
        if (line) messages.push(JSON.parse(line.slice(6)))
      }
    }))
    request.on('error', error => { if (error.code !== 'ECONNRESET') throw error })

    await waitFor(() => messages.some(message => message.type === 'agent-event-batch'), 'the initial Pi event batch')
    const sessions = messages.find(message => message.type === 'session-list')?.sessions
    assert.deepEqual(sessions?.map(session => session.id), ['pi-main'])

    const replay = messages.find(message => message.type === 'agent-event-batch')?.events ?? []
    assert.equal(replay.find(event => event.type === 'agent_spawn' && event.payload.parent)?.payload.runtime, 'pi')
    assert.equal(replay.find(event => event.type === 'tool_call_end')?.payload.isError, true)

    fs.appendFileSync(mainFile, entry({
      type: 'message', id: 'live-user', timestamp: Date.now(), message: { role: 'user', content: 'Live update' },
    }))
    await waitFor(() => messages.some(message => message.type === 'agent-event' && message.event?.type === 'message' && message.event.payload.content === 'Live update'), 'the appended Pi message')
  } finally {
    request?.destroy()
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceKill.unref()
      await once(child, 'exit')
      clearTimeout(forceKill)
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
