# Runtime SDK Demo

[English](../runtime-sdk-demo.md)

这份文档定义了 `acp-runtime` 顶层 Public SDK 的推荐宿主调用方式。
全文只使用 runtime 自己的概念：

- `AcpRuntime`
- `AcpRuntimeSession`
- `Policy`
- `Operation`
- `PermissionRequest`
- `Snapshot`
- typed runtime errors

不直接使用 ACP 原始方法，也不使用厂商私有协议细节。

## 示例源码

- [runtime-sdk-demo.ts](../../src/examples/runtime-sdk-demo.ts)

## 覆盖的场景

- 新建 session，并注入 authority handlers
- 读取 session 的 capabilities、metadata 与 diagnostics
- 执行简单文本 turn
- 发送结构化 prompt，并接收结构化 output
- 用 `stream()` 感知 operation 与 permission 生命周期
- 显式 `load()` 旧 session
- `snapshot()` 后 `resume()`
- 取消进行中的 turn
- 统一处理顶层 typed runtime errors
- 跑一条完整宿主工作流

## 示例函数

示例拆成了几组聚焦函数：

- `createSessionDemo()`
- `inspectSessionStateDemo()`
- `runSimpleTurnDemo()`
- `sendStructuredTurnDemo()`
- `streamInteractiveTurnDemo()`
- `loadAndResumeDemo()`
- `cancelTurnDemo()`
- `errorHandlingDemo()`
- `fullScenarioDemo()`

## 设计说明

- 示例里的 `runtime` 代表宿主拿到的顶层 SDK 实例
- 原生 agent 控制通过 `setAgentMode()` 与 `setAgentConfigOption()` 表达
- 权限处理通过 `permission` handler 表达，而不是 raw ACP message
- 工具执行通过 `Operation` 事件表达，而不是 `tool_call` / `tool_call_update`
- 恢复通过 `snapshot()` / `resume()` 表达
- 宿主控制流通过 typed runtime errors 表达，而不是 vendor `stopReason`
