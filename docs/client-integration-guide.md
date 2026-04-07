# Client Integration Guide

Language:
- English (default)
- [简体中文](#简体中文)

## Overview

This guide explains how to integrate `simulator-agent-acp` into an ACP client.

Protocol alignment for this guide:

- ACP protocol version: `1`
- ACP source repo: `https://github.com/agentclientprotocol/agent-client-protocol`
- ACP source ref: `v0.11.4`
- Last verified against upstream docs: `2026-04-08`
- Reference pages:
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

Audience:

- product teams integrating ACP
- engineers building ACP client SDKs or adapters
- teams running ACP smoke tests in CI

Current simulator scope:

- stdio ACP agent process
- deterministic slash-command surface
- plan, permission, file, terminal, and fault-injection flows
- MCP server config acceptance, validation, and persistence for `stdio` / `http` / `sse`
- explicit `mcpCapabilities.http/sse` advertisement during `initialize`

Boundary:

- MCP support here means protocol-surface support for configuration and capability negotiation
- the simulator does not establish or manage real remote MCP connections
- image, audio, and embedded resources are accepted and summarized deterministically rather than deeply interpreted

## 简体中文

[Back to English](#client-integration-guide)

# 客户端接入指南

本指南说明如何把 `simulator-agent-acp` 接入到任意 ACP client。

本指南对应的 ACP 版本锚点是：

- 协议版本：`1`
- 官方 source repo：`https://github.com/agentclientprotocol/agent-client-protocol`
- 官方 source ref：`v0.11.4`
- 最近一次人工核对日期：`2026-04-08`
- 参考页面：
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

目标读者：

- 正在接入 ACP 的产品团队
- 正在实现 ACP client SDK / adapter 的工程师
- 需要在 CI 里跑 ACP smoke test 的团队

## 1. Agent 形态

`simulator-agent-acp` 是一个通过 `stdio` 提供 ACP 服务的独立 agent 进程。

它的典型启动方式是：

```bash
pnpm build
pnpm simulator-agent-acp
```

或者：

```bash
simulator-agent-acp
```

常用参数：

- `--storage-dir <dir>`
- `--auth-mode none|optional|required`
- `--name <name>`
- `--title <title>`
- `--version <version>`

## 2. 通用接入步骤

任何 ACP client 的接入流程都应该是：

1. 启动 `simulator-agent-acp` 子进程
2. 用 `stdin/stdout` 建立 ACP transport
3. 调用 `initialize`
4. 调用 `session/new`
5. 按需调用：
   - `session/set_mode`
   - `session/set_model`
   - `session/set_config_option`
   - `session/prompt`

如果 client 支持这些 client-authority 方法，建议同时接上：

- `session/request_permission`
- `fs/read_text_file`
- `fs/write_text_file`
- `terminal/create`
- `terminal/output`
- `terminal/wait_for_exit`
- `terminal/kill`
- `terminal/release`

同时建议把 session setup 里的 MCP server 配置也接通：

- `stdio`
- `http`
- `sse`

当前 simulator 会接收、校验并持久化这些 MCP server 配置，并在 `initialize` 中广告 `mcpCapabilities.http/sse`。
它不会真的去建立远端 MCP 连接，而是把 MCP 作为 deterministic protocol surface 来验证 client 的接入路径。

## 3. Node SDK 接法

Node 侧最直接的方式是使用 ACP 官方 SDK：

- `ClientSideConnection`
- `ndJsonStream`

仓库里已经有可运行示例：

- [client-sdk-smoke.ts](/Users/dev/acp-runtime/src/examples/client-sdk-smoke.ts)

运行：

```bash
pnpm build
pnpm smoke:client-sdk
```

这个示例会：

1. 启动 `simulator-agent-acp`
2. 建立 ACP 连接
3. `initialize`
4. `newSession`
5. `setSessionMode("accept-edits")`
6. 发送语义 prompt
7. 发送 `/read`
8. 发送 `/rename`
9. 发送 `/scenario full-cycle`
10. 打印收到的 `session/update`

## 4. Generic stdio Client 接法

如果你的 client 不使用 ACP 官方 Node SDK，也可以按 JSON-RPC over NDJSON 的方式对接。

你需要做到：

- 向 agent `stdin` 写入 ACP request
- 从 agent `stdout` 读取 ACP response / notification
- 正确处理 `session/update`
- 正确实现 client-authority 回调

最低建议支持：

- `initialize`
- `session/new`
- `session/prompt`
- `session/request_permission`
- `fs/read_text_file`
- `fs/write_text_file`
- `terminal/*`

## 5. CI Smoke 建议

在 CI 里，建议至少保留一条最小 smoke：

1. 构建 agent
2. 启动 `simulator-agent-acp`
3. `initialize`
4. `newSession`
5. `session/set_mode`
6. 跑一条普通 prompt
7. 跑一条 `/scenario full-cycle`
8. 断言收到了：
   - `session_info_update`
   - `agent_thought_chunk`
   - `tool_call`
   - `tool_call_update`
   - `usage_update`

如果要覆盖故障恢复，再补：

- `/simulate timeout-next-prompt`
- `/simulate hang-next-prompt`
- `/simulate error-next-prompt`
- `/simulate duplicate-next-tool-update`
- `/simulate out-of-order-next-tool-update`
- `/simulate drop-next-plan-update`
- `/simulate duplicate-next-plan-update`
- `/simulate crash-next-prompt`

## 6. 推荐测试矩阵

建议 client 接入后至少覆盖：

### 协议控制面

- `initialize`
- `session/new`
- `session/load`
- `session/list`
- `session/resume`
- `session/fork`
- `session/close`
- `session/set_mode`
- `session/set_model`
- `session/set_config_option`

### Prompt 行为面

- 普通语义 prompt
- `/read`
- `/write`
- `/bash`
- `/scenario full-cycle`
- `/rename`

注意：

- 普通聊天 prompt 默认只走描述路径
- 不应期待 `hi` 之类的输入自动触发 `plan` 或工具调用
- 显式 `/plan` 只负责发布计划，不会自动把 plan step 伪装成已执行
- `/plan` 的正文输出会复述同一组 step 和当前状态，避免出现 plan 面板与正文脱节
- `session/set_model` 在 simulator 中切换的是 profile，不是底层真实模型供应商
- `promptCapabilities.audio/image/embeddedContext` 当前表示“accept + deterministic summary”，不表示深度多模态推理
- `/scenario full-cycle` 的默认编辑行为是最小追加式 diff，不是整文件覆盖
- 执行型 plan（例如 `/scenario full-cycle`）会在 step 切换时发出对应的 thought/output，便于 client 把 plan 与正文关联起来
- permission 选项会包含 `allow/reject once` 和 `allow/reject always`
- 其中 simulator 把 `allow/reject always` 解释为当前 session 级权限记忆

### 故障面

- dropped update
- out-of-order update
- timeout
- hang + cancel
- crash

## 7. Session Title 行为

`simulator-agent-acp` 对 session title 的处理是：

- 第一次有意义的 prompt 会自动生成 title
- `/rename ...` 会显式改 title
- 对 client 的暴露方式始终是 `session_info_update`

注意：

- ACP 当前有 `session_info_update`
- ACP 当前没有 `session/set_title`

所以 title 这块是 simulator 的产品行为，不是 ACP 协议控制面。

## 8. 协议面与 Prompt 面边界

本项目遵循：

- 协议已有专门方法的能力，只允许走协议方法
- prompt 只承载场景驱动和工具意图

因此：

- `mode` 只走 `session/set_mode`
- `model` 只走 `session/set_model`
- `config` 只走 `session/set_config_option`

而 prompt 保留：

- `/read`
- `/write`
- `/bash`
- `/bash`
- `/plan`
- `/rename`
- `/scenario`
- `/simulate`

自然语言只建议用于少量明确模式：

- `plan: inspect | edit | verify`
- `rename session to Runtime Investigation`
- `do a full cycle on /tmp/project/index.ts and run \`git diff --stat\``
