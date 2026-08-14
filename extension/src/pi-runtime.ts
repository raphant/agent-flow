/** Pi runtime backed by persisted session JSONL files. */

import * as os from 'node:os'
import * as vscode from 'vscode'
import { createLogger } from './logger'
import { PiSessionWatcher } from './pi-session-watcher'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'

const log = createLogger('PiRuntime')

export function startPiRuntime(context: vscode.ExtensionContext): AgentRuntime {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null
  const configured = vscode.workspace.getConfiguration('agentVisualizer').get<string>('piSessionDir', '').trim()
  const watcher = new PiSessionWatcher(workspace, configured ? { sessionDir: configured } : {})
  context.subscriptions.push(watcher)

  const wiring = wireWatcherToPanel(watcher, { sessionLabelPrefix: 'Pi', runtime: 'pi' })
  watcher.start()

  const rootLabel = watcher.getWatchRoot().replace(os.homedir(), '~')
  const connectionStatus = (): string => `Pi session watcher (${rootLabel})`
  const dispose = (): void => { wiring.dispose(); watcher.dispose() }

  log.info(`Pi runtime started (sessions: ${rootLabel})`)
  return { mode: 'pi', watcher, connectionStatus, dispose }
}
