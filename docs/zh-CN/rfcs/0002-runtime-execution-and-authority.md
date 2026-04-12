[English](../../../rfcs/0002-runtime-execution-and-authority.md)

# RFC-0002：Runtime 执行生命周期与 Authority 编排

## 1. 背景

在 `RFC-0001` 明确了 Public SDK 只能暴露 runtime 自己的抽象之后，原来的 `Session 生命周期`、`Turn 模型`、`权限与 Client-Authority` 三篇文档已经不适合继续分裂维护。

原因很直接：

- session 建立、turn 执行、operation 生命周期、权限申请，其实是同一条执行链
- 把它们拆成多个 RFC，容易让实现重新退回“协议方法视角”
- 宿主真正关心的是一条连续的 runtime 执行语义，而不是 ACP 原语分章节定义

因此，本 RFC 将这些内容收敛成一条统一主线。

## 2. 目标

本 RFC 定义：

- `create / load / resume / close` 的运行时语义
- `run / send / stream / cancel` 的执行语义
- `Turn` 与 `Operation` 的关系
- 权限申请如何绑定到 operation
- authority handler 如何参与执行链
- turn 最终如何统一收束为 runtime outcome

## 3. 非目标

本 RFC 不定义：

- snapshot 结构细节
- vendor mode / config 的具体映射规则
- transcript / debug sink 落盘格式

这些内容由 `RFC-0003` 和 `RFC-0004` 负责。

## 4. 核心执行链

运行时的主链必须统一理解成：

1. 建立 session
2. session 进入 ready
3. 宿主发起 turn
4. turn 内产生零个或多个 operation
5. operation 可能触发 permission request
6. authority handler 返回决定
7. operation 收束
8. turn 收束

上层看到的始终是 runtime 语义链，而不是 ACP 方法链。

当前实现对应关系可以直接理解为：

1. `AcpRuntime` 调用 `acp/session-service.ts`
2. `session-service` 建立 ACP session 并按 `agent.type` 选择 profile
3. `AcpRuntimeSession` 通过 `AcpSessionDriver` 驱动 turn
4. `acp/driver.ts` 基于 ACP SDK 消费 `session/update` / permission / prompt 响应

进一步落到当前代码文件就是：

- `runtime.ts` 负责 registry hydrate 和 session 创建
- `session.ts` 提供 `run` / `send` / `stream` / `configure` / `cancel` / `close`
- `acp/session-service.ts` 负责 `initialize`、`newSession`、`loadSession`、`listSessions`、`resumeSession`
- `acp/driver.ts` 负责 turn 执行、permission 编排和 runtime event 发射
- `acp/session-update-mapper.ts` 负责把 ACP update 映射成 runtime event / operation

## 5. Session 生命周期

### 5.1 `create`

`create` 是 runtime 动作，表示明确新建一个 session。

约束：

- 必须显式走新建路径
- 失败直接报错
- 不允许偷偷 fallback 成 `load` 或 `resume`

### 5.2 `load`

`load` 是显式装载某个已有 session 的 runtime 入口。

约束：

- 失败直接报错
- 不允许静默新建新 session

### 5.3 `resume`

`resume` 是基于 snapshot 的恢复动作。

约束：

- 输入是 runtime snapshot，而不是仅仅一个 `sessionId`
- 失败直接报错
- 不允许 silent heal 成新 session

### 5.4 `close`

`close` 是显式终态边界。

约束：

- close 之后 session 进入终态
- 后续不能再继续正常执行 turn
- active turn 如果被 close 打断，session 仍必须保持终态

## 6. Turn 模型

### 6.1 单 active turn

单个 session 同一时刻只能存在一个 active turn。

其余 turn 必须进入 FIFO 队列。

### 6.2 统一执行流

prompt execution 和 control operation 必须共用同一串行执行流。

也就是说：

- turn
- policy 变更
- authority 相关控制动作

都不应绕开统一调度器抢占 session。

