[English](../../../rfcs/0005-simulator-agent.md)

# RFC-0005：Simulator Agent ACP

- 状态：Draft
- 日期：2026-04-03
- ACP 协议版本锚点：`protocolVersion = 1`
- ACP 官方 source repo：`https://github.com/agentclientprotocol/agent-client-protocol`
- ACP 官方 source ref：`v0.11.4`
- ACP 最近一次人工核对日期：`2026-04-08`
- 参考页面：
  - `https://agentclientprotocol.com/protocol/overview`
  - `https://agentclientprotocol.com/protocol/draft/schema`

## 1. 背景

`acp-runtime` 需要一个可以独立运行、严格遵守 ACP 协议、并能被任意 ACP Client 直接连接的 simulator agent。

它不是简单的 mock，也不是只服务 harness 的 stub，而是：

- 一份真实的 ACP Agent 实现
- 一份协议级 simulator / baseline 实现
- 一份 deterministic 的测试基座
- 一份可直接接入其他 ACP Client 的独立 CLI

## 2. 目标

- 基于官方 ACP SDK 的 `Agent` 接口实现完整 Agent 侧方法面
- 支持 `stdio` 运行模式，供任意 ACP Client 直接启动
- 支持稳定协议能力：
  - `initialize`
  - `authenticate`
  - `session/new`
  - `session/load`
  - `session/prompt`
  - `session/cancel`
  - `session/update`
- 同时实现当前 SDK 中暴露的 experimental / unstable 能力：
  - `session/list`
  - `session/fork`
  - `session/resume`
  - `session/close`
  - `session/set_model`
  - `logout`
  - NES
  - document lifecycle notifications
- 支持通过 ACP Client 回调完成：
  - 权限请求
  - 文件读写
  - terminal 生命周期

## 3. 非目标

- 不模拟具体商业 Agent 的模型策略
- 不追求“像 Claude/Codex 一样”的产品行为
- 不内置真正的 LLM 推理依赖

Simulator Agent 的目标是“严格协议实现 + 可预测行为”，而不是“仿真某个第三方 Agent 的体验”。

## 4. 设计原则

### 4.1 严格协议优先

- 只在 advertised capability 范围内接受可选方法
- 参数不合法时返回协议错误
- 不隐式 fallback 到其他方法
- `load !== resume`

### 4.2 可独立运行

Simulator Agent 必须能够以 CLI 形式启动：

```bash
simulator-agent-acp
```

并通过 stdio 与 ACP Client 建立连接。

### 4.3 deterministic

Simulator Agent 的 prompt 执行逻辑必须可预测，便于：

- runtime 回归测试
- transcript 证据采集
- 故障定位

## 5. 当前实现边界

当前实现边界必须始终相对于上面的 ACP 文档锚点理解，而不是抽象地写成“兼容最新”。

当前实现提供：

- session 持久化
- session list / load / resume / fork / close
- mode / model / config 状态
- prompt turn 与 `session/update`
- tool call / tool call update
- permission request
- MCP server config handling for `stdio` / `http` / `sse`
- filesystem read/write through client authority
- terminal create/output/wait/kill/release through client authority
- usage update / plan / available commands / session info update
- NES start / suggest / close
- document didOpen / didChange / didClose / didSave / didFocus
- auth / logout

当前不应被误解为“已经完整覆盖”的范围：

- remote HTTP / WebSocket transport
- 所有 prompt content block 的深度语义处理
- 真实远端 MCP server 建联、同步和生命周期管理
- 所有 experimental / unstable 能力的完整宿主互操作
- 所有 ACP schema 分支的逐项 conformance 证明

## 6. 行为模型

Simulator Agent 默认提供 deterministic command-oriented prompt surface，并尽量对齐 Claude Code 的交互节奏：

- `/help`
- `/read /absolute/path`
- `/write /absolute/path content...`
- `/bash command [args...]`
- `/rename Human Readable Title`
- `/plan step one | step two`
- `/scenario full-cycle /absolute/path [command]`
- `/simulate <fault>`

普通文本 prompt 也会走完整 ACP turn 生命周期，并返回可解释的 deterministic 输出。
但普通聊天 prompt 默认只走描述路径，不自动触发 plan、read、write 或 run。

显式 `/plan ...` 的语义是“发布计划”，不是“执行计划”。
因此 simulator 不应在同一个 turn 中把 `/plan` 的 step 全部标成 completed，除非后续真实执行流继续推进它。
同时正文必须复述同一组 step 及其状态，避免 plan 面板与正文输出相互脱节。

权限模式只保留三档：

- `read-only`
  - 允许规划、读取
  - 阻止写文件和终端执行
