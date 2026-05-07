[English](../../guides/remote-acp-runtime-implementation-plan.md)

# Remote ACP Runtime 实施计划

本文档把 [RFC-0006](../rfcs/0006-remote-acp-runtime-relay.md) 落成可执行的实现顺序。
第一优先级是原生 ACP client 路径。原生 ACP 既包含能直接连接 WebSocket ACP 的
client，也包含只能启动本地 stdio ACP command 的 client：

```text
Native ACP Client
  -> Relay /acp
  OR
Native ACP Client
  -> generic stdio ACP bridge
  -> Relay /acp
  -> bootstrap auth and host selection
  -> Host Daemon
  -> AcpRuntime
  -> local ACP agent
```

自家客户端和 Remote IDE channels 是长期产品方向，但在原生 ACP remote 路径端到端跑通前先暂缓。

## Phase 0：设计与边界

- 产品优先级：用户体验第一，同时安全不能降级。不能用反复浏览器授权、手填 ID、
  旧标签页或让用户重试来弥补 runtime state 缺失。安全的流程应该从签名、可审计的
  metadata 自动恢复；不安全或有歧义的流程应该明确失败，并给出可执行的恢复路径。
- 以 RFC-0006 作为 account、host、client device、grant、ticket、relay、daemon 边界的 source of truth。
- 保持 local-first runtime 行为不变；现有 `AcpRuntime` 使用不能依赖 relay。
- 原生 ACP client 兼容只聚焦标准 ACP `initialize/authenticate/session/*` 方法。
- 已授权的 remote 路径必须被视为透明 ACP transport。relay 和 daemon 可以增加 auth、
  grant 校验、routing、ticket renewal、workspace policy 和 observability，但不能消费
  ACP data-plane 语义后再从 runtime read model 重建。
- 第一阶段允许实现通用 stdio ACP bridge，服务不能直接打开 WebSocket ACP endpoint
  的 client。bridge 必须保持 editor-agnostic，只做 transport adaptation。
- 第一阶段不实现 `examples/remote`。

### 当前需要消除的 UX 债务

- 为历史 session 持久化 remote binding metadata。`session/load` 和
  `session/resume` 应该从记录的 daemon、agent、workspace、grant 和 ticket context
  恢复，而不是重新打开 `/authorize`，也不是根据在线 daemon 猜测。
- `session/update` 历史回放必须透明。历史 updates 应该来自被选择的 ACP agent，并通过
  daemon proxy 直接转发，而不是由 daemon 从 runtime history 重新构造。
- `/authorize` 应该只用于新 session 的明确选择和显式重新授权。不能仅因为 client
  进程重启就出现授权页。
- 用有界等待和明确 ACP error 替代静默 loading。bridge、relay、daemon 都不能让 ACP
  client 无限等待一个没有被展示出来的浏览器操作。
- 旧授权标签页要显示为过期视图，并提供清晰的 restart/reopen 操作；不能让 stale page
  看起来像主路径。
- 正常使用中的 ticket renewal 必须无感。只有 grant 被撤销、metadata 缺失、daemon
  离线、账号/session 过期时，才应该打断用户。
- 在 ACP config/options 中一致展示当前 machine、agent、workspace 和 recovery state，
  让 client UI 能展示真实绑定状态。
- 避免靠猜测默认值。恢复历史 session 时使用持久化签名 metadata；新建 session 时使用
  Codex 这类明确默认值，并允许用户修改。

## Phase 1：Native ACP Remote MVP

### 1.1 WebSocket ACP Stream

- 实现 `ACP JSON-RPC over WebSocket` stream adapter。
- 支持 native ACP client side 和 daemon side 的 full-duplex JSON-RPC。
- 保持 ACP message schema 不变；remote routing metadata 放在 ACP payload 之外。
- 用 SDK `ClientSideConnection` 和 `AgentSideConnection` 加测试。
- 实现通用 stdio bridge：本地通过 stdio 读写 ACP JSON-RPC，同时把同样的消息转发到
  relay `/acp` WebSocket。bridge 不能包含 editor-specific 行为，也不能实现 runtime
  语义。

### 1.2 Relay Bootstrap Facade

