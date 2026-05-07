[English](../../rfcs/0006-remote-acp-runtime-relay.md)

# RFC-0006：Remote ACP Runtime Relay

## 摘要

本 RFC 定义 `acp-runtime` 从 local-first runtime 演进到远程 runtime 基础设施的目标方向。

设计优先级是：

1. 自家 Web / Desktop / Mobile 客户端优先。
2. 原生 ACP client 是一等兼容 feature 和生态接入口。这里同时包含能直接连接
   WebSocket ACP endpoint 的 client，以及只能启动本地 stdio ACP command、需要
   通用 stdio bridge 的 client。
3. Relay 轻状态，不保存 prompt、文件、终端输出、图片、browser stream 或 ACP transcript。
4. Account control plane 维护账号、设备、host、授权关系和短期连接票据。
5. Host daemon 仍然是本地执行和本地权限兜底的 authority。

核心原则：

> 账号系统负责便利性和授权关系，relay 负责轻状态转发，daemon 负责真实执行和本地安全，自家客户端承载完整体验，ACP 原生客户端通过标准 auth 兼容接入。

## 目标

- 一个账号可以管理多个宿主机 daemon、多个 client、多个 workspace、多个 ACP session。
- 自家客户端提供完整产品体验：host 选择、workspace 选择、session 列表、权限 UI、自动续租和后续 Remote IDE 能力。
- 原生 ACP client 可以通过同一个 relay URL 接入；能直连 WebSocket 的 client
  直接连 `/acp`，只能启动本地 stdio command 的 client 通过通用 stdio bridge
  接入，不要求它理解账号、多 host、多 workspace UI。
- Relay/control plane 只保存轻量关系和授权，不保存敏感内容。
- Cloudflare Workers + Durable Objects 作为优先部署方向，同时保留 VPS / self-host 后端可替换性。
- 网络、协议、安全、授权和 channel 设计必须为后续文件、终端、端口转发、browser、artifact、日志等 Remote IDE 能力预留空间。

## 非目标

- 不要求用户为了 Web/Mobile 场景在本地再跑一个 client-side proxy。
- 不要求原生 ACP client 理解账号、host、workspace、设备管理 UI。
- 不把 stdio bridge 做成某个编辑器专用的兼容层；它是面向所有 stdio-only ACP
  client 的通用 transport adapter。
- 不让 relay 成为 workspace 的最终 authority。
- 默认不在 relay/control plane 保存 prompt、文件、终端输出、图片、browser stream、session transcript。
- 不把 Remote IDE 的所有能力强塞进 ACP 标准协议。

## 当前实现范围

当前实现切片明确只做原生 ACP，并支持两种 client 入口形态：

- `/acp` 承接原生 ACP JSON-RPC over WebSocket。
- 通用 stdio ACP bridge 可供不能直接连接 WebSocket ACP endpoint 的 client 启动；
  bridge 在本地通过 stdio 说 ACP，并把同样的 ACP JSON-RPC 转发到 `/acp`。
- `/authorize` 负责浏览器账号授权和 host 选择。
- `/daemon` 连接 host daemon，并创建 daemon-side ACP connection。
- Relay/account metadata 仅限关系、key、grant、ticket、presence 和 revocation
  state。
- Worker/Durable Object smoke 用 simulator agent 验证原生 ACP `initialize`、
  `authenticate`、`session/new` 和 `session/prompt`。

自家 IDE client、`examples/remote` 和 Remote IDE UI 在原生 ACP 路径达到可部署前
明确暂停。通用 stdio bridge 属于原生 ACP 切片，因为它只是 transport adapter，
不是自家 Remote IDE client。

## 总体架构

```text
Our Client / Native ACP Client
        |
        | HTTPS / WebSocket / ACP over WebSocket
        | 或 local stdio ACP bridge -> WebSocket /acp
        v
Relay URL
        |
        +-- Account Control Plane
        |     login / devices / hosts / grants / tickets
        |
        +-- Relay Data Plane
              online routing / websocket broker / heartbeat / rate limit
        |
        v
Host Daemon
        |
        +-- AcpRuntime
        +-- local ACP agents
        +-- workspace filesystem
        +-- terminal / port / browser / artifact adapters
        +-- local policy enforcement
```