### 6.3 三层执行 API

Public SDK 继续保留三层消费方式：

- `run`
- `send`
- `stream`

但三者必须共享同一套 runtime 语义：

- 同一对象模型
- 同一 outcome 模型
- 同一错误模型

## 7. Operation 模型

### 7.1 一个外部动作尝试 = 一个 operation

operation 是 turn 内的一次结构化外部动作尝试。

例如：

- 读文件
- 写文件
- 执行命令
- 调 MCP 工具

一个底层 tool call，默认映射成一个 operation。
同一底层动作的持续 update，只更新同一个 operation。

### 7.2 一个 turn 可以包含多个 operation

例如：

- 先写文件
- 再读回验证

这是两个 operation，不是一个。

### 7.3 operation 状态

建议至少包含以下阶段：

- `proposed`
- `awaiting_permission`
- `running`
- `completed`
- `failed`
- `cancelled`

这些状态是 runtime 语义，不是 vendor raw status。

### 7.4 operation 公共字段

`Operation` 作为公共模型，不应只保留最薄的标题和状态。

建议至少保留：

- `progress`
- `result`
- `failureReason`
- `startedAt`
- `updatedAt`
- `completedAt`

这些字段属于 runtime 自己的稳定抽象，服务于宿主 UI、transcript 和后续 diagnostics。

## 8. Permission 与 Authority

### 8.1 PermissionRequest 必须关联 operation

所有权限申请都必须通过 `operationId` 绑定到某个 operation。

这条约束是强制性的。没有它，runtime 无法统一表达：

- 哪个动作申请了权限
- 哪个动作被允许
- 哪个动作被拒绝
- 哪个动作最终失败

### 8.2 一个 operation 可以有多个 permission request

runtime 必须允许：

- 零次权限申请
- 一次权限申请
- 多次权限申请

因此：

- `operationId`
- `permissionRequestId`

必须是不同标识。

### 8.3 Host authority

宿主通过 handler 参与 authority mediation：

- filesystem
- terminal
- permission
- authentication

这些 handler 参与执行链，但不应破坏 runtime 的统一语义。

相关表述建议统一为：

**host-provided authority exposed through client-side capability delegation**

避免把 authority 误解成 agent 天然拥有的环境能力。

## 9. Outcome 统一规则

turn 的最终 outcome 只能被 runtime 统一解释为：

- `completed`
- `permission_denied`
- `cancelled`
- `timeout`
- `failed`

这几个 outcome 才是 Public SDK 的控制流依据。

不应把下列 raw 细节直接当作顶层 outcome：

- vendor `stopReason`
- raw `tool_call_update`
- raw agent message text

## 10. 权限拒绝的统一收束

当 runtime 已确认：

1. 某个 operation 触发了权限申请
2. 宿主明确拒绝
3. 该 operation 未成功执行

那么顶层必须统一解释为：

- `operation_failed(permission_denied)`
- `turn.failed(AcpPermissionDeniedError)`

即使底层表现不同，例如：

- 某些 agent 表现为 `cancelled`
- 某些 agent 表现为 `end_turn + failed tool update`

也不能让这些 vendor 差异直接进入顶层控制流。

## 11. 对 Public SDK 的约束

从本 RFC 的视角，Public SDK 对外必须满足：

- `stream()` 发 runtime 事件，而不是 raw ACP event
- `run()` / `send()` 抛 runtime error，而不是 vendor-specific failure
- `permission_requested` / `permission_resolved` 必须和 operation 一起表达
- 上层不需要理解 `tool_call` / `tool_call_update`

## 12. 最终结论

`acp-runtime` 的执行主线应被视为一条统一的 runtime 语义链：

**session -> turn -> operation -> permission/authority -> outcome**

以后凡是把这条链重新拆回 ACP raw 方法列表的实现，都应视为偏离本 RFC。

[English](../../rfcs/0002-runtime-execution-and-authority.md)
