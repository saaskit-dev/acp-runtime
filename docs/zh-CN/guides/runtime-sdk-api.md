# Runtime SDK API

[English](../../guides/runtime-sdk-api.md)

这份文档描述 `acp-runtime` 当前的顶层 Public SDK。
它只描述宿主侧 runtime 概念，不描述 raw ACP protocol message。

建议阅读顺序：
- [Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)
- [Runtime SDK 可观测性](runtime-sdk-observability.md)
- [Runtime SDK 读模型说明](runtime-sdk-read-models.md)
- [Runtime SDK API 覆盖矩阵](runtime-sdk-api-coverage.md)
- 再回到本页看分组语义与类型说明

## 顶层入口

- `AcpRuntime`
- `AcpRuntimeSession`

当前内部实现分层已经收敛为：

- `AcpRuntime`
- `AcpRuntimeSession`
- `AcpSessionDriver`
- `acp/session-service.ts`
- `acp/profiles/`
- `acp/driver.ts`

## Adapter 边界

`acp-runtime` 的职责就是屏蔽不同 ACP agent 实现之间的差异。只要 runtime
已经知道 agent `type`，兼容行为默认应该放在 SDK/runtime 的 profile 或 adapter
层，而不是要求每个宿主、demo、harness 自己知道这些 workaround。

应该由 runtime 吸收的差异包括：

- registry id 与短别名启动解析
- mode id/name/URI 归一化
- auth method 差异，包括只是“交互式配置入口”的 terminal auth
- agent-specific system prompt 传递方式
- config option alias 与 value alias
- protocol shape drift 与可忽略的 agent-specific 错误

demo 和 harness 可以用来测试这些行为，但应该调用 runtime API/profile，不应该复制
每个 agent 的特殊逻辑。

## Runtime 构造

`AcpRuntime` 是宿主拿到的顶层 SDK 对象。

公开入口：
- `runtime.sessions.start(options)`
- `runtime.sessions.load(options)`
- `runtime.sessions.resume(options)`
- `runtime.sessions.list(options?)`

registry 辅助入口：
- `resolveRuntimeAgentFromRegistry(agentId)`
- `selectRuntimeAuthenticationMethod(methods)`
- `runtimeAuthenticationTerminalSuccessPatterns(method)`
- `resolveRuntimeTerminalAuthenticationRequest({ agent, method })`
- `resolveRuntimeHomePath(...segments)`
- `resolveRuntimeCachePath(...segments)`

runtime 自有状态默认现在统一放在 `~/.acp-runtime/` 下。

- `resolveRuntimeHomePath(...)` 用来解析 runtime home 根目录下的路径
- `resolveRuntimeCachePath(...)` 用来解析 `~/.acp-runtime/cache/` 下的缓存路径
- `ACP_RUNTIME_HOME_DIR` 可以覆盖 home 根目录
- `ACP_RUNTIME_CACHE_DIR` 只覆盖 cache 根目录

对于大多数宿主接入，`runtime.sessions.start({ agent: "claude-acp", ... })` 应该成为默认路径。
传入 agent id 时，runtime 会负责从 ACP registry 解析启动配置，宿主不需要重复维护 `command` / `args` 规则。
只要某个 id 存在于 ACP registry，就应该能通过这条路径启动；即使当前包还没有为
这个 agent 导出专门的 `createXxxAcpAgent(...)` helper，也不应该影响 registry id
兜底启动。专门 helper 只是可选便利 API，用于显式覆盖启动方式、包版本、环境变量或参数。
常用短别名也由同一套 registry resolver 统一归一化，所以 `claude`、`codex`、`pi`、
`copilot`、`sim`、`simulator` 可以用在任何接受 agent id 的地方。
runtime 默认会把本地会话索引维护在 `~/.acp-runtime/state/runtime-session-registry.json`。
如需改路径，传 `new AcpRuntime(factory, { state: { sessionRegistryPath } })`；如需关闭本地状态，传 `{ state: false }`。

### Initial Config

宿主希望 session 打开后立刻进入某个 mode/model/reasoning preset 时，可以传 `initialConfig`：