## 组件职责

### 自家客户端

自家客户端是第一优先级产品入口，负责：

- 账号登录
- client device 注册与恢复
- 多 host、多 workspace、多 session UI
- connection ticket 自动续租
- 权限确认与 step-up
- 后续 Remote IDE 能力：
  - 文件
  - 终端
  - 端口转发
  - browser
  - 图片 / artifact
  - 日志

### 原生 ACP Client

原生 ACP client 是兼容入口，只需要 ACP 标准流程：

- 直接连接 relay ACP endpoint，或启动通用本地 stdio bridge，由 bridge 连接 relay
  ACP endpoint
- 调用 `initialize`
- 使用 `authMethods` / `authenticate`
- 授权完成后调用 `session/*`

多 host / workspace 选择不放进 ACP client UI，而是在浏览器授权页完成。

### Native ACP Bootstrap Facade

原生 ACP client 连接的是单一 relay URL，连接初期还不知道目标 host。
因此 relay/control plane 需要提供一个最小的 ACP bootstrap facade，用于未绑定 host 的原生 ACP 连接。

Bootstrap facade 只允许处理：

- `initialize`
- 用于账号登录 / host 选择的 `authMethods`
- 用于 browser login 或 device-code login 的 `authenticate`
- 授权完成后把连接绑定到目标 host

它不能实现正常 runtime 语义，例如 `session/new`、`session/prompt`、文件访问、终端访问或 agent-specific compatibility。
Host 选择完成后，relay 将连接绑定到 daemon，并开始转发 runtime ACP 流量。
Relay 应把原始 client initialize metadata/capabilities 传给 daemon 侧 ACP facade，让 daemon 建立真实 runtime session context。

对于 stdio-only client，本地 bridge 不能加入产品语义。它只负责把本地 stdio
JSON-RPC 转成 relay WebSocket transport，暴露同一个 bootstrap auth method，并把
host/workspace 选择保留在浏览器授权流程中。它是通用 transport adapter，不是某个
编辑器专用的兼容层。

### Account Control Plane

Account control plane 持久化轻量关系：

- account 与身份提供方关联
- client device 公钥
- host daemon 公钥
- account 与 host 绑定关系
- client / host / workspace / channel grant
- 默认 host / workspace
- revocation 状态
- policy version
- 轻量审计 metadata

不保存：

- prompt 内容
- ACP transcript
- 文件内容
- terminal output
- 图片 / artifact
- browser stream
- workspace index
- agent 私有状态

### Relay Data Plane

Relay data plane 负责在线转发：

- WebSocket entrypoint
- presence 和在线路由
- routing shard
- heartbeat 与断连检测
- rate limit 和 abuse control
- ACP frame 与 Remote IDE channel frame 转发

Relay 可以校验 ticket 是否结构有效、是否可路由，但不应该成为最终授权决策点。

### Host Daemon

Host daemon 负责真实执行：

- 主动连接 relay
- 注册 host presence
- 同步 grant / policy version
- 验证 connection ticket 和 client device 身份
- 对外提供 remote ACP facade
- 对内调用本地 `AcpRuntime`
- 执行 workspace allowlist 和本地 policy
- 管理本地 filesystem、terminal、port、browser、artifact adapter

Daemon 必须保持 local-first：relay 不可用时，本地 runtime 仍然能独立工作。

初始 daemon facade 可以接收本地 `workspaceRoots` 配置。配置后，remote
session 方法必须先确认 `cwd` 落在这些 root 之内，才能调用 `AcpRuntime`；
后续产品流程应从 host/account workspace 配置下发这些 root。

## 身份模型

```text
Account
  ├─ ClientDevice[]
  ├─ HostDaemon[]
  └─ Grants[]

ClientDevice
  ├─ clientDeviceId
  ├─ publicKey
  ├─ type: web | desktop | mobile | cli
  └─ trustLevel

HostDaemon
  ├─ hostId
  ├─ publicKey
  ├─ ownerAccountId
  ├─ alias
  └─ onlineStatus

Grant
  ├─ accountId
  ├─ clientDeviceId?
  ├─ hostId
  ├─ workspaceId?
  ├─ scopes
  └─ policyVersion
```

