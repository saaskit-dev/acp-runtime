# Runtime SDK API 覆盖矩阵

[English](../../guides/runtime-sdk-api-coverage.md)

这份文档把 `acp-runtime` 的 Public SDK 映射到分阶段示例与说明文档。

如果你想先按推荐顺序学习，先看
[Runtime SDK 分阶段接入](runtime-sdk-by-scenario.md)。
如果你想更深入理解 `thread`、keyed object store 和 live projection，再看
[Runtime SDK 读模型说明](runtime-sdk-read-models.md)。

## Runtime 启动值

| API | 覆盖位置 |
| --- | --- |
| `AcpRuntime` | 阶段 1 |
| `createStdioAcpConnectionFactory()` | 阶段 1 |
| `resolveRuntimeHomePath(...)` | 阶段 1 |
| `resolveRuntimeCachePath(...)` | API 文档默认路径小节 |
| `resolveRuntimeAgentFromRegistry(...)` | 阶段 3 |
| `resolveRuntimeTerminalAuthenticationRequest(...)` | 阶段 7 |
| `selectRuntimeAuthenticationMethod(...)` / `runtimeAuthenticationTerminalSuccessPatterns(...)` | demo auth adapter 与单元测试 |
| `resolveRuntimeAgentModeId(...)` / `listRuntimeAgentModeKeys(...)` | interactive smoke CLI 与单元测试 |

agent-specific 兼容通过 runtime profiles 覆盖。宿主不应该复制每个 agent 的
workaround；当新 agent 的行为和 runtime 期望的 ACP shape 不一致时，应优先在
`src/runtime/acp/profiles` 下补兼容和测试。

## Runtime Session 管理

| API | 覆盖位置 |
| --- | --- |
| `runtime.sessions.start(...)` | 阶段 1 |
| `runtime.sessions.fork(...)` | 单元测试 |
| `runtime.sessions.load(...)` | 阶段 3 |
| `runtime.sessions.resume(...)` | 阶段 3 |
| `runtime.sessions.list(...)` | 阶段 3 和阶段 6 |
| `runtime.sessions.delete(...)` | 单元测试 |
| `runtime.sessions.refresh()` | 单元测试 |
| `runtime.sessions.watch(...)` | 单元测试 |

## Session Getter

| API | 覆盖位置 |
| --- | --- |
| `session.capabilities` | 阶段 1 |
| `session.diagnostics` | 阶段 1 |
| `session.metadata` | 阶段 1 与阶段 4 |
| `session.status` | 阶段 1 与阶段 3 |

## Session Agent 控制

| API | 覆盖位置 |
| --- | --- |
| `session.agent.listModes()` | 阶段 4 |
| `session.agent.listConfigOptions()` | 阶段 4 |
| `session.agent.setMode()` | 阶段 4 |
| `session.agent.setConfigOption()` | 阶段 4 |

## Session Turn 执行

| API | 覆盖位置 |
| --- | --- |
| `session.turn.run(...)` | 阶段 1 与阶段 5 |
| `session.turn.send(...)` | 阶段 2 |
| `session.turn.stream(...)` | 阶段 2 |
| `session.turn.queue.clear()/sendNow()/get()/list()/remove()` | interactive smoke CLI：[`runtime-sdk-demo.ts`](../../examples/runtime-sdk-demo.ts) |
| `session.queue.policy()/setPolicy(...)` | interactive smoke CLI：[`runtime-sdk-demo.ts`](../../examples/runtime-sdk-demo.ts) |

## Session 读模型

| API | 覆盖位置 |
| --- | --- |
| `session.state.history.drain()` | 阶段 3 与阶段 5 |
| `session.state.thread.entries()` | 阶段 5 |
| `session.state.diffs.keys()/get()/list()/watch()` | 阶段 5 |
| `session.state.terminals.ids()/get()/list()/watch()/refresh()/wait()/kill()/release()` | 阶段 5 |
| `session.state.toolCalls.ids()/get()/list()/bundle()/bundles()/diffs()/terminals()/watch()/watchObjects()` | 阶段 5 |
| `session.state.operations.ids()/get()/list()/bundle()/bundles()/permissions()/watch()/watchBundle()` | 阶段 5 |
| `session.state.permissions.ids()/get()/list()/watch()` | 阶段 5 |
| `session.state.watch(...)` | 阶段 5 |

## Session State Projection

| API | 覆盖位置 |
| --- | --- |
| `session.state.metadata()` | 阶段 2 与阶段 5 |
| `session.state.usage()` | 阶段 2 与阶段 5 |
| `session.state.watch(...)` | 阶段 2 与阶段 5 |

## Session Handle

| API | 覆盖位置 |
| --- | --- |
| `session.snapshot()` | 阶段 1 与阶段 3 |
| `session.turn.start()` | 阶段 2 |
| `session.turn.cancel(turnId)` | 阶段 2 |
| `session.close()` | 所有阶段 |

## Authority 与宿主接入

| API | 覆盖位置 |
| --- | --- |
| `AcpRuntimeAuthorityHandlers` | 阶段 7 |
| `AcpRuntimeAuthenticationHandler` | 阶段 7 |
| `AcpRuntimeFilesystemHandler` | 阶段 7 |
| `AcpRuntimePermissionHandler` | 阶段 7 |
| `AcpRuntimeTerminalHandler` | 阶段 7 |

## Agent 启动 helper

| API | 覆盖位置 |
| --- | --- |
| `createSimulatorAgentAcpAgent(...)` | 阶段 1 显式 agent 路径 |
| `createClaudeCodeAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createCodexAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createCursorAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createGeminiCliAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createGitHubCopilotAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createOpenCodeAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `createPiAcpAgent(...)` | 与阶段 1 显式 agent 路径同模式 |
| `*_COMMAND` / `*_PACKAGE` / `*_REGISTRY_ID` 常量 | 显式启动与工具集成元数据 |

## Typed Runtime Errors

| API | 覆盖位置 |
| --- | --- |
| `AcpError` | 阶段 3 |
| `AcpAuthenticationError` | 阶段 3 |
| `AcpCreateError` | 阶段 3 |
| `AcpListError` | 阶段 3 |
| `AcpLoadError` | 阶段 3 |
| `AcpProcessError` | 阶段 3 |
| `AcpResumeError` | 阶段 3 |
| `AcpPermissionDeniedError` | 阶段 2 |
| `AcpProtocolError` | 阶段 2 |
| `AcpTurnCancelledError` | 阶段 2 |
| `AcpTurnTimeoutError` | 阶段 2 |

## Public Type 家族

package root 还导出了这些 runtime-facing type 家族，分阶段示例都会用到：

- prompt / output：`AcpRuntimePrompt`、`AcpRuntimeContentPart`、`AcpRuntimeTurnEvent`、`AcpRuntimeTurnCompletion`
- agent control：`AcpRuntimeAgentMode`、`AcpRuntimeAgentConfigOption`、`AcpRuntimeAvailableCommand`
- read model：`AcpRuntimeThreadEntry`、`AcpRuntimeDiffSnapshot`、`AcpRuntimeTerminalSnapshot`、`AcpRuntimeToolCallBundle`、`AcpRuntimeOperationBundle`、`AcpRuntimePermissionRequest`
- live projection：`AcpRuntimeProjectionUpdate`、`AcpRuntimeUsage`
- authority：`AcpRuntimeAuthorityHandlers` 及各 handler specialization
- recovery：`AcpRuntimeSnapshot`、`AcpRuntimeSessionReference`、`AcpRuntimeSessionList`

完整类型目录和语义说明见
[Runtime SDK API](runtime-sdk-api.md)。
