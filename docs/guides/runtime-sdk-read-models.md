# Runtime SDK Read Models

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-read-models.md)

This guide explains how to use the `session.state.*` surface.

If you only need to start a session and run prompts, you can ignore this page.
Come here when you are building richer host state, inspection tools, or UI views.

## Mental Model

There are two different layers:

1. `session.turn.*`
   Use this when you want to execute turns.
   It is the write/control path.

2. `session.state.*`
   Use this when you want stable runtime-owned state.
   This includes the read-model/object-store path plus lightweight metadata and usage projections.

The simplest rule is:

- run turns with `session.turn.*`
- query and watch current session state with `session.state.*`

## Thread vs Object Store

`session.state.*` has two shapes.

### 1. Thread entries

Use `session.state.thread.entries()` when you want a transcript-like view:

- user messages
- assistant messages
- assistant thoughts
- plans
- tool-call entries

This is the right surface for:

- chat transcript panes
- conversation history views
- exported session transcripts
- "what happened in this turn?" style inspection

```ts
import { AcpRuntimeThreadEntryKind } from "@saaskit-dev/acp-runtime";

const entries = session.state.thread.entries();

for (const entry of entries) {
  if (entry.kind === AcpRuntimeThreadEntryKind.AssistantMessage) {
    console.log(entry.text);
  }
}
```

### 2. Object stores

Use the keyed object stores when you want stable entities that can be looked up directly:

- diffs by `path`
- terminals by `terminalId`
- tool calls by `toolCallId`
- operations by `operationId`
- permission requests by `requestId`

This is the right surface for:

- file-change panels
- terminal inspectors
- tool-call side panels
- operation dashboards
- permission request review UIs

```ts
const diffs = session.state.diffs.list();
const terminal = session.state.terminals.get("term-1");
const bundle = session.state.toolCalls.bundle("tool-call-1");
```

## Which `session.state.*` Group To Use

### `session.state.thread.*`

Use for transcript-style views.

- `history.drain()`
  Use after `load` when you want replayed history entries that were recovered from the agent.
- `thread.entries()`
  Use for the canonical thread timeline.

### `session.state.diffs.*`

Use for file-change views.

- `keys()`
  List all diff paths known right now.
- `get(path)`
  Read one diff snapshot.
- `list()`
  Read all diff snapshots.
- `watch(path, watcher)`
  Subscribe to one diff.

### `session.state.terminals.*`

Use for terminal state.

- `ids()`
  List all known terminal ids.
- `get(terminalId)`
  Read one terminal snapshot.
- `list()`
  Read all terminal snapshots.
- `watch(terminalId, watcher)`
  Subscribe to one terminal.
- `refresh(terminalId)`
  Ask the runtime to refresh the terminal snapshot from the authority handler.
- `wait(terminalId)`
  Wait for the terminal to exit.
- `kill(terminalId)`
  Request termination through the terminal authority handler.
- `release(terminalId)`
  Mark the terminal as released on the host side.

### `session.state.toolCalls.*`

Use for grouped tool-call inspection.

- `ids()`
  List known tool call ids.
- `get(toolCallId)`
  Read the tool-call snapshot itself.
- `list()`
  Read all tool-call snapshots.
- `bundle(toolCallId)`
  Read one tool call plus its related diffs and terminals.
- `bundles()`
  Read every tool-call bundle.
- `diffs(toolCallId)`
  Read only the diffs for one tool call.
- `terminals(toolCallId)`
  Read only the terminals for one tool call.
- `watch(toolCallId, watcher)`
  Subscribe to one tool-call bundle.
- `watchObjects(toolCallId, watcher)`
  Subscribe to diff/terminal object updates scoped to one tool call.

### `session.state.operations.*`

Use when your host cares about runtime operation state rather than only transcript state.

- `ids()`
- `get(operationId)`
- `list()`
- `bundle(operationId)`
- `bundles()`
- `permissions(operationId)`
- `watch(operationId, watcher)`
- `watchBundle(operationId, watcher)`

This is useful for:

- activity panels
- operation lifecycle UIs
- permission-aware command execution surfaces

### `session.state.permissions.*`

Use for explicit permission request state.

- `ids()`
- `get(requestId)`
- `list()`
- `watch(requestId, watcher)`

This is useful when your product wants a dedicated permission center rather than
embedding permission info only inside operation rendering.

### `session.state.watch(...)`

Use this when you want one unified read-model watcher.

It emits:

- thread entry additions/updates
- diff updates
- terminal updates

Use it when you are building a read-model cache in your host and want one subscription entry point.

```ts
import { AcpRuntimeReadModelUpdateType } from "@saaskit-dev/acp-runtime";

const stopWatching = session.state.watch((update) => {
  switch (update.type) {
    case AcpRuntimeReadModelUpdateType.ThreadEntryAdded:
      break;
    case AcpRuntimeReadModelUpdateType.DiffUpdated:
      break;
    case AcpRuntimeReadModelUpdateType.TerminalUpdated:
      break;
  }
});
```

## Metadata, Usage, And Projection Updates

`session.state.*` also includes the lightweight state that used to be described as live projection:

- current metadata snapshot
- current usage snapshot
- operation projection updates
- permission projection updates

```ts
const metadata = session.state.metadata();
const usage = session.state.usage();

const stopWatching = session.state.watch((update) => {
  console.log(update.type);
});
```

Use `session.state.watch(...)` when you want one subscription for both object-store updates and lightweight projection updates.

## Typical Host Patterns

### Pattern A: Transcript UI

Use:

- `session.turn.stream(...)`
- `session.state.thread.entries()`
- `session.state.watch(...)`

Suggested approach:

- execute the turn through `session.turn.*`
- render the transcript from `thread.entries()`
- use `state.watch(...)` to incrementally update local UI state

### Pattern B: File Changes Panel

Use:

- `session.state.diffs.list()`
- `session.state.diffs.watch(path, watcher)`

Suggested approach:

- list current diffs after a tool-heavy turn
- subscribe to diffs that are currently visible in the UI

### Pattern C: Terminal Inspector

Use:

- `session.state.terminals.list()`
- `session.state.terminals.get(id)`
- `session.state.terminals.watch(id, watcher)`
- `session.state.terminals.refresh(id)`
- `session.state.terminals.wait(id)`

Suggested approach:

- treat the terminal snapshot as the stable object
- use `refresh` when your host wants a fresh output snapshot
- use `wait` only when you need terminal completion semantics

### Pattern D: Tool Call Detail Panel

Use:

- `session.state.toolCalls.bundle(id)`
- `session.state.toolCalls.watch(id, watcher)`

Suggested approach:

- use the bundle as the top-level object for one tool call
- read associated diffs and terminals from the same bundle instead of reconstructing them yourself

### Pattern E: Operation / Permission Dashboard

Use:

- `session.state.operations.bundles()`
- `session.state.permissions.list()`
- `session.state.watch(...)`

Suggested approach:

- use `operations.*` and `permissions.*` for durable state
- use `live.watch(...)` for incremental UI badges or status chips

## What Most Hosts Should Start With

If you are unsure, use this progression:

1. Start with `session.turn.run(...)` or `session.turn.stream(...)`
2. Add `session.state.thread.entries()` for transcript UI
3. Add `session.state.toolCalls.bundle(...)` if you need richer tool inspection
4. Add `session.state.diffs.*` / `session.state.terminals.*` only when your product has explicit panels for them
5. Add `session.state.watch(...)` when you need lightweight realtime overlays

## Related Guides

- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK API Coverage](runtime-sdk-api-coverage.md)
- [Runtime SDK API](runtime-sdk-api.md)
