# Runtime SDK Read Models

Language:
- English (default)
- [简体中文](../zh-CN/guides/runtime-sdk-read-models.md)

This guide explains how to use the `session.model.*` and `session.live.*` surfaces.

If you only need to start a session and run prompts, you can ignore this page.
Come here when you are building richer host state, inspection tools, or UI views.

## Mental Model

There are three different layers:

1. `session.turn.*`
   Use this when you want to execute turns.
   It is the write/control path.

2. `session.model.*`
   Use this when you want stable runtime-owned state.
   This is the read-model / object-store path.

3. `session.live.*`
   Use this when you want lightweight live projection updates such as metadata, usage,
   operation projection, or permission projection.

The simplest rule is:

- run turns with `session.turn.*`
- build durable UI/state from `session.model.*`
- use `session.live.*` for small realtime overlays and host status summaries

## Thread vs Object Store

`session.model.*` has two shapes.

### 1. Thread entries

Use `session.model.thread.entries()` when you want a transcript-like view:

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
const entries = session.model.thread.entries();

for (const entry of entries) {
  if (entry.kind === "assistant_message") {
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
const diffs = session.model.diffs.list();
const terminal = session.model.terminals.get("term-1");
const bundle = session.model.toolCalls.bundle("tool-call-1");
```

## Which `session.model.*` Group To Use

### `session.model.thread.*`

Use for transcript-style views.

- `history.drain()`
  Use after `load` when you want replayed history entries that were recovered from the agent.
- `thread.entries()`
  Use for the canonical thread timeline.

### `session.model.diffs.*`

Use for file-change views.

- `keys()`
  List all diff paths known right now.
- `get(path)`
  Read one diff snapshot.
- `list()`
  Read all diff snapshots.
- `watch(path, watcher)`
  Subscribe to one diff.

### `session.model.terminals.*`

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

### `session.model.toolCalls.*`

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

### `session.model.operations.*`

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

### `session.model.permissions.*`

Use for explicit permission request state.

- `ids()`
- `get(requestId)`
- `list()`
- `watch(requestId, watcher)`

This is useful when your product wants a dedicated permission center rather than
embedding permission info only inside operation rendering.

### `session.model.watch(...)`

Use this when you want one unified read-model watcher.

It emits:

- thread entry additions/updates
- diff updates
- terminal updates

Use it when you are building a read-model cache in your host and want one subscription entry point.

```ts
const stopWatching = session.model.watch((update) => {
  switch (update.type) {
    case "thread_entry_added":
      break;
    case "diff_updated":
      break;
    case "terminal_updated":
      break;
  }
});
```

## How `session.live.*` Fits In

`session.live.*` is not a replacement for `session.model.*`.

Use it for:

- current metadata snapshot
- current usage snapshot
- lightweight live projection updates

```ts
const metadata = session.live.metadata();
const usage = session.live.usage();

const stopWatching = session.live.watch((update) => {
  console.log(update.type);
});
```

Prefer `session.live.*` when:

- you need top-line status
- you want lightweight turn overlays
- you do not need durable keyed objects

Prefer `session.model.*` when:

- you need stable runtime-owned entities
- you need direct lookup by id/path
- you are building transcript, terminal, diff, tool-call, operation, or permission UI

## Typical Host Patterns

### Pattern A: Transcript UI

Use:

- `session.turn.stream(...)`
- `session.model.thread.entries()`
- `session.model.watch(...)`

Suggested approach:

- execute the turn through `session.turn.*`
- render the transcript from `thread.entries()`
- use `model.watch(...)` to incrementally update local UI state

### Pattern B: File Changes Panel

Use:

- `session.model.diffs.list()`
- `session.model.diffs.watch(path, watcher)`

Suggested approach:

- list current diffs after a tool-heavy turn
- subscribe to diffs that are currently visible in the UI

### Pattern C: Terminal Inspector

Use:

- `session.model.terminals.list()`
- `session.model.terminals.get(id)`
- `session.model.terminals.watch(id, watcher)`
- `session.model.terminals.refresh(id)`
- `session.model.terminals.wait(id)`

Suggested approach:

- treat the terminal snapshot as the stable object
- use `refresh` when your host wants a fresh output snapshot
- use `wait` only when you need terminal completion semantics

### Pattern D: Tool Call Detail Panel

Use:

- `session.model.toolCalls.bundle(id)`
- `session.model.toolCalls.watch(id, watcher)`

Suggested approach:

- use the bundle as the top-level object for one tool call
- read associated diffs and terminals from the same bundle instead of reconstructing them yourself

### Pattern E: Operation / Permission Dashboard

Use:

- `session.model.operations.bundles()`
- `session.model.permissions.list()`
- `session.live.watch(...)`

Suggested approach:

- use `operations.*` and `permissions.*` for durable state
- use `live.watch(...)` for incremental UI badges or status chips

## What Most Hosts Should Start With

If you are unsure, use this progression:

1. Start with `session.turn.run(...)` or `session.turn.stream(...)`
2. Add `session.model.thread.entries()` for transcript UI
3. Add `session.model.toolCalls.bundle(...)` if you need richer tool inspection
4. Add `session.model.diffs.*` / `session.model.terminals.*` only when your product has explicit panels for them
5. Add `session.live.watch(...)` when you need lightweight realtime overlays

## Related Guides

- [Runtime SDK By Scenario](runtime-sdk-by-scenario.md)
- [Runtime SDK API Coverage](runtime-sdk-api-coverage.md)
- [Runtime SDK API](runtime-sdk-api.md)

