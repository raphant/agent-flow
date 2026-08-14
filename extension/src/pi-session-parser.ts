import type { AgentEvent } from './protocol'
import {
  MESSAGE_MAX, ORCHESTRATOR_NAME, PREVIEW_MAX, RESULT_MAX,
  SYSTEM_CONTENT_PREFIXES, SYSTEM_PROMPT_BASE_TOKENS,
} from './constants'
import {
  buildDiscovery, extractFilePath, extractInputData, summarizeInput, summarizeResult,
} from './tool-summarizer'
import { estimateTokenCost, estimateTokensFromText } from './token-estimator'

interface PiEntry {
  id?: string
  type?: string
  timestamp?: string | number
  provider?: string
  modelId?: string
  name?: string
  message?: unknown
}

interface PiContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
  model?: string
  provider?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  errorMessage?: string
  stopReason?: string
  usage?: { totalTokens?: number }
}

interface PendingPiToolCall {
  name: string
  filePath?: string
}

interface PiContextEstimate {
  userMessages: number
  toolResults: number
  reasoning: number
}

export interface PiParserDelegate {
  emit(event: AgentEvent): void
  elapsed(timestamp?: number): number
  setLabel?(label: string): void
}

export interface PiParserOptions {
  agentName?: string
  parentName?: string
  isMain?: boolean
  task?: string
  skipEntryIds?: ReadonlySet<string>
}

export class PiSessionParser {
  private readonly agentName: string
  private readonly parentName?: string
  private readonly isMain: boolean
  private readonly task: string
  private readonly skipEntryIds: ReadonlySet<string>
  private readonly seenEntryIds = new Set<string>()
  private readonly pendingToolCalls = new Map<string, PendingPiToolCall>()
  private readonly context: PiContextEstimate = { userMessages: 0, toolResults: 0, reasoning: 0 }
  private spawned = false
  private model: string | null = null
  private labelSet = false

  constructor(
    private readonly delegate: PiParserDelegate,
    options: PiParserOptions = {},
  ) {
    this.agentName = options.agentName ?? ORCHESTRATOR_NAME
    this.parentName = options.parentName
    this.isMain = options.isMain ?? !options.parentName
    this.task = options.task ?? (this.isMain ? 'Pi session' : 'Pi subagent')
    this.skipEntryIds = options.skipEntryIds ?? new Set()
  }

  processLine(line: string): number | null {
    let entry: PiEntry
    try { entry = JSON.parse(line) as PiEntry }
    catch { return null }
    if (!entry || typeof entry !== 'object') return null

    const timestamp = parseTimestamp(entry.timestamp)
    if (entry.id && (this.skipEntryIds.has(entry.id) || this.seenEntryIds.has(entry.id))) return null
    if (entry.id) this.seenEntryIds.add(entry.id)

    this.ensureSpawned(timestamp)
    switch (entry.type) {
      case 'model_change':
        this.detectModel(entry.modelId, timestamp)
        break
      case 'session_info':
        if (this.isMain && typeof entry.name === 'string' && entry.name.trim()) {
          this.setLabel(entry.name.trim())
        }
        break
      case 'message':
        this.handleMessage(entry.message, timestamp)
        break
      case 'compaction':
        this.context.userMessages = 0
        this.context.toolResults = 0
        this.context.reasoning = 0
        break
    }
    return timestamp
  }

  getSeenEntryIds(): ReadonlySet<string> {
    return this.seenEntryIds
  }

  getModel(): string | null {
    return this.model
  }

