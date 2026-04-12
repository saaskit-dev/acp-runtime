[English](../../../rfcs/0001-runtime-public-abstraction.md)

# RFC-0001：acp-runtime 公共抽象与实现分层

- 状态：Proposed
- 日期：2026-04-12

## 1. 背景

前面的 RFC 已经定义了 `acp-runtime` 的总体方向：它应该是一个面向宿主系统的 ACP 运行时，而不是 ACP SDK 的薄封装。

但当前还有一个关键问题没有完全定死：

- `acp-runtime` 的公共 SDK 到底应该暴露什么
- 哪些是 runtime 自己的稳定语义
- 哪些只是 ACP 或厂商 agent 的底层实现细节
- 定义、SDK、内部实现三者的关系应该如何约束

如果这件事不先设计清楚，后续实现很容易出现三种漂移：

1. 顶层 SDK 直接泄漏 ACP wire 概念
2. 内部为了快速接通不同 agent，把厂商细节一路透传到宿主
3. RFC 写的是一种抽象，代码对外暴露的却是另一种模型

本 RFC 的目的，就是把 `acp-runtime` 的公共抽象一次性定义清楚，并明确：

- 公共 SDK 是定义层的公开投影
- 内部实现必须服从公共抽象
- ACP / vendor 细节只能存在于 adapter 和 diagnostics 层

## 2. 目标

本 RFC 的目标：

- 定义 `acp-runtime` 的公共对象模型
- 定义 turn 的公共事件模型
- 定义 `run/send/stream` 的统一错误模型
- 定义工具调用在公共抽象里的统一表示
- 定义权限申请与 operation 的关联方式
- 定义运行时从宿主到真实 ACP agent 的完整生命周期分层
- 明确“先定义公共抽象，再按抽象向下实现”的工程约束

## 3. 非目标

本 RFC 不负责：

- 规定具体 UI 应该怎么展示 operation 或 permission
- 规定 transcript / logger 的最终落盘格式
- 给每个 vendor mode / model / config 做统一命名
- 直接替业务层决定 fallback 策略

这些能力仍然属于后续 RFC 或宿主系统职责。

## 4. 核心结论

`acp-runtime` 的对外 API 必须只暴露 runtime 自己的语义，而不能让宿主直接面向 ACP / vendor 原语编程。

换句话说：

- 顶层 SDK 只暴露 runtime 概念
- ACP 和厂商差异只存在于内部 adapter
- 原始 wire 数据只进入 diagnostics

本 RFC 采用的基本原则是：

**定义先于实现，公共抽象高于协议细节。**

当前代码中的最终落点已经收敛为：

- `AcpRuntime`
- `AcpRuntimeSession`
- `AcpSessionDriver`
- `acp/session-service.ts`
- `acp/profiles/`
- `acp/driver.ts`

也就是说，公共 SDK 只暴露 runtime 语义；ACP session 编排、agent 差异归一化和 SDK 通信都留在内部。

## 4.1 当前代码映射

当前 `src/runtime` 目录与本 RFC 的对应关系是：

- `runtime.ts`：宿主侧 runtime facade
- `session.ts`：宿主侧 session 对象
- `session-driver.ts`：内部 driver 边界
- `session-registry.ts`：宿主自有 snapshot 索引
- `acp/session-service.ts`：ACP session 编排
- `acp/profiles/`：按 agent 归一化差异的策略层
- `acp/driver.ts`：基于 ACP SDK 的 session driver

对象关系可以直接理解为：

`AcpRuntime -> AcpRuntimeSession -> AcpSessionDriver`

宿主只依赖前两个对象，driver 只作为内部归一化边界存在。

## 5. 分层模型

建议把 `acp-runtime` 明确分成四层。

### 5.1 Public SDK

这一层是宿主唯一应该直接依赖的 API。

职责：

- 暴露 `create / load / resume / close`
- 暴露 `run / send / stream / cancel`
- 暴露 `snapshot`
- 暴露 runtime 自己的类型、事件、错误

它不应暴露：

- `session/request_permission`
- `tool_call`
- `tool_call_update`
- vendor `stopReason`
- vendor-specific optionId / mode 名字
- 原始 session update

### 5.2 Runtime Core

这一层是运行时的语义内核。

职责：

- Session 状态机
- Turn 状态机
- Operation 状态机
- 权限状态机
- 结果归一化
- 错误归一化
- 快照生成与恢复语义

这一层是 `acp-runtime` 的真正核心。

### 5.3 ACP Adapter

这一层负责与真实 ACP agent 通信。

职责：

- 建立 ACP 连接
- 发送 `initialize / authenticate / session/new / session/prompt` 等协议方法
- 接收 `session/update` 与 `session/request_permission`
- 将 raw ACP update 映射到 Runtime Core 的语义对象
- 维护 vendor id 与 runtime id 的内部映射

### 5.4 Diagnostics

这一层只服务于调试、审计、研究和 harness。

职责：

- transcript
- raw event sink
- vendor metadata
- debug logging

Diagnostics 不能反向污染 Public SDK。

## 6. 公共对象模型

### 6.1 Session

