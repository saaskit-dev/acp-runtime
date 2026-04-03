# RFC-0008：ACP Simulator Agent

- 状态：Draft
- 日期：2026-04-03

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
acp-simulator-agent
```

并通过 stdio 与 ACP Client 建立连接。

### 4.3 deterministic

Simulator Agent 的 prompt 执行逻辑必须可预测，便于：

- runtime 回归测试
- transcript 证据采集
- 故障定位

## 5. 当前实现边界

当前实现提供：

- session 持久化
- session list / load / resume / fork / close
- mode / model / config 状态
- prompt turn 与 `session/update`
- tool call / tool call update
- permission request
- filesystem read/write through client authority
- terminal create/output/wait/kill/release through client authority
- usage update / plan / available commands / session info update
- NES start / suggest / close
- document didOpen / didChange / didClose / didSave / didFocus
- auth / logout

## 6. 行为模型

Simulator Agent 默认提供 deterministic command-oriented prompt surface：

- `/help`
- `/read /absolute/path`
- `/write /absolute/path content...`
- `/run command [args...]`
- `/title Human Readable Title`
- `/plan step one | step two`

普通文本 prompt 也会走完整 ACP turn 生命周期，并返回可解释的 deterministic 输出。

## 7. 对 testing 的意义

Simulator Agent 用于：

- runtime integration tests
- fault injection 的后续扩展
- host contract tests
- 与真实 Agent 分离的 ACP 协议回归

它与 `research/harness/agents/*.json` 中的真实 Agent 认证矩阵是互补关系：

- Simulator Agent：协议基线 / deterministic 回归
- Real Agents：生态兼容性认证

## 8. 结论

`acp-simulator-agent` 应作为 `acp-runtime` 的一等公民存在。

它不是辅助测试脚本，而是：

- ACP Reference Implementation
- ACP Test Agent
- ACP Host Integration Fixture
