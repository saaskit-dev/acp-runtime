# acp-runtime

`acp-runtime` 是一个面向产品接入的、产品无关的 ACP 运行时。

它的目标不是“把 ACP SDK 包一层”，而是定义一套稳定的运行时原语：

- agent 进程生命周期
- ACP 连接与协议交互
- session 生命周期
- turn 执行模型
- 状态持久化与恢复
- 权限与 client-authority 方法
- 可观测性与错误模型

## 核心立场

本仓库坚持以下原则：

- `create`、`load`、`resume` 是三种不同语义
- `load !== resume`
- `load` / `resume` 失败默认直接报错
- runtime 不允许隐式 fallback 到 `session/new`
- 只使用单一 `session.id` 作为 ACP session 标识
- 产品层自己持有 session 列表与 fallback 决策

## RFC 导航

- [RFC-0000：术语与核心类型索引](docs/rfcs/0000-glossary-and-types.md)
- [RFC-0001：总体架构](docs/rfcs/0001-runtime-architecture.md)
- [RFC-0002：Session 生命周期](docs/rfcs/0002-session-lifecycle.md)
- [RFC-0003：Turn 执行模型](docs/rfcs/0003-turn-model.md)
- [RFC-0004：状态模型与恢复](docs/rfcs/0004-state-and-recovery.md)
- [RFC-0005：权限与 Client-Authority 方法](docs/rfcs/0005-permissions-and-client-authority.md)
- [RFC-0006：可观测性与错误模型](docs/rfcs/0006-observability-and-errors.md)
- [RFC-0007：宿主接入模型](docs/rfcs/0007-host-integration.md)

## 建议阅读顺序

1. 先看术语与核心类型索引
2. 再看总体架构，理解包边界与分层
3. 再看 session / turn / state 三个主干 RFC
4. 然后看权限、观测、错误
5. 最后看宿主接入模型

## 参考资料

- ACP Session Setup: https://agentclientprotocol.com/protocol/session-setup
- ACP Schema: https://agentclientprotocol.com/protocol/schema
- ACP Session Resume RFD: https://agentclientprotocol.com/rfds/session-resume

## Research 导航

- [Agent 权限映射调研方法](docs/research/agent-permission-mapping-methodology.md)
- [ACP Registry Agent 启动接入清单](docs/research/registry-agent-launch-catalog.md)
- [ACP 协议覆盖矩阵](docs/research/protocol-coverage-matrix.md)
- [项目场景回归矩阵](docs/research/project-scenario-matrix.md)
- [Agent 接入门禁清单](docs/research/agent-admission-checklist.md)