- 为未绑定 host 的原生 ACP 连接增加 relay `/acp` 支持。
- Bootstrap `initialize` 返回 browser 或 device-code auth method。
- Bootstrap `authenticate` 创建 pending authorization。
- 浏览器授权完成后，把 ACP connection 绑定到目标 host。
- 连接绑定前拒绝 `session/new` 等 runtime 方法。
- 无论 ACP client 直连 WebSocket 还是通过 stdio bridge，relay bootstrap 行为必须一致。

### 1.3 Daemon Connection

- 增加 daemon 主动连接 `/daemon?hostId=...`。
- 注册 host presence。
- 接收 relay 转发的已绑定 ACP connection frame。
- 使用 `AcpRemoteRuntimeAgent` 创建 `AgentSideConnection`。
- 通过 daemon facade 驱动本地 `AcpRuntime`。

### 1.4 Browser Authorization Loop

- 提供最小浏览器授权页。
- 用户登录并选择 account、host、workspace。
- 为等待中的 ACP connection 签发短期 connection ticket。
- Relay 绑定 `connectionId -> hostId -> daemon`。
- 保持最小实现；精细化自家客户端 UI 后续再做。

### 1.5 ACP Session Methods

- 跑通 `initialize`。
- 跑通 `authenticate`。
- 跑通 `session/new`。
- 跑通 `session/prompt`。
- 跑通 `session/cancel`。
- 流式转发 `session/update` notifications。
- 保持双向 client authority callback。

### 1.6 Authority Forwarding

- 将 runtime permission request 转发给 ACP client。
- 当 ACP client 宣告 `fs` capability 时转发文件读写。
- 当 ACP client 宣告 terminal capability 时转发 terminal calls。
- Terminal forwarding 在 MVP 中可选，不阻塞基础 prompt turn。

### 1.7 MVP Validation

- 使用 SDK-backed ACP client smoke path 打 relay endpoint。
- 为只能启动本地 ACP command 的 client 增加 stdio-bridge smoke path。
- 使用 simulator agent 作为 daemon 侧本地 runtime agent。
- 验证 prompt text、event streaming、cancel 和 permission flow。
- Focused tests 保持 deterministic，不能依赖 Cloudflare account state。

## Phase 2：账号、Host 与 Ticket 基础

### 2.1 Account Control Plane

- 增加 account model。
- 增加 client device model。
- 增加 host daemon model。
- 增加 account-host binding。
- 增加 grant storage。

### 2.2 Device and Host Keys

- 生成 client device keypair。
- 生成 daemon host keypair。
- 支持 signed nonce 检查。
- 注册和撤销 client device。
- 注册和撤销 host daemon。

### 2.3 Connection Tickets

- 实现 signed ticket payload。
- Ticket 绑定 `connectionId`。
- 包含 `hostId`、`workspaceId`、`scopes`、`policyVersion`。
- Daemon 验证 ticket 签名、过期时间和 scopes。
- Ticket 保持短期和最小 scope。

### 2.4 Ticket Renewal

- Ticket 过期前自动续租。
- 续租需要 device-key signed renewal proof。
- 续租时重新检查 account session、grant、revocation、policy version。
- 将续租后的 ticket 状态传播给 daemon。
- 短暂网络问题使用 grace period 温和失败。

### 2.5 Revocation

- 撤销 client device。
- 撤销 host grant。
- 撤销 workspace grant。
- 观察到 revocation 后停止新的敏感操作。
- 即使 relay 状态过期，daemon 也要执行本地 revocation policy。

## Phase 3：Relay 可靠性

### 3.1 Durable Object Routing Shard

- 优先使用 account-level routing shard。
- 按 `hostId` 追踪 daemon WebSocket。
- 追踪 client WebSocket。
- 追踪 pending authorization connections。
- 追踪 connection binding state。

### 3.2 Presence

- 发布 daemon online/offline 状态。
- 增加 heartbeat。
- 清理 stale sockets。
- 给授权 UI 暴露轻量 host presence。

### 3.3 Reconnect

- 支持同一 `connectionId` 的 client 短断重连。
- Daemon 仍在线时，在 Durable Object 内存中按
  `ACP_RELAY_CLIENT_RECONNECT_GRACE_MS` 保留已绑定 client route。
  生产默认 5 分钟；30 秒对编辑器重启、电脑睡眠唤醒、网络切换来说太短。
- 通过 shard alarm 清理过期断线 route，并通知 daemon。
- 支持同一 `hostId` 的 daemon 短断重连。
- 按 `ACP_RELAY_DAEMON_RECONNECT_GRACE_MS` 保持已绑定 client 不关闭，
  daemon 重连后重放 route `Hello` frame。生产默认 5 分钟。