`Session` 是一段长期存在的运行时协作上下文。

它代表：

- 一个宿主与某个 agent 的已建立 runtime 会话
- 一个可持续运行多个 turn 的上下文
- 一个可以 snapshot / resume / close 的对象

`Session` 是顶层主要对象。

### 6.2 Turn

`Turn` 是 `Session` 内的一次执行单元。

一个 turn 一般对应一次 prompt 驱动的执行过程。它具有自己的生命周期：

- 排队
- 开始
- 中途产出文本 / 思考 / 计划 / operation 更新
- 成功完成或失败收束

一个 session 同一时刻只能有一个 active turn。

### 6.3 Operation

`Operation` 是 turn 内的一次结构化外部动作尝试。

它是公共抽象里对底层 `tool_call` 的语义化替代，不直接等于任何 ACP 原始消息。

典型 operation：

- 读文件
- 写文件
- 执行命令
- 调 MCP 工具
- 发网络请求
- 文档编辑

一个底层 tool call，默认映射为一个 operation。
同一个 tool call 的持续更新，属于同一个 operation 的状态变化，而不是多个 operation。

一个 turn 可以包含多个 operation。

### 6.4 PermissionRequest

`PermissionRequest` 是 runtime 视角下的权限申请对象。

它不是 raw `session/request_permission` 包，而是一个语义对象，表达：

- agent 想执行哪一个 operation
- 该 operation 需要宿主授权
- 宿主可给出的授权范围是什么

`PermissionRequest` 必须通过 `operationId` 关联到具体 operation。

### 6.5 Snapshot

`Snapshot` 是一个可持久化恢复点。

它只保存恢复 session 所必需的最小信息，不是整个 runtime 内存快照，也不是 transcript。

### 6.6 Policy

`Policy` 是宿主提供给 runtime 的运行意图。

它表达：

- 权限策略
- authority 约束
- 恢复后应重放的期望配置

`Policy` 是 runtime 语义，不应直接等于 vendor 的 mode / config 名字。

### 6.7 Capabilities

`Capabilities` 是 runtime 暴露给宿主的能力协商结果对象。

它至少应显式包含：

- agent 自身能力
- agent 信息
- 可用认证方式
- host 声明并参与协商的 client-side capability

`initialize` 的准确语义应理解为：

- 宿主先发起 capability negotiation
- agent 在响应里声明自身能力
- 宿主方法实现始终保留在本地，由 ACP SDK 在后续运行时回调

Public SDK 不应让宿主自己直接处理 raw `initialize` payload。

### 6.8 SessionMetadata

`SessionMetadata` 是 session 的只读公共状态视图。

它至少应能够承接：

- session id
- title
- current mode 的 runtime 侧表示
- runtime 已确认的 config 状态
- available commands

### 6.9 Usage

`Usage` 是 runtime 暴露给宿主的资源消耗视图。

它属于 runtime 公共语义的一部分，不应迫使宿主改为消费 raw `usage_update`。

### 6.10 Diagnostics

`Diagnostics` 是 Public SDK 可读但不反向控制主流程的诊断视图。

它只应暴露 runtime 归一后的诊断信息，例如：

- last usage
- last error summary

## 7. 生命周期模型

完整的 `acp-runtime` 应定义以下生命周期阶段：

1. `Bootstrap`
   - 启动 agent
   - 建立连接
   - initialize
   - 可选 authenticate

2. `Session Establishment`
   - `create`
   - `load`
   - `resume`

3. `Session Configuration`
   - 应用 runtime policy
   - 重放 desired state

4. `Ready`
   - session 可运行 turn

5. `Turn Execution`
   - `run / send / stream`
   - queue / start / updates / finish

6. `Authority Mediation`
   - filesystem
   - terminal
   - permission
   - authentication

7. `Outcome Resolution`
   - completed
   - permission_denied
   - cancelled
   - timeout
   - failure

8. `Persistence and Recovery`
   - `snapshot`
   - `resume`

9. `Close`
   - 关闭 session
   - 关闭进程 / transport
   - 实例进入终态

## 8. 公共事件模型

`stream()` 对外只应暴露 runtime 自己的事件，而不是 raw ACP update。

建议事件集合如下：

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
- `failed`

其中：

- `permission_requested` 与 `permission_resolved` 必须携带关联的 `operationId`
- `completed` 与 `failed` 是 turn 终态
- `failed` 应携带 runtime 自己的错误对象

`raw-session-update` 不属于公共事件模型。

## 9. Operation 状态模型

建议 operation 至少具有如下阶段：

- `proposed`
- `awaiting_permission`
- `running`
- `completed`
- `failed`
- `cancelled`

语义如下：

- `proposed`
  runtime 已知 agent 想做一个动作，但尚未真正执行
- `awaiting_permission`
  该动作卡在授权上
- `running`
  授权完成并开始执行
- `completed`
  成功完成
- `failed`
  执行失败
- `cancelled`
  因 turn 取消而中止

## 10. Permission 与 Operation 的关联

权限语义必须和 operation 强绑定。

建议约束：

