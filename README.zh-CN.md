# acp-runtime（简体中文）

[English](README.md)

- [文档索引](docs/zh-CN/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

`acp-runtime` 是一个面向产品接入的、产品无关的 ACP 运行时。

## 仓库全局目标

这个仓库的主线目标，是把 `acp-runtime` 做成产品宿主侧的 ACP runtime 层，让未来接入真实 ACP agent 时，可以复用同一套 session、turn、permission、recovery 和 observability 模型。

`simulator-agent-acp` 的定位不是最终产品主线，而是站在 ACP agent 位置上的确定性测试替身。它用于在开发和回归测试阶段验证 runtime、本地宿主接入流程和协议行为，而不依赖真实 agent。

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

- [RFC-0001：acp-runtime 公共抽象与实现分层](docs/rfcs/0001-runtime-public-abstraction.md)
- [RFC-0002：Runtime 执行生命周期与 Authority 编排](docs/rfcs/0002-runtime-execution-and-authority.md)
- [RFC-0003：Runtime Snapshot、Policy 与 Recovery](docs/rfcs/0003-runtime-snapshot-policy-and-recovery.md)
- [RFC-0004：Runtime Diagnostics 与 Host Integration](docs/rfcs/0004-runtime-diagnostics-and-host-integration.md)
- [RFC-0005：Simulator Agent ACP](docs/rfcs/0005-simulator-agent.md)

## 建议阅读顺序

1. 先看 `RFC-0001`，理解公共抽象与实现边界
2. 再看 `RFC-0002`，理解执行生命周期、operation 和 authority
3. 再看 `RFC-0003`，理解 snapshot、policy 和 recovery
4. 最后看 `RFC-0004`，理解 diagnostics 和宿主接入边界

## 参考资料

- ACP Session Setup: https://agentclientprotocol.com/protocol/session-setup
- ACP Schema: https://agentclientprotocol.com/protocol/schema
- ACP Session Resume RFD: https://agentclientprotocol.com/rfds/session-resume
- [Client Integration Guide](docs/guides/client-integration-guide.md)

## Quick Start

如果你是把 `acp-runtime` 接到产品宿主里，建议先从这个最小例子开始：

```ts
import {
  AcpRuntime,
  AcpRuntimeJsonSessionRegistryStore,
  AcpRuntimeSessionRegistry,
  createStdioAcpConnectionFactory,
} from "@saaskit-dev/acp-runtime";

const registry = new AcpRuntimeSessionRegistry({
  store: new AcpRuntimeJsonSessionRegistryStore(".tmp/runtime-registry.json"),
});

const runtime = new AcpRuntime(createStdioAcpConnectionFactory(), { registry });

const session = await runtime.sessions.registry.start({
  agentId: "claude-acp",
  cwd: process.cwd(),
  handlers: {
    permission: () => ({ decision: "allow", scope: "session" }),
  },
});

const text = await session.turn.run("Summarize the current workspace.");
const snapshot = session.lifecycle.snapshot();

await session.lifecycle.close();
```

接下来建议按这个顺序看：
- [Runtime SDK 分阶段接入](docs/zh-CN/guides/runtime-sdk-by-scenario.md)
- [Runtime SDK 读模型说明](docs/zh-CN/guides/runtime-sdk-read-models.md)
- [Runtime SDK API 覆盖矩阵](docs/zh-CN/guides/runtime-sdk-api-coverage.md)

## 仓库结构

- `src/`：只放 runtime 库源码
- `examples/`：可直接运行的 smoke / demo 入口
- `harness/`：仓库级验证工具与 case 定义
- `packages/simulator-agent/`：独立发布的 simulator agent 包

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
npm install -g @saaskit-dev/simulator-agent-acp
simulator-agent-acp
```

或者：

```bash
npx @saaskit-dev/simulator-agent-acp@latest
```

## Runtime SDK 当前形态

当前 runtime 对外已经收敛成三个核心概念：

- `AcpRuntime`：宿主侧入口，负责 `runtime.sessions.*`
- `AcpRuntimeSession`：统一的 session 对象模型，承载 `session.agent.*`、`session.turn.*`、`session.model.*`、`session.live.*`、`session.lifecycle.*`
- `AcpSessionDriver`：内部 driver 边界，用来抹平不同 ACP agent 的行为差异

内部的 ACP 实现分成三块：

- `acp/session-service.ts`：负责 ACP session 的创建、加载、恢复、列举
- `acp/profiles/`：按 `agent.type` 选择的 agent 差异归一化策略
- `acp/driver.ts`：基于 ACP SDK 的 session driver

这里不是“为了抽象而抽象”的多协议框架。runtime 仍然是 ACP-focused，只是把不同 ACP agent 的差异收敛进统一对象模型。

对于基于 registry 的 agent 启动，runtime 现在已经提供一等入口。
宿主不需要再手写 `command` / `args`，可以直接让 runtime 从 ACP registry 解析启动配置：

```ts
const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
const session = await runtime.sessions.registry.start({
  agentId: "claude-acp",
  cwd: process.cwd(),
});
```

如果只想先拿到解析后的启动配置而不立即创建 session，可以使用 `resolveRuntimeAgentFromRegistry(agentId)`。

建议先看：
- [Runtime SDK 分阶段接入](docs/zh-CN/guides/runtime-sdk-by-scenario.md)
- [Runtime SDK API 覆盖矩阵](docs/zh-CN/guides/runtime-sdk-api-coverage.md)

## 当前验证状态

仓库现在已经对当前已接入的 ACP agent 做了 runtime 级验证：

- `simulator-agent-acp`
  - 对应测试：[src/runtime/runtime-simulator.test.ts](src/runtime/runtime-simulator.test.ts)
  - 覆盖 `create`、`send`、`configure`、`snapshot`、`resume`
- `Claude Code ACP`
  - 对应测试：[src/runtime/runtime-claude-code.test.ts](src/runtime/runtime-claude-code.test.ts)
  - 覆盖真实 stdio 启动、session 创建和 prompt 执行
- `Codex ACP`
  - 对应测试：[src/runtime/runtime-codex.test.ts](src/runtime/runtime-codex.test.ts)
  - 覆盖真实 stdio 启动、session 创建和 prompt 执行

其中 Claude Code contract test 默认会先从 ACP registry 解析启动配置。
如果 `PATH` 上已经有 `claude-agent-acp`，会优先使用本地 binary。
否则会回退到 registry 里声明的分发方式，目前 Claude 对应的是 `npx @agentclientprotocol/claude-agent-acp`。

如果希望跳过 registry 解析、强制直接走 `npx @agentclientprotocol/claude-agent-acp` 路径，可以手动执行：

```bash
ACP_RUNTIME_RUN_CLAUDE_CODE_TEST=1 pnpm test -- --run src/runtime/runtime-claude-code.test.ts
```

如果希望即使本机已经安装了 `claude-agent-acp` 也跳过这条真实环境合同测试，可以执行：

```bash
ACP_RUNTIME_SKIP_CLAUDE_CODE_TEST=1 pnpm test
```

Codex contract test 也默认会先从 ACP registry 解析启动配置。
如果 `PATH` 上已经有 `codex-acp`，会优先使用本地 binary。
否则会回退到 registry 里声明的分发方式，目前 Codex 对应的是 `npx @zed-industries/codex-acp`。

如果希望强制直接走 Codex 的 `npx` 路径，可以执行：

```bash
ACP_RUNTIME_RUN_CODEX_TEST=1 pnpm test -- --run src/runtime/runtime-codex.test.ts
```

如果希望跳过 Codex 这条真实环境合同测试，可以执行：

```bash
ACP_RUNTIME_SKIP_CODEX_TEST=1 pnpm test
```

如果 registry 启动配置解析失败，默认 `pnpm test` 仍然会跳过该合同测试，只跑 deterministic 的 simulator runtime 集成测试。

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
pnpm clean
pnpm build
pnpm simulator-agent-acp
```

运行时生成物现在默认落在 `./.tmp/` 下，避免仓库根目录堆积临时状态。

或者直接作为 bin 使用：

```bash
simulator-agent-acp
```

也可以直接跑最小 ACP client demo：

```bash
pnpm build
pnpm demo:client-sdk
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

- `examples/client-sdk-demo.ts`

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

- 三档权限模式：`read-only` / `accept-edits` / `yolo`
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

- `node dist/simulator-agent/cli.js --auth-mode none --storage-dir .tmp/simulator-agent-acp-harness`

典型用法：

```bash
pnpm build
node dist/harness/run-agent-matrix.js --agent simulator-agent-acp-local
```

这条路径的目标不是替代真实 agent 矩阵，而是先验证 harness case 本身是否合理。当前做法是：

- 通用 protocol/scenario case 尽量为 simulator 提供 slash-based probe
- 不适用的 case 会显式标成 `not-applicable`
- 额外补一组 `simulator.*` baseline case，用来验证 slash surface、`session_info_update`、`/scenario full-cycle` 和 fault injection
