# Runtime SDK 读模型说明

[English](../../guides/runtime-sdk-read-models.md)

这份文档专门解释 `session.state.*` 该怎么用。

如果你只想启动 session 然后跑 prompt，可以先不用看这页。
当你开始做 richer host UI、状态检查或对象级面板时，再回来看。

## 心智模型

可以把 runtime 分成两层：

1. `session.turn.*`
   这是执行 turn 的写入/控制面。

2. `session.state.*`
   这是稳定的 runtime-owned 状态，也就是 read model / object store。
   它也包含 metadata / usage 这类轻量 projection。

最简单的理解是：

- 执行 turn：`session.turn.*`
- 查询和订阅当前 session 状态：`session.state.*`

## Thread 和 Object Store 的区别

`session.state.*` 其实有两种形态。

### 1. Thread entries

用 `session.state.thread.entries()` 看 transcript 风格的线程内容：

- user message
- assistant message
- assistant thought
- plan
- tool call entry

适合：

- 聊天 transcript
- conversation history
- 导出 transcript
- “这轮发生了什么” 这种回顾型展示

```ts
import { AcpRuntimeThreadEntryKind } from "@saaskit-dev/acp-runtime";

const entries = session.state.thread.entries();

for (const entry of entries) {
  if (entry.kind === AcpRuntimeThreadEntryKind.AssistantMessage) {
    console.log(entry.text);
  }
}
```

### 2. Object store

用 keyed object store 看稳定对象：

- diff 用 `path`
- terminal 用 `terminalId`
- tool call 用 `toolCallId`
- operation 用 `operationId`
- permission request 用 `requestId`

适合：

- 文件改动面板
- terminal 面板
- tool call 详情面板
- operation dashboard
- permission 中心

```ts
const diffs = session.state.diffs.list();
const terminal = session.state.terminals.get("term-1");
const bundle = session.state.toolCalls.bundle("tool-call-1");
```

## 各组 API 怎么选

### `session.state.thread.*`

适合 transcript 风格视图。

- `history.drain()`
  适合 `load` 之后读取 agent replay 回来的历史片段。
- `thread.entries()`
  适合读取规范化后的 canonical thread timeline。

### `session.state.diffs.*`

适合文件变更视图。

- `keys()`
- `get(path)`
- `list()`
- `watch(path, watcher)`

### `session.state.terminals.*`

适合 terminal 状态。

- `ids()`
- `get(terminalId)`
- `list()`
- `watch(terminalId, watcher)`
- `refresh(terminalId)`
- `wait(terminalId)`
- `kill(terminalId)`
- `release(terminalId)`

### `session.state.toolCalls.*`

适合按 tool call 聚合查看。

- `ids()`
- `get(toolCallId)`
- `list()`
- `bundle(toolCallId)`
- `bundles()`
- `diffs(toolCallId)`
- `terminals(toolCallId)`
- `watch(toolCallId, watcher)`
- `watchObjects(toolCallId, watcher)`

### `session.state.operations.*`

适合 operation 视角的宿主界面。

- `ids()`
- `get(operationId)`
- `list()`
- `bundle(operationId)`
- `bundles()`
- `permissions(operationId)`
- `watch(operationId, watcher)`
- `watchBundle(operationId, watcher)`

### `session.state.permissions.*`

适合单独 permission request 视角：

- `ids()`
- `get(requestId)`
- `list()`
- `watch(requestId, watcher)`

### `session.state.watch(...)`

这是统一的 read-model watcher。

会推送：

- thread entry add / update
- diff update
- terminal update

适合宿主自己维护一个本地 cache 时统一接入。

## Metadata、Usage 和 Projection 更新

`session.state.*` 也包含原本偏 live projection 的轻量状态：

- 当前 metadata 快照
- 当前 usage 快照
- operation projection update
- permission projection update

```ts
const metadata = session.state.metadata();
const usage = session.state.usage();

const stopWatching = session.state.watch((update) => {
  console.log(update.type);
});
```

如果你希望一个订阅同时覆盖 object-store 更新和轻量 projection 更新，用 `session.state.watch(...)`。

## 常见宿主模式

### 模式 A：Transcript UI

用：

- `session.turn.stream(...)`
- `session.state.thread.entries()`
- `session.state.watch(...)`

建议：

- 用 `session.turn.*` 执行 turn
- 用 `thread.entries()` 渲染 transcript
- 用 `state.watch(...)` 增量更新本地 UI 状态

### 模式 B：文件改动面板

用：

- `session.state.diffs.list()`
- `session.state.diffs.watch(path, watcher)`

### 模式 C：Terminal Inspector

用：

- `session.state.terminals.list()`
- `session.state.terminals.get(id)`
- `session.state.terminals.watch(id, watcher)`
- `session.state.terminals.refresh(id)`
- `session.state.terminals.wait(id)`

### 模式 D：Tool Call 详情面板

用：

- `session.state.toolCalls.bundle(id)`
- `session.state.toolCalls.watch(id, watcher)`

建议：

- 直接把 bundle 当作一个 tool call 的顶层对象
- 不要自己再从 thread 里反向拼 diff / terminal

### 模式 E：Operation / Permission Dashboard

用：

- `session.state.operations.bundles()`
- `session.state.permissions.list()`
- `session.state.watch(...)`

建议：

- durable state 走 `operations.*` / `permissions.*`
- 轻量实时徽标或状态条走 `live.watch(...)`

## 大多数宿主应该怎么起步

如果你不确定，建议按这个顺序：

1. 先用 `session.turn.run(...)` 或 `session.turn.stream(...)`
2. 需要 transcript UI 时，加 `session.state.thread.entries()`
3. 需要 richer tool inspection 时，加 `session.state.toolCalls.bundle(...)`
4. 只有在产品真的有 diff / terminal 面板时，再接 `session.state.diffs.*` / `session.state.terminals.*`
5. 需要顶部实时状态时，再接 `session.state.watch(...)`

## 相关文档

- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK API 覆盖矩阵](runtime-sdk-api-coverage.md)
- [Runtime SDK API](runtime-sdk-api.md)