- 通过 shard alarm 清理 daemon 重连宽限过期状态，并关闭受影响 client。
- 尽可能恢复 pending authorization。

### 3.4 Backpressure

- 增加 frame seq/ack。
- 增加 send queues。
- 限制 buffered frames。
- 拒绝或延迟大 payload。
- 未来 artifact/blob traffic 不走 ACP control path。

### 3.5 Observability

- 记录 connection lifecycle metadata。
- 记录 auth、ticket、routing、close reason。
- 不记录 prompt、file、terminal、image、browser payload。
- 增加 active hosts、clients、bindings、reconnects 等 relay metrics。

## Phase 4：Daemon 产品化

### 4.1 Daemon CLI

- 增加 `acp-runtime daemon start`。
- 增加 `acp-runtime daemon login`。
- 增加 `acp-runtime daemon status`。
- 增加 `acp-runtime daemon logout`。
- Daemon commands 与现有 runtime examples 保持分离。

### 4.2 Host Binding

- 将 daemon 绑定到 account。
- 注册 host public key。
- 设置 host alias。
- 配置 workspace allowlist。
- 支持 host unbind 和 key rotation。

### 4.3 Runtime Session Registry

- 将 remote `session/list` 映射到本地 runtime/session registry。
- 支持 remote `session/load`。
- 支持 remote `session/resume`。
- 保持本地 snapshot 和 registry 语义。
- 必要时只同步轻量 metadata 到 control plane。

### 4.4 Local Policy

- 执行 workspace path allowlist。
- 执行 agent allowlist。
- 增加 file、terminal、browser、port policy gates。
- 高风险操作增加 step-up。
- Daemon 保持最终执行 enforcement point。

### 4.5 Failure Cleanup

- remote session create 失败时释放 agent process。
- daemon 断连时关闭 remote connections。
- 连接丢失时取消或安全收尾 active turns。
- 清理只针对当前运行创建的资源。

## Phase 5：Native ACP Compatibility Completion

### 5.1 ACP Auth Compatibility

- 增加 browser login auth method。
- 增加 device-code auth method。
- 在标准字段或 `_meta` 中放 login URL、device code、connection id。
- 对不能展示 browser/device-code 指引的 client 返回清晰错误。

### 5.2 ACP Method Coverage

- 支持 `session/list`。
- 支持 `session/load`。
- 支持 `session/resume`。
- 支持 `session/close`。
- 支持 `session/set_mode`。
- 支持 `session/set_config_option`。

### 5.3 Capability Mapping

- 映射 ACP client filesystem capability。
- 映射 ACP client terminal capability。
- 映射 prompt image/audio/resource capability。
- 映射 authentication capability。
- 不把 agent-specific quirks 泄漏到 relay；profile 仍放 runtime。

### 5.4 Compatibility Tests

- 增加 SDK in-memory ACP client tests。
- 增加 WebSocket ACP client tests。
- 增加 simulator-backed daemon tests。
- 增加 permission/file/terminal smoke cases。

### 5.5 Harness Integration

- 增加 remote admission gate。
- 增加 remote simulator matrix。
- 增加 relay disconnect scenarios。
- 增加 daemon reconnect scenarios。
- generated output 保持在临时输出目录。

## Phase 6：自家客户端基础

### 6.1 Account UI

- 实现登录。
- 注册 client device。
- 展示 device list。
- 支持 device revoke。

### 6.2 Host and Workspace UI

- 展示 host list。
- 展示 host online/offline。
- 选择 workspace。
- 设置 default host/workspace。
- 展示 recent sessions。

### 6.3 ACP Channel

- 直接申请 connection ticket。
- 打开到 relay 的 ACP channel。
- 自动续租 ticket。
- 流式展示 runtime events。
- 处理 reconnect 和 re-auth prompts。

### 6.4 Permission UI

- 展示 permission prompts。
- 支持 allow once 和 allow for session。
- 为 terminal、file write、port forward、browser control 增加 step-up。
- 展示 daemon/local policy denial。

### 6.5 Session UI

- 创建 session。
- 发送 prompt。
- 流式展示 updates。
- 取消 turn。
- list/load/resume sessions。

## Phase 7：Remote IDE Channels

### 7.1 Filesystem Channel