- `Operation` 有自己的 `operationId`
- `PermissionRequest` 有自己的 `permissionRequestId`
- `PermissionRequest` 必须带 `operationId`

即：

**一个 operation 可以关联零个、一个或多个 permission request。**

这样才能表达：

- 有的 operation 不需要权限
- 有的 operation 只申请一次权限
- 有的 operation 在不同阶段多次申请权限

公共模型不直接暴露 vendor `toolCallId`。
但 ACP Adapter 内部必须维护：

- `vendorToolCallId -> operationId`
- `vendorPermissionRequestId -> permissionRequestId`

## 11. 工具调用的统一映射规则

Runtime Core 必须遵守以下映射规则：

1. 一个独立的外部动作尝试，映射为一个 operation
2. 同一动作的持续 update，只更新该 operation，不新建 operation
3. 一个 turn 可以包含多个 operation
4. 权限请求不是 operation 本身，而是 operation 的授权环节

特别地：

- 如果 vendor 先发 `tool_call`，runtime 应先创建 operation
- 如果 vendor 没先发 `tool_call`，而是直接在 permission request 中带待执行动作，runtime 也必须合成 operation

宿主不应该因为不同 vendor 事件顺序不同，而看到不同的公共模型。

## 12. 公共错误模型

`run()` 和 `send()` 只应抛 runtime 自己的统一错误。

建议最小集合：

- `AcpPermissionDeniedError`
- `AcpTurnCancelledError`
- `AcpTurnTimeoutError`
- `AcpAuthenticationError`
- `AcpCreateError`
- `AcpLoadError`
- `AcpResumeError`
- `AcpProtocolError`
- `AcpProcessError`

其中最关键的统一规则是：

当 runtime 已确认：

1. 某个 operation 触发了权限申请
2. 宿主明确拒绝
3. 该 operation 未成功执行

则无论 vendor 最终表现为：

- `stopReason: cancelled`
- `end_turn + failed tool update`
- 其他厂商等价信号

顶层都必须统一为：

- `operation_failed(permission_denied)`
- `failed(AcpPermissionDeniedError)`

这就是 runtime 对上层的统一结果。

## 13. Public SDK 设计约束

对外 SDK 必须满足：

1. 宿主只面向 runtime 概念编程
2. 宿主不需要理解 ACP wire 细节
3. 宿主不需要理解 vendor-specific stopReason / optionId / tool 名字
4. 顶层事件与错误必须具有跨 vendor 稳定性
5. 公共只读模型必须显式包含 `Capabilities`、`SessionMetadata`、`Usage`、`Diagnostics`

这意味着：

- `raw-session-update` 不应出现在 Public SDK
- `completed.stopReason` 不应出现在 Public SDK
- raw vendor message text 不应成为顶层控制流语义的一部分

如果需要保留 vendor 细节，必须进入 Diagnostics 层，而不是 Public SDK。

## 14. 定义与实现的关系

本 RFC 明确以下工程约束：

### 14.1 定义是 source of truth

运行时的权威语义来自 RFC 与公共类型，而不是某段现有实现。

### 14.2 SDK 是定义的公开投影

Public SDK 只能暴露已经在定义层存在的概念。

如果某个概念没有在定义层被确认，就不应直接成为公共 API。

### 14.3 testing seam 不是正式宿主入口

Public SDK 可以保留 testing-only seam 供测试和内部 wiring 使用。

但必须满足：

- 该 seam 需显式标记为 testing-only
- 它不能伪装成正式宿主入口
- 宿主接入文档不应鼓励依赖它

### 14.3 实现服从定义

内部实现负责把真实 ACP 行为映射到公共抽象，而不是反过来让公共抽象去适配实现细节。

### 14.4 允许删除不符合抽象的实现

如果现有实现已经明显把错误的概念泄漏成了公共 API，允许删除或重写这些实现。

优先级应为：

1. 先稳定公共模型
2. 再按模型实现 Public SDK
3. 再向下实现 Runtime Core
4. 最后连接 ACP Adapter 与 Diagnostics

## 15. 对当前实现的约束性结论

从本 RFC 的视角，后续实现必须满足：

- 顶层只暴露 runtime 公共模型
- raw ACP event 只进内部与 diagnostics
- permission、operation、turn outcome 必须按本 RFC 统一
- 先写公共类型与公共测试，再做向下实现

这意味着未来的实现顺序应更偏“自顶向下”：

1. 先定 Public SDK 类型
2. 先写宿主视角测试
3. 再实现 Runtime Core
4. 再接 ACP Adapter

## 16. 最终结论

`acp-runtime` 的真正职责，不是把 ACP SDK 包一层，而是：

**定义一套稳定的宿主运行时语义，并把所有 ACP 与厂商差异吸收到内部。**

因此：

- Public SDK 应只暴露 runtime 抽象
- Runtime Core 应承载语义归一化
- ACP Adapter 应吸收 vendor 差异
- Diagnostics 应保存 raw 证据

以后凡是与这套公共抽象冲突的实现，都不应以“已经写了”为理由继续保留。

[English](../../rfcs/0001-runtime-public-abstraction.md)
