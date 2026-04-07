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
- [RFC-0008：Simulator Agent ACP](docs/rfcs/0008-simulator-agent.md)

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
- [Client Integration Guide](docs/client-integration-guide.md)

## Research 导航

- [Agent 权限映射调研方法](docs/research/agent-permission-mapping-methodology.md)
- [ACP Registry Agent 启动接入清单](docs/research/registry-agent-launch-catalog.md)
- [ACP 协议覆盖矩阵](docs/research/protocol-coverage-matrix.md)
- [项目场景回归矩阵](docs/research/project-scenario-matrix.md)
- [Agent 接入门禁清单](docs/research/agent-admission-checklist.md)

## 安装

当前最直接的使用方式是从源码运行：

```bash
git clone <repo>
cd acp-runtime
pnpm install
pnpm build
pnpm simulator-agent-acp
```

发布到 npm registry 后，对外安装方式是：

```bash
npm install -g simulator-agent-acp
simulator-agent-acp
```

或者：

```bash
npx simulator-agent-acp@latest
```

## Simulator Agent ACP

### Protocol Alignment

`simulator-agent-acp` 当前对齐的 ACP 版本信息分三层记录：

- 协议版本：`1`
- 官方 source repo：`https://github.com/agentclientprotocol/agent-client-protocol`
- 官方 source ref：`v0.11.4`
- 最近一次人工核对日期：`2026-04-08`
- 参考文档：
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

仓库代码同时导出了这组元数据：

- `ACP_PROTOCOL_VERSION`
- `ACP_PROTOCOL_SOURCE_REPO`
- `ACP_PROTOCOL_SOURCE_REF`
- `ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT`
- `ACP_PROTOCOL_DOCS_URL`
- `ACP_PROTOCOL_DOCS_SCHEMA_URL`

后续如果 ACP 官方文档升级，更新顺序应固定为：

1. 先更新这组元数据
2. 再补实现差异
3. 再补 harness / simulator 测试
4. 最后更新 README、接入指南和 RFC

仓库现在内置了一个可独立运行的 ACP simulator agent：

```bash
pnpm build
pnpm simulator-agent-acp
```

或者直接作为 bin 使用：

```bash
simulator-agent-acp
```

也可以直接跑最小 ACP client smoke example：

```bash
pnpm build
pnpm smoke:client-sdk
```

它会：

- 启动 `simulator-agent-acp`
- 用 ACP client SDK 连接
- `initialize`
- `newSession`
- `setSessionMode`
- 演示 title 自动生成和显式 rename
- 跑 `read` 和 `scenario full-cycle`
- 打印收到的 `session/update`

## 接入方式

`simulator-agent-acp` 默认使用 `stdio`，所以任何 ACP client 都可以把它当成普通 agent 子进程拉起。

典型接入步骤：

1. 启动 `simulator-agent-acp`
2. 用 client SDK 基于 `stdin/stdout` 建立 ACP transport
3. 调用 `initialize`
4. 调用 `session/new`
5. 按需调用：
   - `session/set_mode`
   - `session/set_model`
   - `session/set_config_option`
   - `session/prompt`

最小接入示例见：

- `src/examples/client-sdk-smoke.ts`

它基于 ACP 官方 SDK 的 `Agent` 接口实现，能被任意 ACP Client 直接通过 stdio 拉起。

当前支持：

- `initialize`
- `authenticate` / `logout`
- `session/new`
- `session/load`
- `session/list`
- `session/resume`
- `session/fork`
- `session/close`
- `session/set_mode`
- `session/set_model`
- `session/set_config_option`
- `session/prompt`
- `session/cancel`
- `session/update`
- `session/request_permission`
- `fs/read_text_file`
- `fs/write_text_file`
- MCP server config handling for `stdio` / `http` / `sse`
- `terminal/create`
- `terminal/output`
- `terminal/wait_for_exit`
- `terminal/kill`
- `terminal/release`
- NES 与 document lifecycle experimental 方法

当前范围说明：

- 这是 ACP 本地 `stdio` agent 主路径的实现与回归基线
- 不等于 remote HTTP / WebSocket transport 的完整实现
- MCP 当前支持 session 级配置接收、校验和持久化，并显式广告 `mcpCapabilities.http/sse`
- simulator 当前不会真的拨通远端 MCP server，而是把它作为 deterministic protocol surface 来校验
- `session/set_model` 在 simulator 中切换的是 profile，不是底层真实模型供应商
- `promptCapabilities.audio/image/embeddedContext` 当前支持接受并做 deterministic 摘要，不等于深度多模态推理
- `unstable_*`、NES 和 document lifecycle 属于实验性能力面

行为特性：