- 增加 file tree。
- 增加 file read/write。
- 增加 diff view。
- 增加 file watch。
- 增加 upload/download。

### 7.2 Terminal Channel

- 增加 PTY start。
- 流式 terminal output。
- 发送 terminal input。
- Resize terminal。
- Kill/release terminals。
- 默认只记录 audit metadata，不记录 terminal payload。

### 7.3 Artifact Channel

- 支持 image、log、blob artifacts。
- 增加 chunking。
- 增加 encrypted blob option。
- 优先使用 daemon/client storage，而不是 relay storage。

### 7.4 Port Channel

- 增加 local preview server forwarding。
- 支持 HTTP 和 WebSocket proxy。
- 增加 per-port grants。
- 增加 private/public preview policy。

### 7.5 Browser Channel

- 增加 local browser 或 CDP control。
- 增加 screenshot stream。
- 增加 click/type/navigation commands。
- Cloud browser 作为可选未来 backend。

## Phase 8：安全增强

### 8.1 End-to-end Encryption

- 加密 client-daemon payload。
- 尽可能让 relay 只看到 routing metadata。
- 增加 key rotation。
- 增加 recovery 和 rekey flows。

### 8.2 Passkey and OIDC

- 增加 passkey login。
- 增加 GitHub/OIDC login。
- 预留 organization SSO。
- 保持 account identity 与 daemon execution grants 分离。

### 8.3 Risk Controls

- 检测异常 device 或 location signals。
- 高风险操作触发 step-up。
- 检测 token replay。
- 限制重复 auth failure。

### 8.4 Audit

- 审计 grant changes。
- 审计 host binding / unbinding。
- 审计高风险操作决策。
- Audit logs 默认只记录 metadata。

### 8.5 Secrets

- 防止 secrets 进入 relay logs。
- Redact sensitive metadata。
- Daemon-local secrets 保持本地。
- 避免在 relay/control plane 持久化 agent credentials。

## Phase 9：部署与运维

### 9.1 Cloudflare

- 部署 Worker。
- 部署 Durable Objects。
- 增加 D1/KV metadata stores。
- 增加 staging/prod environments。
- 配置环境级 secrets 和 keys。

### 9.2 VPS and Self-host

- 实现同一套 relay contracts。
- 增加 Postgres 或 SQLite adapter。
- 增加 WebSocket broker。
- 增加 Docker deployment。
- 保持 self-hosted behavior 与 Cloudflare behavior 兼容。

### 9.3 CI/CD

- 增加 relay-worker typecheck。
- 增加 relay-worker tests。
- 增加 remote integration tests。
- 增加 deployment workflow。
- Root checks 保持 deterministic 且不依赖账号。

### 9.4 Observability

- 增加 metrics。
- 增加 traces。
- 增加 error dashboards。
- 增加不含 payload content 的 session diagnostics。
- 增加 daemon 和 relay correlation ids。

### 9.5 Quotas

- 限制每个 account 的 connections。
- 限制每个 account 的 hosts。
- 限制 bandwidth。
- 增加 rate limits。
- 增加 abuse controls。

## Phase 10：发布与拆包

### 10.1 Stabilize Internal APIs

- 稳定 remote protocol types。
- 稳定 daemon facade。
- 稳定 ticket issuer/verifier。
- 稳定 relay contracts。

### 10.2 Split Packages

- 保持 `@saaskit-dev/acp-runtime` 作为 core local runtime package。
- 拆出 `@saaskit-dev/acp-remote-protocol`。
- daemon 和 bridge entrypoint 保持在统一的 `acp-runtime` CLI 下。
- 保持 `@saaskit-dev/acp-relay-worker` 作为 Cloudflare worker package。
- 自家 client API 稳定后增加 `@saaskit-dev/acp-remote-client`。

### 10.3 Public Docs

- 增加 remote setup guide。
- 增加 daemon setup guide。
- 增加 native ACP client compatibility guide。
- 增加 security model guide。
- 增加 Cloudflare deploy guide。

### 10.4 Versioning

- Version remote protocol。
- 定义 migration policy。
- 维护 compatibility matrix。
- 记录支持的 ACP protocol versions。

## 当前实现检查点

- 当前实现范围已锁定为原生 ACP client 路径，包括 direct WebSocket ACP 和通用
  stdio bridge 兼容。本切片不实现自家 IDE client、`examples/remote` 或 Remote IDE
  channel UI。
