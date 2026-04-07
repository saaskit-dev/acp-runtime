[English](../../../rfcs/0001-runtime-architecture.md)

# RFC-0001：acp-runtime 总体架构

- 状态：Proposed
- 日期：2026-04-03

## 1. 背景

`acp-runtime` 不是一个“把 ACP SDK 再包一层”的薄封装，而是一个面向宿主系统接入的通用运行时。

它要解决的是下面这类问题：

- 如何稳定地拉起 agent 进程并建立 ACP 连接
- 如何创建、装载、恢复 session
- 如何把一次 turn 的执行语义抽象清楚
- 如何把 mode、model、config、权限、日志、错误统一到同一个运行时里
- 如何让外部宿主系统只关心业务，不再重复实现一遍 ACP runtime

## 2. 目标

本项目的目标：

- 提供产品无关的 ACP 运行时
- 提供稳定的会话与 turn 抽象
- 提供透明、可持久化、可恢复的状态模型
- 提供可注入的权限、日志、hooks、client-authority 处理能力
- 明确错误语义与状态机，避免“看起来恢复成功，实际已新建 session”的隐式行为

## 3. 非目标

本项目不负责：

- 产品层 session 列表维护
- UI
- daemon / IPC 设计
- 业务 fallback 决策
- 产品专属消息格式
- 服务端同步协议

这些能力应由上层产品负责。

## 4. 包边界

`acp-runtime` 负责：

- agent 进程生命周期
- ACP transport / connection
- session 生命周期
- turn 生命周期
- 恢复与重连
- desired state replay
- 权限与 client-authority 回调编排
- 可观测性与错误分层

`acp-runtime` 不负责：

- 维护产品 session 注册表
- 替产品决定是否要 fallback 到新 session
- 替产品做消息投影、数据库落盘、UI 状态机

## 5. 分层架构

建议采用三层结构。

### 5.1 `AcpClient`（协议层）

职责：

- 启动 agent 进程
- 维护 JSON-RPC / ACP 连接
- 暴露 ACP 原语方法（`session/new`、`session/load`、`session/prompt` 等）
- 报告 agent capabilities
- 收发 ACP wire event

它只处理协议与连接，不处理产品语义。

接口可注入：生产用 `AcpProcessClient`（真实进程），测试用 `AcpMockClient`。

### 5.2 `AcpSessionContext`（运行时核心层）

职责：

- 管理单个 session 的生命周期
- 串行化 turn（通过 `TurnController`）
- 管理 FIFO 队列（通过 `TurnQueue`）
- 协调 `create / load / resume`
- 管理 `AcpCapabilities` 状态机（desired / current）
- 在恢复后 replay desired state（mode / model / config）
- 管理状态迁移与运行时事件发射

这一层是 runtime 的核心，不直接暴露给宿主。

### 5.3 `AcpAgent`（Facade 层）

职责：

- 面向宿主提供三层 turn API：`run` / `send` / `stream`（上层基于下层实现）
- 暴露静态工厂：`create` / `load` / `resume`
- 暴露控制方法：`cancel` / `setMode` / `setModel` / `setConfig` / `close`
- 暴露只读状态：`state` / `status` / `capabilities`

这一层是 facade。它编排内部组件，但不实现核心逻辑。

## 6. 设计原则

### 6.1 显式优先

不要把关键语义藏在“自动帮你处理”的隐式逻辑里。

特别是：

- `load !== resume`
- 恢复失败不能静默新建 session
- 历史 replay 必须和 resume 语义区分开

### 6.2 状态透明

调用方必须能拿到足够透明的状态：

- 该 session 属于哪个 agent
- 当前 session 标识是什么
- 用户希望的 mode / model / config 是什么
- 当前运行态、连接态、进程态是什么

### 6.3 运行时严格，业务层灵活

runtime 核心应该提供可推理、可验证的严格行为。

如果业务层想做 fallback、自动重建、弱一致恢复，应由业务层显式写出，而不是在 runtime 中偷偷发生。

### 6.4 组合优先于硬编码

权限、日志、hooks、文件系统、terminal 等能力都应通过接口注入，而不是绑死具体实现。

## 7. 核心对象

建议保留以下核心对象：

- `AcpAgent`（facade，公开 API）
- `AcpSessionContext`（session 运行时核心，内部）
- `AcpClient`（协议层接口）
- `AcpProcessClient`（AcpClient 的真实进程实现）
- `AcpMockClient`（AcpClient 的测试 mock 实现）
- `TurnController`（turn 串行化 + deferred 控制，内部）
- `TurnQueue`（FIFO 队列，内部）
- `AcpCapabilities`（desired/current 状态机，内部）
- `AcpState`（可持久化状态）
- `AcpPermissionHandler`
- `AcpLogger`
- `Channel`（push/pull 桥接，内部）

## 8. RFC 拆分

完整方案拆成以下 RFC：

- `0001-runtime-architecture.md`
- `0002-session-lifecycle.md`
- `0003-turn-model.md`
- `0004-state-and-recovery.md`
- `0005-permissions-and-client-authority.md`
- `0006-observability-and-errors.md`
- `0007-host-integration.md`

## 9. 最终结论

`acp-runtime` 应该被视为“ACP 运行时内核”，而不是“ACP SDK 辅助工具”。

这意味着：

- 它必须拥有清晰的分层
- 必须有独立的状态机与错误模型
- 必须把恢复、turn、权限、观测等核心语义一次性设计清楚
- 实时状态诊断通过 `agent.status` 属性和可观测性体系表达（hooks / events / logger）
- `AcpState` 只包含恢复所需信息，不包含运行时瞬态

后续各 RFC 在这个总架构下分别细化。

[English](../../rfcs/0001-runtime-architecture.md)
