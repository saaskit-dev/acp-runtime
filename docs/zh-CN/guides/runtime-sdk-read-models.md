# Runtime SDK 读模型说明

[English](../../guides/runtime-sdk-read-models.md)

这份文档专门解释 `session.model.*` 和 `session.live.*` 该怎么用。

如果你只想启动 session 然后跑 prompt，可以先不用看这页。
当你开始做 richer host UI、状态检查或对象级面板时，再回来看。

## 心智模型

可以把 runtime 分成三层：

1. `session.turn.*`
   这是执行 turn 的写入/控制面。

2. `session.model.*`
   这是稳定的 runtime-owned 状态，也就是 read model / object store。

3. `session.live.*`
   这是轻量级的实时 projection，适合 metadata、usage、operation / permission 投影视图。

最简单的理解是：

- 执行 turn：`session.turn.*`
- 构建稳定 UI / 状态：`session.model.*`
- 做顶部状态条或轻量实时提示：`session.live.*`

## Thread 和 Object Store 的区别

`session.model.*` 其实有两种形态。

### 1. Thread entries

用 `session.model.thread.entries()` 看 transcript 风格的线程内容：

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
const entries = session.model.thread.entries();

for (const entry of entries) {
  if (entry.kind === "assistant_message") {
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
const diffs = session.model.diffs.list();
const terminal = session.model.terminals.get("term-1");
const bundle = session.model.toolCalls.bundle("tool-call-1");
```

## 各组 API 怎么选

### `session.model.thread.*`

适合 transcript 风格视图。

- `history.drain()`
  适合 `load` 之后读取 agent replay 回来的历史片段。
- `thread.entries()`
  适合读取规范化后的 canonical thread timeline。

### `session.model.diffs.*`

适合文件变更视图。

- `keys()`
- `get(path)`
- `list()`
- `watch(path, watcher)`

### `session.model.terminals.*`

适合 terminal 状态。

- `ids()`
- `get(terminalId)`
- `list()`
- `watch(terminalId, watcher)`
- `refresh(terminalId)`
- `wait(terminalId)`
- `kill(terminalId)`
- `release(terminalId)`

### `session.model.toolCalls.*`

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

### `session.model.operations.*`

适合 operation 视角的宿主界面。

- `ids()`
- `get(operationId)`
- `list()`
- `bundle(operationId)`
- `bundles()`
- `permissions(operationId)`
- `watch(operationId, watcher)`
- `watchBundle(operationId, watcher)`

### `session.model.permissions.*`

适合单独 permission request 视角：

- `ids()`
- `get(requestId)`
- `list()`
- `watch(requestId, watcher)`

### `session.model.watch(...)`

这是统一的 read-model watcher。

会推送：

- thread entry add / update
- diff update
- terminal update

适合宿主自己维护一个本地 cache 时统一接入。

## `session.live.*` 的定位

`session.live.*` 不是 `session.model.*` 的替代品。

它更适合：

- 当前 metadata 快照
- 当前 usage 快照
- 轻量实时 projection update

```ts
const metadata = session.live.metadata();
const usage = session.live.usage();

const stopWatching = session.live.watch((update) => {
  console.log(update.type);
});
```

什么时候优先用 `session.live.*`：

- 只需要顶部状态
- 只需要轻量实时 overlay
- 不需要稳定对象索引

什么时候优先用 `session.model.*`：

- 需要稳定的 runtime-owned entity
- 需要按 id/path 直接 lookup
- 要做 transcript、terminal、diff、tool-call、operation、permission UI

## 常见宿主模式

### 模式 A：Transcript UI

用：

- `session.turn.stream(...)`
- `session.model.thread.entries()`
- `session.model.watch(...)`

建议：

- 用 `session.turn.*` 执行 turn
- 用 `thread.entries()` 渲染 transcript
- 用 `model.watch(...)` 增量更新本地 UI 状态

### 模式 B：文件改动面板

用：

- `session.model.diffs.list()`
- `session.model.diffs.watch(path, watcher)`

### 模式 C：Terminal Inspector

用：

- `session.model.terminals.list()`
- `session.model.terminals.get(id)`
- `session.model.terminals.watch(id, watcher)`
- `session.model.terminals.refresh(id)`
- `session.model.terminals.wait(id)`

### 模式 D：Tool Call 详情面板

用：

- `session.model.toolCalls.bundle(id)`
- `session.model.toolCalls.watch(id, watcher)`

建议：

- 直接把 bundle 当作一个 tool call 的顶层对象
- 不要自己再从 thread 里反向拼 diff / terminal

### 模式 E：Operation / Permission Dashboard

用：

- `session.model.operations.bundles()`
- `session.model.permissions.list()`
- `session.live.watch(...)`

建议：

- durable state 走 `operations.*` / `permissions.*`
- 轻量实时徽标或状态条走 `live.watch(...)`

## 大多数宿主应该怎么起步

如果你不确定，建议按这个顺序：

1. 先用 `session.turn.run(...)` 或 `session.turn.stream(...)`
2. 需要 transcript UI 时，加 `session.model.thread.entries()`
3. 需要 richer tool inspection 时，加 `session.model.toolCalls.bundle(...)`
4. 只有在产品真的有 diff / terminal 面板时，再接 `session.model.diffs.*` / `session.model.terminals.*`
5. 需要顶部实时状态时，再接 `session.live.watch(...)`

## 相关文档

- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK API 覆盖矩阵](runtime-sdk-api-coverage.md)
- [Runtime SDK API](runtime-sdk-api.md)