- `src/runtime/remote/protocol` 已定义 versioned remote frames 和 WebSocket
  JSON-RPC stream adapter。
- `packages/relay-worker` 已暴露 `/acp`、`/client`、`/daemon`、`/authorize`
  和 `/renew`。
- `packages/relay-worker` 已包含 Cloudflare 部署入口、Wrangler scripts，以及
  `packages/relay-worker/migrations` 下的 D1 migration。
- relay 使用 account-level routing shard，不是用户可见的 room 概念。
- 未绑定的 native ACP client 会从 `/acp` 收到 bootstrap ACP auth method。
- stdio-only ACP client 通过通用 bridge 支持：bridge 暴露本地 stdio ACP command，
  并转发到 `/acp`。这不是产品专用编辑器集成，必须保持 transport adapter 定位。
- `packages/relay-worker` 已有轻量 control-plane store interface 和内存实现，
  覆盖 account、client device、host、grant。
- `packages/relay-worker` 也已增加可写的 D1-backed control-plane store
  adapter，并在 `packages/relay-worker/schema.sql` 提供 D1 schema。
- Worker 已暴露正式 control-plane mutation endpoints：
  `/control-plane/accounts`、`/control-plane/client-devices`、
  `/control-plane/hosts` 和 `/control-plane/grants`，用于写入关系 metadata。
  这些 endpoint 必须配置 `ACP_RELAY_CONTROL_PLANE_SECRET`，只写关系数据，并在
  mutation 后触发 route authorization reconcile。
- native ACP `/authorize` 现在由产品账号 session 保护。Worker 要求配置
  `ACP_RELAY_ACCOUNT_SESSION_SECRET`，并从 `Authorization: Bearer`、
  `x-acp-account-session` 或 `acp_relay_session` cookie 读取签名账号 session，
  验证通过后才会把授权 UI 路由到 account shard。
- 配置 `ACP_RELAY_LOGIN_URL` 后，未登录的 native `/authorize` 会带着
  `returnTo` 和 `accountId` 重定向到产品登录页；未配置时 Worker 渲染最小
  sign-in-required 页面。
- `/authorize` 只有在 active grant 允许该 account/client device 访问目标 host
  时才会绑定 `connectionId -> hostId`，并由 relay 为 daemon 签发短期
  connection ticket。
- daemon metadata 会优先把 ACP registry id 作为 agent 选择项上报。Relay ticket 可以
  携带 `agent.id`，daemon 再把这个 id 交给 `AcpRuntime`，因此 registry 解析、
  launch args、env 和 cache 行为都留在 runtime 内部。
- 绑定 native ACP route 时，relay 会向 daemon 发送 remote `Hello` 和内部
  daemon-side `initialize` request。内部 response 会被 relay 吞掉，native ACP
  client 看不到 relay bootstrap 的实现细节。
- relay 转发已绑定的 native ACP traffic 前，会重新检查 account/client
  device/host grant 和 method scope；如果 connection grant 被撤销，relay 会在转发
  新 ACP payload 前停止 daemon route。
- native ACP ticket renewal 是显式流程：已绑定 native ACP client 再次调用
  relay auth method，relay 重新检查 grant，向 daemon 发送 remote `Renew`，
  并返回新的 ticket metadata。普通 ACP traffic 不再顺带 opportunistic renewal。
- 自家客户端可以调用 `/renew` 续租：用已注册 client-device Ed25519 key 签名
  account id、client device id、connection id、host id、当前 ticket JTI、
  timestamp 和 nonce。relay 会重新检查 device 状态与 grant，签发新 ticket，并把
  `Renew` 传给 daemon。
- `/daemon` 必须使用已注册 host public key。daemon shared-secret registration
  已从 runtime path 删除。
- 已注册 host 现在可以在 D1 中保存 `publicKey` 和 `previousPublicKey`。存在这些字段时，
  `/daemon` 会用 host current 或 previous public key 验证 registration proof，
  而不是使用共享 bootstrap secret，从而支持分阶段 host key rotation。
- `src/runtime/remote/daemon` 现在也提供 daemon 侧 host identity primitives：
  本地持久化 identity 文件、带 `previousPublicKey` 的 key rotation，以及基于
  Ed25519 签名生成 relay registration headers。
- `src/runtime/remote/daemon` 也可以生成 relay control plane 需要的
  account/host/public-key registration record。
