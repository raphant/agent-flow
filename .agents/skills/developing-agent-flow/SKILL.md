---
name: developing-agent-flow
description: Build, change, and verify Agent Flow across the standalone app, VS Code extension, relay, web UI, and runtime parsers.
---

# Developing Agent Flow

## When to Use

Use this skill when changing Agent Flow source, event parsing, session behavior, the canvas, panels, or runtime support.
Use `running-agent-flow-from-source` instead when the task only replaces an installed instance with this checkout.

## Architecture Map

- `app/src/app.ts` starts the standalone app, configures hooks, and uses the process working directory as the watched workspace.
- `app/src/server.ts` serves the built UI, exposes `/events` over SSE, and owns shutdown cleanup.
- `scripts/relay.ts` joins hook events, transcript watchers, session lifecycle messages, and SSE clients.
- `extension/src/protocol.ts` is the canonical extension-to-web event and session protocol.
- `web/lib/bridge-types.ts` mirrors the canonical protocol and must change with it.
- `web/lib/vscode-bridge.ts` converts browser or extension messages into web callbacks.
- `web/hooks/use-vscode-bridge.ts` buffers events and owns session selection state.
- `web/components/agent-visualizer/index.tsx` composes simulation state, panels, Review mode, and the top bar.
- `web/hooks/simulation/` converts protocol events into visual state.
- `extension/src/transcript-parser.ts` and `extension/src/codex-rollout-parser.ts` parse the two current runtime formats.

## Procedure

1. Run `git status --short --branch` and `git remote -v` before editing.
2. Read the producer, protocol, bridge, simulation handler, and renderer for the event or state that will change.
3. Update both `extension/src/protocol.ts` and `web/lib/bridge-types.ts` when the shared message shape changes.
4. Keep runtime-specific parsing in the runtime parser or watcher instead of adding runtime branches to the visualizer.
5. Extract non-trivial sorting, filtering, or formatting into a pure helper when one small Node test can cover it.
6. Use synthetic browser messages for UI states that are expensive or unsafe to create with a real agent session.
7. Run the smallest direct browser probe for the changed behavior.
8. Run the repository acceptance commands before publishing the branch.

## Safe UI Probes

Set the browser viewport before injecting data because viewport emulation can reload the page.
Inject at least two sessions when testing controls that appear only for multiple sessions.
Use synthetic labels and IDs instead of copying real prompts, paths, ticket details, or commands.

The browser bridge accepts this shape:

```js
() => {
  const now = Date.now()
  window.postMessage({
    type: 'session-list',
    sessions: [
      { id: 'test-1', label: 'First synthetic session', status: 'active', startTime: now, lastActivityTime: now },
      { id: 'test-2', label: 'Second synthetic session', status: 'completed', startTime: now - 1000, lastActivityTime: now - 1000 },
    ],
  }, '*')
}
```

For session navigation, check search, arrow keys, Enter, Escape, close controls, focus return, and narrow-screen overflow.
Use the accessibility snapshot to confirm control names and state, not only the screenshot.

## Acceptance Commands

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run build:web
pnpm run build:webview
```

When extension code or a runtime parser changes, also run:

```bash
pnpm --filter agent-flow lint
pnpm --filter agent-flow lint:test
pnpm --filter agent-flow test
pnpm run build:extension
```

Also run `pnpm run build:app` when the standalone binary or its packaged UI can change.
Run `git diff --check` after the final edit.

## Pitfalls

- Do not edit `app/dist/` or `extension/dist/` because builds generate them and Git ignores them.
- A passing Next.js build does not prove the standalone Vite bundle works.
- A passing webview build does not prove the standalone Node bundle works.
- The root `pnpm test` command does not run `extension/test/`.
- Run the extension test command when parser or watcher code changes.
- The web package has no browser test framework.
- Leave one pure test for new logic and run a direct browser probe for interaction behavior.
- Synthetic browser state disappears after a page reload or bridge reset.
- Session switching caches simulation snapshots in `AgentVisualizer`, so test switching after events have reached more than one session.

## Verification

- `pnpm test` passes, including the new helper test.
- `pnpm run build:web` compiles and completes TypeScript checks.
- `pnpm run build:webview` produces the VS Code webview bundle.
- Extension lint, test types, tests, and build pass when extension code changed.
- `pnpm run build:app` produces `app/dist/app.js` and `app/dist/webview/` when standalone behavior changed.
- The direct browser probe covers the requested state transition and keyboard path.
- `git diff --check` reports no whitespace errors.

## Canonical Sources

- `package.json` defines the repository commands.
- `app/build.js` defines the standalone package build.
- `extension/src/protocol.ts` and `web/lib/bridge-types.ts` state the mirrored protocol rule.
- `web/lib/vscode-bridge.ts` defines the accepted browser message types.
- `.gitignore` identifies generated build output.