```ts
const session = await runtime.sessions.start({
  agent: "codex-acp",
  cwd: process.cwd(),
  initialConfig: {
    mode: "full-access",
    model: "gpt-5.4",
    effort: "high",
  },
});
```

ACP 的 config 必须等 `session/new`、`session/load` 或 `session/resume` 返回后才能知道。因此 `initialConfig` 默认是 best-effort：当前 agent 不支持、改名或移除的 option/value 会被跳过并记录到 `session.initialConfigReport`，但 session 仍然会打开。

`mode`、`model`、`effort` 是 runtime 级统一名称。runtime 会把它们映射到当前
agent 暴露的 config option id/category，并通过 agent profile 补 value alias，所以 CLI
不需要为 Codex / Claude 提供两套参数。

只有在“配置没应用成功就不应该继续运行”时，才使用 `strict: true` 或单项 `required: true`：

```ts
await runtime.sessions.start({
  agent: "claude-acp",
  cwd,
  initialConfig: {
    model: { value: "opus", required: true },
    effort: { value: "xhigh", aliases: ["max"] },
  },
});
```

### System Prompt

宿主希望在 agent 开始工作前注入 session 级指令时，可以传 `systemPrompt`：

```ts
const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd,
  systemPrompt: "用简洁、偏实现的方式回答。",
});
```

`systemPrompt` 只在 `sessions.start()` 新建 runtime session 时应用。`load` /
`resume` 会保留原 session 的指令；`sessions.load()` 和
`sessions.resume()` 不接收 `systemPrompt` option，出现这个字段会抛
`AcpSystemPromptError`。

`systemPrompt` 不是 ACP 标准字段，所以 runtime 通过 agent profile 做兼容：

- Claude ACP：在 `session/new` 的 `_meta.systemPrompt` 中传入。
- Codex ACP：启动时追加 `-c developer_instructions=<prompt>`。
- 不支持的 agent：直接抛 `AcpSystemPromptError`，不会静默忽略。

## Session 公共面

`AcpRuntimeSession` 当前暴露：

- `capabilities`
- `metadata`
- `initialConfigReport`
- `diagnostics`
- `status`
- `session.agent.*`
  - `listModes()`
  - `listConfigOptions()`
  - `setMode()`
  - `setConfigOption()`
- `session.turn.*`
  - `cancel(turnId)`
  - `start()`
  - `run()`
  - `send()`
  - `stream()`
  - `queue.clear()/sendNow()/get()/list()/remove()`
- `session.queue.*`
  - `policy()`
  - `setPolicy({ delivery })`
- `session.state.*`
  - `history.drain()`
  - `thread.entries()`
  - `diffs.keys()/get()/list()/watch()`
  - `terminals.ids()/get()/list()/watch()/refresh()/wait()/kill()/release()`
  - `toolCalls.ids()/get()/list()/bundle()/bundles()/diffs()/terminals()/watch()/watchObjects()`
  - `operations.ids()/get()/list()/bundle()/bundles()/permissions()/watch()/watchBundle()`
  - `permissions.ids()/get()/list()/watch()`
  - `metadata()`
  - `usage()`
  - `watch()`
- `session.snapshot()`
- `session.close()`

Turn 提交是 queue-first：`start()`、`send()`、`run()`、`stream()` 会自动创建 queued turn 并标记为 ready。需要显式调度时，host 保留返回的 `turnId`，再用 `session.turn.queue.sendNow(turnId)` 把这条还没开始的 queued turn 移到队首并取消当前 active turn，用 `remove(turnId)` 在未开始前撤回单条 queued turn，或用 `clear()` 一次撤回所有未开始的 queued turns。
`AcpRuntimeQueuedTurn.status` 在未 dispatch 前是 `queued`，dispatch 后等待执行时是 `ready`。

队列排空策略是 session 级语义。创建、加载、恢复时可以传 `queue: { delivery: "sequential" | "coalesce" }`，运行中可以用 `session.queue.setPolicy(...)` 修改后续 drain。
`sequential` 会一条一条发送 ready turn；`coalesce` 会把所有 ready queued prompts 合成一次 agent prompt，第一条成为实际 turn，后续被合并的 turn 会收到终态 `coalesced` 事件，并通过 `intoTurnId` 指向实际 turn。