用户登录的是账号，不是单个设备。

Client 和 daemon 都是安全主体：

- 每个 client 有自己的 device keypair。
- 每个 host daemon 有自己的 host keypair。
- Account control plane 维护 account、client、host、grant 关系。
- Daemon 在执行前仍要本地验证 grant 和 policy。

## 授权模型

授权是分层的：

```text
account role
  -> client device trust
  -> host grant
  -> workspace grant
  -> channel scope
  -> runtime permission request
  -> daemon local policy
```

账号登录不应该自动等于拥有所有 daemon 的完整权限。

一个 client 想访问 host，至少需要：

- 有效账号登录态
- 已注册 client device key
- 目标 host grant
- 目标 workspace grant 或默认 workspace grant
- 目标 channel scope
- daemon 本地 policy 允许

基础 scope 示例：

```text
acp:connect
acp:session:list
acp:session:create
acp:session:resume
acp:turn:send
acp:turn:cancel

fs:read
fs:write
fs:watch

terminal:start
terminal:write
terminal:kill

port:forward
browser:control
artifact:read
artifact:write
```

高风险能力，例如 terminal、文件写入、端口转发、browser control，必须支持 step-up，并允许 daemon 本地策略拒绝。

## Connection Ticket

长期账号登录态服务用户便利性，短期 connection ticket 服务 runtime 连接安全。

示例：

```json
{
  "accountId": "acct_123",
  "clientDeviceId": "client_web_abc",
  "hostId": "host_macbook",
  "workspaceId": "ws_project",
  "scopes": ["acp:connect", "acp:session", "acp:turn"],
  "connectionId": "conn_123",
  "policyVersion": 17,
  "exp": 1770000000,
  "jti": "ticket_once"
}
```

规则：

- Account control plane 签发 ticket。
- Relay 根据 ticket 路由。
- Daemon 验证 ticket 签名、hostId、clientDeviceId、scope、policyVersion、过期时间和 connection binding。
- Ticket 短期有效，自动续租。
- Ticket 泄露影响应该有限，因为它是短期、scope 化、绑定 connection/device 的。

## 自动续租

用户不能频繁登录或反复授权。续租应该在 transport 层完成，ACP 层无感。

```text
client 持有 account session + device key
 -> ticket 快过期
 -> client/transport 请求 renew
 -> client 用 device key 签名 nonce + connectionId
 -> control plane 检查 grant 和 revocation
 -> control plane 签发新 ticket
 -> relay / daemon 验证
 -> ACP 连接继续
```

续租不能只信旧 ticket。每次续租都要重新检查：

- account session 是否有效
- client device 是否被撤销
- host / workspace grant 是否仍有效
- policy version 是否匹配
- revocation 状态是否更新

原生 ACP client 通过 relay ACP auth method 显式续租。relay 会重新检查 grant
和 revocation state，向 daemon 发送 `Renew` frame，并返回新的 ticket metadata。
自家客户端通过 `/renew` 续租，使用 device key 对 account id、client device id、
connection id、host id、当前 ticket JTI、timestamp 和 nonce 做签名 proof。

续租失败时：

- 短暂网络抖动可给 30–120 秒 grace period。
- 停止新的高风险操作。
- 尽量让已有 turn 安全收尾或取消。
- 自家客户端提示重新登录或重新授权。

## 自家客户端主流程

```text
1. 用户打开 Web / Desktop / Mobile client
2. client 登录账号
3. client 注册或恢复 clientDeviceId 和 device key
4. client 拉取账号下 host、workspace、recent session
5. 用户选择 host / workspace / session
6. client 申请 connection ticket
7. client 打开 relay `/client` WebSocket 传 remote frame；如果只需要 ACP channel，
   也可以打开 `/acp`
8. relay 路由到目标在线 daemon
9. daemon 验证 ticket 和本地 policy
10. ACP channel 建立
11. Remote IDE channel 按需建立
```

