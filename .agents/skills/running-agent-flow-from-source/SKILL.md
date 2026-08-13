---
name: running-agent-flow-from-source
description: Replace an npx instance with this checkout and diagnose source-run or workspace-routing failures.
---

# Running Agent Flow from Source

## When to Use

Use this skill when testing a local branch through the standalone dashboard.
Use it when replacing `npx agent-flow-app`, moving the dashboard to another workspace, or diagnosing a session that does not appear.

## Core Rule

The standalone app passes `process.cwd()` to the relay as its watched workspace.
Start the app from the workspace whose Claude Code or Codex sessions you want to observe.
The Claude hook forwarder sends an event only to a live registration whose workspace contains the event working directory.
When registrations overlap, it uses the longest matching workspace path.

## Procedure

### Build

From the Agent Flow checkout, run:

```bash
pnpm install --frozen-lockfile
pnpm run build:app
```

The build creates `app/dist/app.js` and `app/dist/webview/`.
Do not edit those generated files.

### Replace an Existing Instance

1. Find the current web listener with `lsof -nP -iTCP:3001 -sTCP:LISTEN`.
2. Inspect its command with `ps -p <PID> -o pid=,ppid=,command=`.
3. Stop only the confirmed Agent Flow process and its `npm exec agent-flow-app` wrapper when one exists.
4. Confirm that port 3001 is free before starting the checkout.
5. Start the built app from the watched workspace.

```bash
AGENT_FLOW_REPO=/path/to/agent-flow
WORKSPACE=/path/to/watched-workspace
cd "$WORKSPACE"
exec node "$AGENT_FLOW_REPO/app/dist/app.js" --port 3001 --no-open
```

Keep the process attached to a terminal or a process supervisor that will preserve it.
Omit `--no-open` when the process should open the browser itself.
Use `--verbose` when event routing needs inspection.

### Verify the Running Binary

1. Find the new listener PID with `lsof -tiTCP:3001 -sTCP:LISTEN`.
2. Confirm that its command contains `app/dist/app.js` from this checkout.
3. Confirm that its process working directory equals the watched workspace.
4. Request `http://127.0.0.1:3001` and confirm that it returns the Agent Flow shell.
5. Open the dashboard and confirm that future agent events appear.

The files under `~/.claude/agent-flow/*.json` register hook targets.
A matching file contains the relay PID, normalized workspace, and internal hook-server port.
The registration `port` is not the dashboard port.
The hook server requests an ephemeral port by default, while the dashboard normally listens on 3001.

Use a bounded script that prints only `pid`, `workspace`, and `port` when inspecting registration files.
These files do not need credential values.

## Diagnose a Missing Session

1. Confirm that port 3001 belongs to the expected checkout.
2. Confirm that the server process working directory is the expected workspace.
3. Confirm that a live discovery registration has the same PID and workspace.
4. Confirm that `~/.claude/agent-flow/hook.js` exists.
5. Confirm that `~/.claude/settings.json` names `agent-flow/hook.js` without printing unrelated settings values.
6. If hook setup changed after the Claude process started, start a new Claude session before judging live hooks.
7. Generate one new prompt or tool event because the dashboard does not discover a process without events.
8. Run the app with `--verbose` if the new event still does not appear.

A server started from an unrelated directory can serve a healthy page and still receive no matching hook events.
Starting from `/path/to/projects` does not cover a session under `/different/path/workspace`.

## Pitfalls

- Do not overwrite the npx cache because the next `npx` run can replace it.
- Do not kill every Node process on the machine.
- Do not treat the discovery-file port as the web port.
- Do not assume a healthy web page proves hook routing is healthy.
- The standalone entry runs `ensureSetup()` before the server starts and can install the hook script or update Claude settings.
- Graceful shutdown removes the current discovery file and flushes relay cleanup.

## Verification

- `pnpm run build:app` succeeds from the intended branch.
- Port 3001 listens under the Node command from this checkout.
- The listener process has the intended workspace as its working directory.
- One discovery file matches the listener PID and intended workspace.
- `http://127.0.0.1:3001` responds.
- A new agent event appears in the dashboard.

## Canonical Sources

- `app/src/app.ts` sets the workspace from `process.cwd()`.
- `app/src/server.ts` owns the dashboard listener and shutdown cleanup.
- `scripts/setup.js` implements workspace matching in the Claude hook forwarder.
- `scripts/relay.ts` writes and removes discovery registrations.
- `extension/src/hook-server.ts` binds the internal hook server to an ephemeral port by default.
- `app/src/args.ts` defines `--port`, `--no-open`, and `--verbose`.