- runtime 现在也暴露了 transport-agnostic 的 daemon relay connector：负责加载
  持久化 host identity、构造 `/daemon` registration headers，并把 URL 与 headers
  交给注入的 WebSocket factory。
- daemon connector 也提供 CLI/env config parser，支持 `--account-id`、
  `--host-id`、`--relay-url` 和 `--identity-path`，产品 CLI 可以把真实
  WebSocket 实现接入同一 connector path。这与 client-side stdio bridge 是两件事：
  后者只负责把 stdio-only ACP client 适配到 relay `/acp`。
- host-key registration 是唯一 daemon registration path。
- `src/runtime/remote/daemon` 会从 relay ACP frames 创建
  `AgentSideConnection`；daemon connection API 必须配置 ticket verification key，
  并会先验证 connection ticket。
- daemon 侧 ACP method dispatch 已按 ticket scope 限制 session create、session
  list、session resume/load/fork/close、mode/config change、prompt turn 和
  turn cancel。
- daemon runtime facade 支持 `workspaceRoots`；配置后，remote `session/new`、
  `session/list`、`session/load` 和 `session/resume` 必须使用落在允许本地
  workspace root 内的 `cwd`，然后才会调用 `AcpRuntime`。
- workspace roots 现在也可以来自签名 connection ticket，因此 control-plane
  grant 可以限制单条连接的 workspace，不再只能依赖进程级 options。
- relay routing 现在会在短暂 client 重连时保留已绑定 native ACP client route，
  也会在短暂 daemon 重连时保持 client 不关闭。Shard 使用
  `ACP_RELAY_CLIENT_RECONNECT_GRACE_MS` 和
  `ACP_RELAY_DAEMON_RECONNECT_GRACE_MS`；daemon 重连后会为已有 binding 重放
  route `Hello` frame。
- relay 和 daemon transport 现在会为 ACP 和后续 remote IDE channel 交换 remote
  `Ack` frame。relay 会维护有界 pending data-frame queue；daemon 重连后会重放未确认
  的 daemon-bound frame；client 重连宽限期内会缓存 daemon-to-client frame；并对
  `fs`、`terminal`、`browser`、`port`、`artifact` 和 `logs` frame 做 channel scope
  检查。Relay 侧每条 route 的内存帧上限由
  `ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION` 控制。
- control-plane mutation 现在会触发 shard 内的 authorization
  reconcile，因此 account/device/host/grant 被撤销后，现有已绑定的 native ACP
  route 会被主动关闭，而不是等到下一条 ACP request 才感知。
- relay cleanup 仍会在 reconnect grace 过期或 daemon 发送 remote `Close` frame 时，
  关闭并移除已绑定的 native ACP client route。
- remote frame heartbeat 已在协议边界实现：daemon connection 会用 `Pong` 响应
  `Ping`，relay broker 可以 ping daemon socket、记录匹配的 pong，并关闭
  heartbeat-stale daemon route。
- Cloudflare Durable Object shard 可以通过 alarm 调度这些 heartbeat checks，
  使用 `ACP_RELAY_HEARTBEAT_INTERVAL_MS` 和
  `ACP_RELAY_HEARTBEAT_TIMEOUT_MS` 配置。
- 当前 Worker smoke 已覆盖 native ACP client JSON-RPC 通过 Worker routing、
  Durable Object routing、daemon connection 和 simulator-backed 本地 runtime。还应
  增加单独的 stdio-bridge smoke，覆盖本地 stdio command 兼容路径。

## 最近下一步

当前 1-4 原生 ACP 实现切片已经落到代码：

1. WebSocket ACP stream adapter。
2. Relay `/acp` 承接原生 ACP JSON-RPC。
3. 通用 stdio ACP bridge 将 stdio-only client 适配到 relay `/acp`。
4. Daemon `/daemon` 接收 relay frame 并创建 `AgentSideConnection`。
5. Worker/Durable Object smoke 用 simulator agent 跑通原生 ACP `initialize`、
   `authenticate`、`session/new` 和 `session/prompt`。

下一步仍然只围绕原生 ACP 路径做到部署可用：真实 login provider 接入
`/authorize`、daemon CLI packaging、Cloudflare staging 部署、WebSocket ACP smoke
以及通用 stdio-bridge compatibility smoke。自家 IDE client 工作继续明确暂停。