自家客户端可以使用 ACP 以外的增强 API 管理 host、device、grant、workspace、session 和 Remote IDE channel。

自家 client SDK 不进入第一阶段实现范围。早期实现应把这条流程作为最终产品方向保留，但优先跑通原生 ACP client 的端到端路径。

## 原生 ACP Client 兼容流程

原生 ACP client 使用同一个 relay URL，并通过 ACP auth 进入浏览器授权页。能直连
WebSocket 的 client 自己连 `/acp`；stdio-only client 启动通用 stdio bridge，由
bridge 代为连接 `/acp`：

```text
1. Native ACP client 连接 wss://relay.example.com/acp，或启动 stdio bridge
   由 bridge 连接该地址
2. client 调用 initialize
3. relay bootstrap facade 返回 authMethods，例如 browser-login
4. client 调用 authenticate({ methodId: "browser-login" })
5. 用户打开 login URL 或 device code 页面
6. 用户登录账号，选择 host/workspace，批准这次连接
7. control plane 为这条 ACP connection 签发 ticket
8. relay 将连接绑定到目标 daemon
9. relay 将原始 initialize context 和 ticket 转发给 daemon
10. daemon 验证 ticket，并初始化自己的 runtime ACP facade
11. client 继续标准 ACP session 方法
```

这样原生 ACP client 不需要懂多 host UI；host/workspace 选择在浏览器授权页完成。

如果某个原生 ACP client 不能连接 WebSocket endpoint，但可以启动本地 stdio ACP
command，就应使用通用 stdio bridge。如果它不能从标准字段或 `_meta` 展示
browser/device-code 指引，它仍可能无法使用这条兼容流程。
这不影响自家客户端，因为自家客户端会先通过增强账号 API 完成 host 选择，再打开 ACP channel。

## 协议分层

ACP 保持 agent 控制面：

- `initialize`
- `authenticate`
- `session/new`
- `session/list`
- `session/load`
- `session/resume`
- `session/prompt`
- `session/cancel`
- runtime events
- auth / permission forwarding

Remote IDE channel 是独立数据面：

- `fs`
- `terminal`
- `port`
- `browser`
- `artifact`
- `logs`

自家客户端可以使用所有 channel。原生 ACP client 只需要 ACP channel。

这个分层保证 ACP 兼容性，同时给完整 Remote IDE 留扩展空间。

## 基础设施方向

### Cloudflare 优先

优先映射：

- Worker：HTTP/WebSocket entrypoint、auth precheck、rate limit、dispatch。
- Durable Object：优先使用 account-level routing shard；处理 WebSocket broker、host presence、heartbeat、可选 hibernation。
- D1/KV：保存轻量 control-plane metadata，例如 accounts、client devices、hosts、
  grants、workspace policy metadata、policy versions、revocation。初始 D1 schema
  保存标识符、scope list、状态 flag、public key 和 metadata，不保存 ACP 或 IDE
  内容 payload。

Heartbeat 应使用 daemon route 上的 remote `Ping`/`Pong` frame。broker 可以先暴露
deterministic heartbeat hooks，再在生产环境接入 Durable Object alarms 或 timers，
用于 liveness check 和 stale route cleanup。
Cloudflare Worker package 使用 `ACP_RELAY_HEARTBEAT_INTERVAL_MS` 和
`ACP_RELAY_HEARTBEAT_TIMEOUT_MS` 配置这个 alarm-driven loop。

Worker 暴露 control-plane mutation endpoints 写入关系 metadata：
`/control-plane/accounts`、`/control-plane/client-devices`、
`/control-plane/hosts` 和 `/control-plane/grants`。这些 endpoint 使用
`ACP_RELAY_CONTROL_PLANE_SECRET` 保护；面向用户的产品流程应在它们前面接入账号
login/session 校验。

native ACP 授权 UI 使用 `ACP_RELAY_ACCOUNT_SESSION_SECRET` 校验签名账号
session。自家客户端续租走 `/renew`，使用已注册 client-device public key 验证，
不需要每次 ticket refresh 都让用户重新登录。