  private ensureSpawned(timestamp: number | null): void {
    if (this.spawned) return
    this.spawned = true
    if (this.parentName) {
      this.delegate.emit({
        time: this.delegate.elapsed(timestamp ?? undefined),
        type: 'subagent_dispatch',
        payload: { parent: this.parentName, child: this.agentName, task: this.task },
      })
    }
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'agent_spawn',
      payload: {
        name: this.agentName,
        isMain: this.isMain,
        task: this.task,
        runtime: 'pi',
        ...(this.parentName ? { parent: this.parentName } : {}),
      },
    })
  }

  private handleMessage(value: unknown, timestamp: number | null): void {
    if (!isRecord(value)) return
    const message = value as PiMessage
    if (message.role === 'user') return this.handleUserMessage(message, timestamp)
    if (message.role === 'assistant') return this.handleAssistantMessage(message, timestamp)
    if (message.role === 'toolResult') return this.handleToolResult(message, timestamp)
  }

  private handleUserMessage(message: PiMessage, timestamp: number | null): void {
    const text = flattenText(message.content).trim()
    if (!text || SYSTEM_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))) return
    this.context.userMessages += estimateTokensFromText(text)
    if (this.isMain && !this.labelSet) this.setLabel(text.slice(0, PREVIEW_MAX))
    this.emitMessage('user', text, timestamp)
  }

  private handleAssistantMessage(message: PiMessage, timestamp: number | null): void {
    this.detectModel(message.model, timestamp)
    const blocks = Array.isArray(message.content) ? message.content : []
    for (const block of blocks) {
      if (block.type === 'thinking' && block.thinking?.trim()) {
        const text = block.thinking.trim()
        this.context.reasoning += estimateTokensFromText(text)
        this.emitMessage('thinking', text, timestamp)
      } else if (block.type === 'text' && block.text?.trim()) {
        this.emitMessage('assistant', block.text.trim(), timestamp)
      } else if (block.type === 'toolCall') {
        this.handleToolCall(block, timestamp)
      }
    }

    if (message.stopReason === 'error' && message.errorMessage?.trim()) {
      const error = message.errorMessage.trim()
      if (!blocks.some(block => block.type === 'text' && block.text?.includes(error))) {
        this.emitMessage('assistant', error, timestamp)
      }
      this.delegate.emit({
        time: this.delegate.elapsed(timestamp ?? undefined),
        type: 'error',
        payload: { agent: this.agentName, message: error },
      })
    }

    const totalTokens = message.usage?.totalTokens
    if (typeof totalTokens === 'number' && totalTokens > 0 && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      this.emitContextUpdate(totalTokens, timestamp)
    }
  }

  private handleToolCall(block: PiContentBlock, timestamp: number | null): void {
    if (!block.id) return
    const name = block.name || 'unknown'
    const args = isRecord(block.arguments) ? block.arguments : {}
    const argsSummary = summarizeInput(name, args)
    const filePath = extractFilePath(args)
    this.pendingToolCalls.set(block.id, { name, filePath })
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'tool_call_start',
      payload: {
        agent: this.agentName,
        tool: name,
        callId: block.id,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(name, args),
      },
    })
  }

  private handleToolResult(message: PiMessage, timestamp: number | null): void {
    if (!message.toolCallId) return
    const pending = this.pendingToolCalls.get(message.toolCallId)
    if (!pending) return
    this.pendingToolCalls.delete(message.toolCallId)
    const output = flattenText(message.content)
    const result = summarizeResult(output).slice(0, RESULT_MAX)
    const tokenCost = estimateTokenCost(pending.name, output)
    this.context.toolResults += tokenCost
    const discovery = buildDiscovery(pending.name, pending.filePath, output)
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'tool_call_end',
      payload: {
        agent: this.agentName,
        tool: pending.name,
        callId: message.toolCallId,
        result,
        tokenCost,
        ...(message.isError ? { isError: true, errorMessage: result } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })
  }

  private detectModel(model: unknown, timestamp: number | null): void {
    if (typeof model !== 'string' || !model || model === this.model) return
    this.model = model
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'model_detected',
      payload: { agent: this.agentName, model },
    })
  }

  private emitMessage(role: 'user' | 'assistant' | 'thinking', text: string, timestamp: number | null): void {
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'message',
      payload: { agent: this.agentName, role, content: text.slice(0, MESSAGE_MAX) },
    })
  }

  private emitContextUpdate(total: number, timestamp: number | null): void {
    const systemPrompt = Math.min(SYSTEM_PROMPT_BASE_TOKENS, total)
    const reasoning = Math.min(this.context.reasoning, total - systemPrompt)
    const userMessages = Math.min(this.context.userMessages, total - systemPrompt - reasoning)
    const toolResults = Math.max(0, total - systemPrompt - reasoning - userMessages)
    this.delegate.emit({
      time: this.delegate.elapsed(timestamp ?? undefined),
      type: 'context_update',
      payload: {
        agent: this.agentName,
        tokens: total,
        isAuthoritative: true,
        breakdown: { systemPrompt, userMessages, toolResults, reasoning, subagentResults: 0 },
      },
    })
  }

  private setLabel(label: string): void {
    this.labelSet = true
    this.delegate.setLabel?.(label)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function flattenText(content: PiMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
