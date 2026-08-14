import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { ORCHESTRATOR_NAME } from '../src/constants'
import { PiSessionParser } from '../src/pi-session-parser'

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

describe('PiSessionParser', () => {
  it('maps messages, tools, failures, models, and authoritative context usage', () => {
    const events: AgentEvent[] = []
    const labels: string[] = []
    const parser = new PiSessionParser({
      emit: event => events.push(event),
      elapsed: timestamp => timestamp ? (timestamp - 1_000) / 1_000 : 0,
      setLabel: label => labels.push(label),
    })

    const entries = [
      { type: 'session', id: 'session-1', timestamp: 1_000, cwd: '/workspace' },
      { type: 'model_change', id: 'model-1', timestamp: 1_100, modelId: 'gpt-5.6-sol' },
      { type: 'message', id: 'user-1', timestamp: 1_200, message: { role: 'user', content: 'Inspect the adapter' } },
      { type: 'message', id: 'assistant-1', timestamp: 1_300, message: { role: 'assistant', model: 'gpt-5.6-sol', stopReason: 'toolUse', usage: { totalTokens: 1234 }, content: [
        { type: 'thinking', thinking: 'I should inspect the file.' },
        { type: 'text', text: 'I will inspect it.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/workspace/a.ts' } },
      ] } },
      { type: 'message', id: 'result-1', timestamp: 1_400, message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: true, content: [{ type: 'text', text: 'not found' }] } },
      { type: 'message', id: 'error-1', timestamp: 1_500, message: { role: 'assistant', model: 'gpt-5.6-sol', stopReason: 'error', errorMessage: 'provider failed', content: [] } },
    ]
    for (const entry of entries) parser.processLine(line(entry))

    assert.equal(events.filter(event => event.type === 'agent_spawn').length, 1)
    assert.equal(events.find(event => event.type === 'agent_spawn')?.payload.runtime, 'pi')
    assert.deepEqual(labels, ['Inspect the adapter'])
    assert.equal(events.filter(event => event.type === 'model_detected').length, 1)
    assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.payload.role), [
      'user', 'thinking', 'assistant', 'assistant',
    ])
    assert.equal(events.find(event => event.type === 'tool_call_start')?.payload.callId, 'call-1')
    assert.equal(events.find(event => event.type === 'tool_call_end')?.payload.isError, true)
    assert.equal(events.find(event => event.type === 'context_update')?.payload.tokens, 1234)
    assert.equal(events.find(event => event.type === 'error')?.payload.message, 'provider failed')
  })

  it('deduplicates replayed entries and skips copied fork history', () => {
    const events: AgentEvent[] = []
    const parser = new PiSessionParser({ emit: event => events.push(event), elapsed: () => 0 }, {
      agentName: 'delegate-run-1',
      parentName: ORCHESTRATOR_NAME,
      isMain: false,
      skipEntryIds: new Set(['copied-user']),
    })
    const header = line({ type: 'session', id: 'child-session', timestamp: 1_000, cwd: '/other' })
    const copied = line({ type: 'message', id: 'copied-user', timestamp: 900, message: { role: 'user', content: 'parent prompt' } })
    const child = line({ type: 'message', id: 'child-user', timestamp: 1_100, message: { role: 'user', content: 'child task' } })
    const repeatedPrompt = line({ type: 'message', id: 'child-user-2', timestamp: 1_200, message: { role: 'user', content: 'child task' } })

    for (const entry of [header, copied, child, child, repeatedPrompt]) parser.processLine(entry)

    assert.equal(events.filter(event => event.type === 'subagent_dispatch').length, 1)
    assert.equal(events.filter(event => event.type === 'agent_spawn').length, 1)
    assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.payload.content), ['child task', 'child task'])
  })
})