### 后端可替换

实现时应抽象后端接口，让 Cloudflare、VPS、自托管共享产品逻辑：

- `AccountStore`
- `DeviceStore`
- `HostStore`
- `GrantStore`
- `TicketIssuer`
- `PresenceRouter`
- `RelayBroker`

VPS / self-host 可以使用 Postgres、SQLite、Redis、Nginx/Caddy 或单体 relay service，只要实现同一套 contract。

## 安全要求

- 每个 client device 和 host daemon 都有自己的 keypair。
- Cloudflare relay 可以在 D1 中保存 host `publicKey` 和 `previousPublicKey`，
  并在分阶段 host key rotation 期间用任一 key 验证 `/daemon` registration。
  host key registration 是唯一 daemon registration path。
- 账号登录态不足以直接访问 daemon。
- Connection ticket 必须短期、scope 化、签名、可续租。
- Daemon 必须验证 ticket，并执行本地 policy。
- Workspace roots 可以放入签名 connection ticket，让 daemon 在触碰本地 runtime
  state 前执行单连接 workspace policy。
- Relay/control plane 默认不保存敏感内容。
- 审计只记录 metadata，不记录敏感 payload。
- Remote IDE channel 使用独立 scope，高风险能力需要 step-up。
- ACP 和 Remote IDE channel 后续必须能支持 payload E2EE，让 relay 在更严格部署中看不到内容。

## 分阶段推进

### Phase 0：RFC 与协议骨架

- 定义 identity、grant、ticket、relay contract、channel envelope。
- 不改变本地 runtime 行为。

### Phase 1：Remote ACP MVP

- Host daemon 主动连接 relay。
- Relay 暴露 `/acp` WebSocket。
- 原生 ACP client 使用 relay bootstrap ACP facade，可直接走 WebSocket，也可通过
  通用 stdio bridge。
- Browser auth 为这条 ACP connection 选择 account、host 和 workspace。
- Relay 将原生 ACP connection 绑定到目标 daemon。
- Daemon 验证 ticket，并提供 runtime ACP facade。
- 支持 `initialize`、`authenticate`、`session/new`、`session/prompt`、events 和基本 cancel。
- 本阶段不实现 `examples/remote`。
- 本阶段不实现自家 client SDK helper。通用 stdio bridge 允许进入本阶段，因为它
  只为 stdio-only ACP client 做 transport adaptation。
- 验证方式优先使用 ACP client-compatible smoke path 直接打 relay endpoint。

### Phase 2：可靠性

- Ticket 自动续租。
- Heartbeat。
- Reconnect / resume。
- Backpressure。
- Revocation propagation。
- 多 host presence。

### Phase 3：账号与多端产品化

- Device 管理 UI。
- Host 绑定 / 解绑。
- Grant 管理。
- 默认 host / workspace。
- Web / Desktop / Mobile / CLI 多端行为。

### Phase 4：Remote IDE Channels

- 文件 channel。
- Terminal channel。
- Artifact / image channel。
- Port forwarding。
- Browser control。

### Phase 5：生产化

- Cloudflare 部署。
- VPS / self-host adapter。
- Audit / observability。
- Quota / abuse control。
- Organization / team policy。
- 可选 E2EE。
- HA / region routing。

## 实现约束

- Remote relay 逻辑不要塞进通用 examples，除非该 example 明确是 remote runtime 示例。
- Agent-specific ACP 行为仍然放在 runtime profile，不放在 relay。
- 不要求能直连 WebSocket 的 ACP client 跑本地 proxy。
- 为只能启动本地 stdio ACP command 的 client 提供通用 stdio bridge 兼容。bridge
  必须保持 editor-agnostic，并与自家 Remote IDE client 工作分离。
- 保留 local-first runtime API，host 可以继续不依赖 relay 直接使用 `AcpRuntime`。
- 初始实现聚焦 `src/runtime/remote/protocol`、`src/runtime/remote/daemon` 和 `packages/relay-worker`。
  以及通用 stdio bridge。在原生 ACP client 端到端路径跑通前，暂缓自家 remote
  client API 和 `examples/remote`。