- Claude Code 风格三档权限模式：`read-only` / `accept-edits` / `yolo`
- 普通聊天 prompt 默认只走描述路径，不自动触发工具
- 工具与场景主要通过 slash command 触发，自然语言只保留少量明确模式
- 多步工具编排：plan -> read -> run -> write -> summarize
- 下一次 prompt 故障注入：乱序、丢事件、超时、挂起、异常退出
- `session/set_model` 在 simulator 中表示切换 profile：`Claude` / `GPT` / `Gemini`

### Protocol-first Control Surface

协议里已有专门方法的控制项，只支持协议方法，不支持 prompt shortcut：

- mode: `session/set_mode`
- model: `session/set_model`
- config option: `session/set_config_option`

prompt 入口只保留场景驱动和工具意图：

- `/read`
- `/write`
- `/bash`
- `/plan`
- `/rename`
- `/scenario`
- `/simulate`

常用启动参数：

- `--storage-dir <dir>`
- `--auth-mode none|optional|required`
- `--name <name>`
- `--title <title>`
- `--version <version>`

### Prompt Guide

常用 prompt：

- `/help`
- `/read /tmp/project/index.ts`
- `/write /tmp/project/index.ts export const value = 1;`
- `/bash git status`
- `/bash pnpm test`
- `/plan inspect | edit | verify`
- `/rename Runtime Investigation`
- `/scenario full-cycle /tmp/project/index.ts`
- `/scenario full-cycle /tmp/project/index.ts git diff --stat`

明确的自然语言也能触发少量行为：

- `plan: inspect repo | run tests | summarize`
- `rename session to Runtime Investigation`
- `do a full cycle on /tmp/project/index.ts and run \`git diff --stat\``

普通聊天例如 `hi`、`hello`、`what can you do` 不会自动触发 plan、read、write 或 run。

显式 `/plan ...` 会发布 plan，但不会假装执行并自动完成这些 step。
正文会重复输出同一组 plan step 及其状态，避免 plan 面板和正文脱节。

`/scenario full-cycle` 现在默认执行最小追加式编辑：

- 先读目标文件
- 再跑命令
- 然后只追加缺失的 simulator 标记行
- 不再用 canned content 覆盖整个文件
- 每次 step 切换都会额外发一条对应的 thought/output，方便 client 绑定 plan 与正文

Permission behavior:

- `accept-edits` 模式下会请求 permission
- simulator 会提供 `allow once` / `reject once` / `allow always` / `reject always`
- 其中 `allow always` 和 `reject always` 在 simulator 中解释为“当前 session 记住该请求”

Session title behavior:

- the first meaningful prompt auto-generates a better title
- command-only prompts do not auto-title the session
- an explicit rename uses `session_info_update`
- there is still no ACP `session/set_title` method; this remains simulator product behavior, not protocol control surface

### Failure Simulation

这些 prompt 会把故障注入到“下一次 prompt”：

- `/simulate drop-next-tool-update`
- `/simulate duplicate-next-tool-update`
- `/simulate out-of-order-next-tool-update`
- `/simulate drop-next-plan-update`
- `/simulate duplicate-next-plan-update`
- `/simulate timeout-next-prompt`
- `/simulate hang-next-prompt`
- `/simulate error-next-prompt`
- `/simulate crash-next-prompt`

也支持自然语言：

- `simulate timeout next prompt`
- `simulate out-of-order updates`
- `simulate drop next tool update`
- `simulate duplicate tool update`
- `simulate drop plan update`
- `simulate duplicate plan update`
- `simulate crash next prompt`

这些 case 适合验证 ACP client 对以下边缘情况的处理：

- `tool_call_update` 丢失
- `tool_call_update` 重复
- `tool_call_update` 先 completed 后 in_progress 的乱序
- `plan` update 丢失或重复
- prompt 长时间无响应
- prompt 卡死直到 client 主动 `session/cancel`
- agent 异常退出

### Harness Baseline

`simulator-agent-acp` 现在也作为 harness 的本地基线 agent 存在，agent id 是：

- `simulator-agent-acp-local`

harness 会直接启动本地构建产物：

- `node dist/simulator-agent/cli.js --auth-mode none --storage-dir .simulator-agent-acp-harness`

典型用法：

```bash
pnpm build
node dist/harness/run-agent-matrix.js --agent simulator-agent-acp-local
```

这条路径的目标不是替代真实 agent 矩阵，而是先验证 harness case 本身是否合理。当前做法是：

- 通用 protocol/scenario case 尽量为 simulator 提供 slash-based probe
- 不适用的 case 会显式标成 `not-applicable`
- 额外补一组 `simulator.*` baseline case，用来验证 slash surface、`session_info_update`、`/scenario full-cycle` 和 fault injection