## Agent Identity

`AcpRuntimeAgent` 可以包含：
- `command`
- `args`
- `env`
- `type`

其中：

- `type` 是 runtime 层稳定的 agent 家族标识，用于 profile 选择和 host 侧过滤

对于基于 registry 的启动，宿主可以跳过手动构造 `AcpRuntimeAgent`：

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.sessions.start({
  agent: "claude-acp",
  cwd: process.cwd(),
});
```

手动 `runtime.sessions.start({ agent })` 更适合作为需要精确覆盖启动参数时的 override 路径。

## Public 字符串常量

public discriminant 字符串仍然保持 wire-stable，但调用方应该优先使用导出的常量，而不是手写字符串：

```ts
import {
  AcpRuntimeOperationKind,
  AcpRuntimeReadModelUpdateType,
  AcpRuntimeThreadEntryKind,
  AcpRuntimeTurnEventType,
} from "@saaskit-dev/acp-runtime";

if (event.type === AcpRuntimeTurnEventType.UsageUpdated) {
  console.log(event.usage.totalTokens);
}

if (entry.kind === AcpRuntimeThreadEntryKind.AssistantMessage) {
  console.log(entry.text);
}
```

operation kind/phase、projection update type、read-model update type、content part type、prompt role、permission kind/scope、queue delivery、session status、terminal status、observability redaction kind 都遵循同一模式。

## 原生 Agent 状态

runtime session 控制现在以 agent 原生 mode 和 config options 为中心。

也就是说：
- `currentModeId` 和 `config` 是主要恢复状态
- 可以通过 `session.agent.listModes()` 与 `session.agent.listConfigOptions()` 查看 agent 支持的原生控制项
- 可以通过 `session.agent.setMode()` 与 `session.agent.setConfigOption()` 直接更新原生状态

## Session Listing 语义

`runtime.sessions.list({ source: "remote", agent, cwd })` 是 **单 agent 作用域**，不是全局列举。

它表示：
- 连到某一个具体 ACP agent 进程
- 询问这个 agent 自己知道哪些 session

它不负责跨多个 agent 聚合。

本地最近会话用 `runtime.sessions.list({ source: "local" })`。
合并视图用 `runtime.sessions.list({ source: "all", agent, cwd })`。
返回的 session reference 会在可判断时带上 `source: "local" | "remote" | "both"`。

当前 ACP agent-backed session 管理覆盖：
- `session/list`
- `session/load`
- `session/resume`
- `session/close`
- unstable `session/fork`，通过 `runtime.sessions.fork(...)` 暴露

本地 runtime session-history 管理还暴露：
- `runtime.sessions.watch(...)`
- `runtime.sessions.delete(...)`
- `runtime.sessions.refresh()`

这些本地 registry API 只作用于 runtime 自己维护的最近 session 索引。除非 ACP agent 暴露对应协议方法，否则它们不会伪装成远端 agent history 的删除或刷新。

## Prompt 模型

`AcpRuntimePrompt` 当前支持：
- 纯字符串输入
- 结构化内容块
- 带 role 的结构化消息

内容块当前支持：
- `text`
- `file`
- `image`
- `audio`
- `resource`
- `json`

## Output 模型

turn 完成结果返回：
- `outputText`
- `output`
- `turnId`

其中 `output` 是结构化 output 通道，富 UI 渲染应优先依赖它。

## Authority Handlers

宿主 authority 通过这些 handler 表达：
- `authentication`
- `filesystem`
- `permission`
- `terminal`

它们是 runtime 对 client-side delegation 的统一抽象。

authentication handler 应该使用 SDK policy helper，而不是硬编码 agent id。
`selectRuntimeAuthenticationMethod(...)` 会应用 runtime/profile metadata，例如
`acp-runtime/default-auth-method`，并在只有一个 method 时安全自动选择。
`runtimeAuthenticationTerminalSuccessPatterns(...)` 读取 profile 提供的 terminal
完成 hint；`resolveRuntimeTerminalAuthenticationRequest(...)` 从选中的 method
解析通用 terminal 执行数据。
如果没有提供 authentication handler，runtime 会在安全时自动选择并执行
protocol-only 的 `agent` auth method。terminal 和 env-var auth 仍然需要宿主
handler，因为它们涉及 UI 或本地进程执行。

## 核心公共模型

### Capabilities

`AcpRuntimeCapabilities` 包含：
- `agent`
- `agentInfo`
- `authMethods`
- `client`

`authMethods` 只描述 agent 宣告或 runtime 归一化后的登录选项。
agent-specific 登录差异由 profile 归一化成 runtime metadata。宿主侧 UI policy，
例如是否在选择 method 前询问用户，仍然属于 host / adapter 层。

完整边界说明见
[Runtime Agent Compatibility](runtime-agent-compatibility.md)。

### Session Metadata

`AcpRuntimeSessionMetadata` 包含：
- `id`
- `title`
- `currentModeId`
- `config`
- `availableCommands`

### Session Listing

`runtime.sessions.list(options)` 当前返回：
- `sessions`
- `nextCursor`

每个 session reference 当前包含：
- `agentType`
- `id`
- `cwd`
- `title`
- `updatedAt`

### Runtime State

本地 session index 是 runtime-owned 实现细节。
宿主通过 `runtime.sessions.list({ source: "local" })`、`runtime.sessions.load({ sessionId, ... })`
和 `runtime.sessions.resume({ sessionId, ... })` 使用它，不直接管理内部 registry。

### Thread Entries

`session.state.thread.entries()` 暴露 runtime 的 thread-first 只读模型。

这是一个增量读面，不会替代：
- `AcpRuntimeTurnEvent`
- `AcpRuntimeOperation`

`session.state.diffs.get(path)` 和 `session.state.terminals.get(terminalId)` 提供对 runtime-owned
tool object 的直接读取入口。

`session.state.diffs.list()` 和 `session.state.terminals.list()` 暴露的是基于同一套
thread-first 模型派生出来的 runtime-owned object view。

`session.state.diffs.keys()` 和 `session.state.terminals.ids()` 暴露当前 object-store 的索引视图。

`session.state.toolCalls.diffs(toolCallId)` 和 `session.state.toolCalls.terminals(toolCallId)`
暴露按 source tool call 分组后的 object-store 视图。

`session.state.toolCalls.ids()`、`session.state.toolCalls.list()`、`session.state.toolCalls.bundles()`、
`session.state.toolCalls.get(toolCallId)` 和 `session.state.toolCalls.bundle(toolCallId)`
暴露 tool-call 级别的 inspection 视图。

这些对象现在还带有基础生命周期元数据，例如：
- `revision`
- `createdAt`
- `updatedAt`
- 对已完成 terminal 的 `completedAt`
- 对 kill 请求的 `stopRequestedAt`
- 对 release 行为的 `releasedAt`

同时还暴露派生的 inspection 指标：
- terminal: `outputLength`, `outputLineCount`
- diff: `newLineCount`, `oldLineCount`

`session.state.watch(watcher)` 允许宿主订阅读模型更新：
- `thread_entry_added`
- `thread_entry_updated`
- `diff_updated`
- `terminal_updated`

它也会暴露 runtime 自己维护的 projection 层，覆盖：
- `operation_projection_updated`
- `permission_projection_updated`
- `metadata_projection_updated`
- `usage_projection_updated`

这一层的作用是让宿主消费稳定的 live operation / permission / session summary 状态，
而不是把 raw `AcpRuntimeTurnEvent` 直接当成状态真相。

operation / permission 状态现在也有更窄的 runtime-owned inspection 视图：
- `session.state.operations.get(operationId)`
- `session.state.operations.list()`
- `session.state.operations.permissions(operationId)`
- `session.state.operations.bundle(operationId)`
- `session.state.operations.bundles()`
- `session.state.permissions.get(requestId)`
- `session.state.permissions.list()`

同时也提供定向 watcher：
- `session.state.operations.watch(operationId, watcher)`
- `session.state.operations.watchBundle(operationId, watcher)`
- `session.state.permissions.watch(requestId, watcher)`

`session.state.diffs.watch(path, watcher)` 和 `session.state.terminals.watch(terminalId, watcher)`
提供单个 diff 或 terminal 对象的定向订阅。

`session.state.toolCalls.watchObjects(toolCallId, watcher)` 提供对某一个 tool call
关联的全部 diff/terminal 对象更新的定向订阅。

`session.state.toolCalls.watch(toolCallId, watcher)` 提供对完整 tool-call bundle 的定向订阅，
其中包括 tool call entry 本身以及分组后的 diff/terminal 对象。

事件层仍然是稳定的宿主侧 streaming 抽象。
`session.state.thread.entries()` 则是更丰富的结构化视图，面向历史恢复、tool call 检查，以及后续 thread-oriented UI。

当前 thread entry 类型包括：
- `user_message`
- `assistant_message`
- `assistant_thought`
- `plan`
- `tool_call`

`tool_call` 还可能包含：
- `locations`

当前 `tool_call.content` 类型包括：
- `content`
- `diff`
- `terminal`

`diff` 当前包含：
- `path`
- `oldText`
- `newText`
- `changeType`

`terminal` 当前包含：
- `terminalId`
- `status`
- `command`
- `cwd`
- `output`
- `truncated`
- `exitCode`

这些字段是基于 ACP tool-call content 和本地 terminal handler 能力做的 best-effort 快照，不保证所有 agent / host 组合都能填满。

另外还提供两个更窄的 runtime-side object 视图：
- `session.state.diffs.list()`
- `session.state.terminals.list()`

它们和 `session.state.thread.entries()` 共享同一底层 thread-first 模型，
目的是让宿主在不重新扫描整条 thread 的情况下，直接消费 richer diff / terminal 状态。

### Diagnostics

`AcpRuntimeDiagnostics` 当前包含：
- `lastUsage`
- `lastError`

### Operations

`AcpRuntimeOperation` 是对外部动作的统一抽象。

关键字段：
- `id`
- `turnId`
- `kind`
- `phase`
- `title`
- `target`
- `progress`
- `result`
- `failureReason`
- `permission`

`operation.permission` 是 runtime 为权限敏感动作保留的归一化证据。
当前已落地的拒绝 family 有：
- `permission_request_cancelled`
- `permission_request_end_turn`
- `mode_denied`

### Permissions

`AcpRuntimePermissionRequest` 通过这些字段把权限和动作绑定起来：
- `id`
- `turnId`
- `operationId`

顶层 turn 控制流仍保持统一。
即使底层 agent 分别表现为 `cancelled`、`end_turn + failed tool update`，或者 mode 直接拒绝，
最终权限拒绝 turn 仍然统一表现为 `AcpPermissionDeniedError`。

### Snapshot

`AcpRuntimeSnapshot` 是最小恢复模型。
它当前包含：
- `agent`
- `config`
- `currentModeId`
- `cwd`
- `mcpServers`
- `session.id`
- `version`

`agent.type` 已经内嵌在 `agent` 里。
snapshot 模型里没有独立的 runtime `agentId` 字段。

## Turn Events

当前公共 turn event 家族：
- `queued`
- `started`
- `thinking`
- `text`
- `plan_updated`
- `metadata_updated`
- `usage_updated`
- `operation_started`
- `operation_updated`
- `permission_requested`
- `permission_resolved`
- `operation_completed`
- `operation_failed`
- `completed`
- `cancelled`
- `coalesced`
- `withdrawn`
- `failed`

## Errors

顶层 typed runtime errors：
- `AcpCreateError`
- `AcpLoadError`
- `AcpResumeError`
- `AcpAuthenticationError`
- `AcpPermissionDeniedError`
- `AcpTurnCancelledError`
- `AcpTurnTimeoutError`
- `AcpProtocolError`
- `AcpProcessError`

## 示例

- [Runtime SDK Minimal Demo](runtime-sdk-minimal-demo.md)
- [Runtime SDK Demo](runtime-sdk-demo.md)