- `accept-edits`
  - 允许工具调用
  - 写文件和终端执行前必须请求 permission
- `yolo`
  - 只要 client 宣告支持，即直接执行工具

mode、model、config 这类协议中已有专门方法的控制项，必须通过 ACP 方法调用：

- `session/set_mode`
- `session/set_model`
- `session/set_config_option`

Simulator Agent 不为这些协议控制项提供 prompt shortcut，避免把 prompt 面和协议控制面混在一起。

其中：

- `session/set_model` 在 simulator 内表示切换行为 profile
- 当前 profile 为 `Claude` / `GPT` / `Gemini`
- 这不是对真实底层模型供应商的透明代理

prompt 面只保留场景和工具意图，例如：

- 读文件
- 写文件
- 跑命令
- session rename/title
- 复杂多步 scenario
- 故障注入

对于 session title：

- ACP 当前有 `session_info_update`
- ACP 当前没有 `session/set_title`
- 因此 simulator 支持“自动生成 title”和“prompt 显式 rename session”
- 但这属于 simulator 的产品行为，不是 ACP 协议控制面

复杂场景通过 `/scenario full-cycle ...` 或少量明确自然语言触发，执行顺序是：

1. 发出 `plan`
2. 调用 `fs/read_text_file`
3. 调用 `terminal/*`
4. 调用 `fs/write_text_file`
5. 发出总结类 `agent_message_chunk`

对于执行型 plan，simulator 应在每次 step 切换时补发一条对应的 thought/output，
让 client 能把 plan step 和正文中的执行证据一一对应起来。

默认编辑策略应尽量模拟真实 coding agent：

- 优先保留原文件内容
- 生成最小追加式 diff
- 避免用 canned content 覆盖整文件

permission 语义：

- agent 需要显式提供 permission option
- simulator 至少提供 `allow_once` / `reject_once` / `allow_always` / `reject_always`
- simulator 将 `allow_always` / `reject_always` 解释为当前 session 级记忆规则

这类场景用于给 ACP client 验证“像真实 coding agent 一样”的多步工具链，而不是只测单个 method。

## 7. Prompt 引导与故障注入

Simulator Agent 内置 prompt-level 故障注入，作用于“下一次 prompt”：

- `drop-next-tool-update`
- `duplicate-next-tool-update`
- `out-of-order-next-tool-update`
- `drop-next-plan-update`
- `duplicate-next-plan-update`
- `timeout-next-prompt`
- `hang-next-prompt`
- `error-next-prompt`
- `crash-next-prompt`

用途：

- 验证 client 能否容忍 `tool_call_update` 丢失
- 验证 client 能否处理 update 乱序
- 验证 prompt 超时和用户取消
- 验证 agent 卡死后 client 的取消逻辑
- 验证 agent 异常退出时的宿主恢复路径

典型 prompt：

- `/simulate drop-next-tool-update`
- `/simulate duplicate-next-tool-update`
- `/simulate out-of-order-next-tool-update`
- `/simulate drop-next-plan-update`
- `/simulate duplicate-next-plan-update`
- `/simulate timeout-next-prompt`
- `/simulate hang-next-prompt`
- `/simulate error-next-prompt`
- `/simulate crash-next-prompt`
- `simulate timeout next prompt`
- `do a full cycle on /tmp/project/index.ts and run \`git diff --stat\``

## 8. 对 testing 的意义

Simulator Agent 用于：

- runtime integration tests
- fault injection 的后续扩展
- host contract tests
- 与真实 Agent 分离的 ACP 协议回归

它与 harness 内置 agent registry 和真实 Agent 认证矩阵是互补关系：

- Simulator Agent：协议基线 / deterministic 回归
- Real Agents：生态兼容性认证

另外，repo 内 harness 现在应支持一个本地基线 agent：

- agent id: `simulator-agent-acp-local`
- launch target: `dist/simulator-agent/cli.js`
- launch flags: `--auth-mode none --storage-dir .simulator-agent-acp-harness`

这个基线的目的不是证明 harness 已经完成，而是反过来校准 harness：

- 先用 deterministic simulator 验证 case 的 prompt、断言和 protocol 假设是否合理
- 对不适合 simulator 的 case 显式标记 `not-applicable`
- 额外保留 `simulator.*` baseline case，专门覆盖 slash command surface、`session_info_update`、`/scenario full-cycle` 和 fault injection

## 9. 结论

`simulator-agent-acp` 应作为 `acp-runtime` 的一等公民存在。

它不是辅助测试脚本，而是：

- ACP Reference Implementation
- ACP Test Agent
- ACP Host Integration Fixture

[English](../../rfcs/0005-simulator-agent.md)
