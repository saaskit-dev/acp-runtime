[English](../../guides/remote-acp-runtime-deployment.md)

# Remote ACP Runtime 部署指南

本文档只覆盖当前原生 ACP client 部署切片。能直连 WebSocket ACP 的 client 直接连
`/acp`；stdio-only ACP client 使用通用 stdio bridge，由 bridge 暴露本地 ACP
command 并转发到 `/acp`：

```text
Native ACP Client -> /acp -> /authorize -> /daemon -> AcpRuntime
Native ACP Client -> stdio bridge -> /acp -> /authorize -> /daemon -> AcpRuntime
```

自家 IDE client 和 Remote IDE channel 当前不进入这条部署路径。stdio bridge 是通用
ACP transport adapter，不是某个编辑器专用集成。

这是运营方/部署文档。普通用户应阅读
[Remote ACP 用户安装](./remote-user-install.md)，不应该自己部署 relay，也不应该手工
provision control-plane 记录。

## Cloudflare Worker

1. 创建或绑定名为 `acp-relay` 的 D1 database。
2. 替换 `packages/relay-worker/wrangler.jsonc` 里的 `database_id`。
3. 应用 D1 schema：

```bash
pnpm --filter @saaskit-dev/acp-relay-worker db:migrations:apply:local
pnpm --filter @saaskit-dev/acp-relay-worker db:migrations:apply:remote
```

4. 设置 Worker secrets：

```bash
cd packages/relay-worker
wrangler secret put ACP_RELAY_CONTROL_PLANE_SECRET
wrangler secret put ACP_RELAY_TICKET_PRIVATE_KEY
wrangler secret put ACP_RELAY_ACCOUNT_SESSION_SECRET
```

`ACP_RELAY_TICKET_PRIVATE_KEY` 是 base64url 编码的 Ed25519 PKCS#8 private
key。Daemon 默认使用 runtime 内置的 relay public key 验证 ticket；私有 relay
部署可以通过 `ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS` 覆盖 daemon 验签 key set。

5. 可选配置 `ACP_RELAY_LOGIN_URL` Worker variable。配置后，未登录的
   `/authorize` 会重定向到这个登录地址，并附带 `returnTo` 和 `accountId` query
   参数；未配置时，`/authorize` 渲染最小 sign-in-required 页面。
6. 部署：

```bash
pnpm --filter @saaskit-dev/acp-relay-worker deploy
```

## Control Plane 自动注册

普通用户不应该手工 provision relay control-plane 记录。默认产品路径由登录驱动：

1. GitHub OAuth 创建或更新 relay account。
2. `acp-runtime daemon run` 或 `install` 带 account session 连接 relay，证明自己持有
   本地 daemon private key，relay 自动创建或更新 daemon host record。
3. relay 为这个 daemon 创建 account-wide default grant，包含标准 ACP scopes。
4. native client 或 stdio bridge 在这个 account 下授权 session 时自动注册 client
   device。

如果用户本地 daemon identity 丢失或重新生成，只要 account session 有效，并且新
daemon key 的签名可验证，relay 就会更新 host record。已 disabled 的 host 仍需要
admin 处理。

control-plane endpoints 仍然保留给 admin、企业策略、测试、手动修复和显式 grant 管理，
所有 endpoint 都由 `ACP_RELAY_CONTROL_PLANE_SECRET` 保护：

- `/control-plane/accounts`
- `/control-plane/client-devices`
- `/control-plane/hosts`
- `/control-plane/grants`

只有默认同账号授权不符合需求时才需要使用这些 endpoint，例如 revoke 某个 daemon、
disable 某个 client，或把 grant 限制到指定 `workspaceRoots`。

## Daemon Registration

Daemon 是最终执行 authority。它必须：

- 加载或创建持久化 daemon identity。
- 注册时发送 daemon public key，让 relay 能为已登录账号创建或更新 host record。
- 主动连接 `/daemon?accountId=<account>&daemonId=<daemon>`。
- 用 daemon private key 签名 daemon registration headers。
- 创建 `AgentSideConnection` 前验证 relay connection ticket。
- 调用本地 `AcpRuntime` 前执行 `workspaceRoots` 检查。

`src/runtime/remote/daemon` 已提供这条路径需要的 identity、header generation、
CLI/env config parser 和 relay connector primitives。

Daemon 会优先把 ACP registry id 作为 agent 选择项上报给 relay。授权 ticket 会保留
用户选中的 registry id，daemon 再把这个 id 交给 `AcpRuntime`，因此 command、args、
env、cache download 和 alias 都由 runtime 的 registry resolver 负责。PATH 中发现的
ACP 二进制仍会作为本地 command override 的兼容项上报。

## Daemon CLI 安装

用户不应该为了 daemon 长期开一个终端。发布包里的 `acp-runtime daemon` 同时支持
前台运行和 macOS user service 安装：

```bash
npm install -g @saaskit-dev/acp-runtime

acp-runtime daemon install \
  --relay-url wss://<relay-host> \
  --workspace-root ~/Projects
```

`install` 使用和 `run` 一样的登录解析逻辑：优先使用 `--account-session` 或
`ACP_REMOTE_DAEMON_ACCOUNT_SESSION`，然后读取 `~/.acp/relay-session.json`，没有缓存时
打开浏览器 OAuth。安装后的服务复用这个缓存 session，所以正常用户不需要输入 relay
ticket key 或 account token。如果要忽略旧缓存并重新登录，使用
`acp-runtime daemon install --force-login`。

在 macOS 上，`install` 会写入 user LaunchAgent：
`~/Library/LaunchAgents/dev.saaskit.acp-runtime.daemon.plist`，用 `launchctl` 启动，
日志写到 `~/.acp-runtime/logs/daemon.out.log` 和
`~/.acp-runtime/logs/daemon.err.log`。LaunchAgent 配置了 `RunAtLoad` 和
无条件 `KeepAlive`，因此正常退出和异常退出都会由 launchd 拉起；daemon 进程自身也会在
relay 短暂断开后用指数退避自动重连。`acp-runtime daemon stop` 会 unload 这个
LaunchAgent，所以会保持停止，直到再次执行 `start` 或 `install`。

常用命令：

```bash
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon start
acp-runtime daemon uninstall
acp-runtime daemon run --relay-url wss://<relay-host> --workspace-root ~/Projects
```

`run` 仍然是前台调试路径，本地 Makefile target 也继续使用它。service install 当前
只支持 macOS launchd；之后加 Linux systemd 时应复用同一套 CLI contract。

## Relay Observability

relay Worker 已开启 Cloudflare observability，并提供 `POST /api/logs`。这个
endpoint 需要 account session 认证，会把 runtime telemetry 作为结构化 JSON 写入
Cloudflare logs，字段包含 `eventName: "acp.relay.log"`、relay account id、source、
upload id、context 和原始 record。

runtime demo、stdio bridge 和 daemon 进程只要同时拿到 relay URL 和 account session
token，就会自动开启上传。本地日志仍然保留在原有位置：

- runtime demo：`~/.acp-runtime/logs/runtime.log` 和 `.jsonl`
- runtime demo 分类 JSONL：`runtime.log.text.jsonl`、`runtime.log.events.jsonl`、
  `runtime.log.spans.jsonl` 和 `runtime.log.errors.jsonl`
- session 镜像：`~/.acp-runtime/logs/sessions/<sessionId>/`
- stdio bridge：`~/.acp-runtime/bridge.log`
- stdio bridge 分类 JSONL：`~/.acp-runtime/bridge.log.text.jsonl` 和
  `~/.acp-runtime/bridge.log.errors.jsonl`
- stdio bridge session 镜像：
  `~/.acp-runtime/logs/sessions/<sessionId>/bridge.log.text.jsonl` 和
  `bridge.log.errors.jsonl`
- daemon service：`~/.acp-runtime/logs/daemon.out.log` 和 `daemon.err.log`
- daemon 分类 JSONL：`~/.acp-runtime/logs/daemon.log.text.jsonl` 和
  `~/.acp-runtime/logs/daemon.log.errors.jsonl`
- daemon session 镜像：
  `~/.acp-runtime/logs/sessions/<sessionId>/daemon.log.text.jsonl` 和
  `daemon.log.errors.jsonl`

上传 source 分别是 `runtime-demo`、`bridge` 和 `daemon`。runtime demo 会上传
console 行、OpenTelemetry log records 和 OpenTelemetry spans。daemon 会在连接 relay
前安装全局 OpenTelemetry logger/tracer provider，因此 proxy 本地 agent 期间 ACP
runtime 发出的 logs 和 spans 也会上传。

stdio bridge 会确保每个出站 ACP request 都带 W3C `_meta.traceparent` metadata；
如果 client 没有提供，bridge 会生成一个。bridge 和 daemon 的本地 transport 日志会读取
这份 metadata，并把 `traceId`、`spanId` 作为顶层字段上传，因此同一次
request/response 可以跨 bridge、relay、daemon 过滤。relay Durable Object 转发带
trace 的 ACP frame 时，也会写 `eventName: "acp.relay.transport"`。daemon runtime
facade 会把这份 metadata 还原成 runtime session start/load/resume/list/fork spans 的
parent context。`session/new` 请求发出时还没有 `sessionId`，所以第一条创建请求只能用
trace 串联；它的响应和后续 session 流量会同时镜像到 session 日志目录。

常用环境变量：

- `ACP_RELAY_LOG_UPLOAD=0` 在本地关闭上传。
- `ACP_RELAY_LOG_UPLOAD_URL` 覆盖自动推导的 `https://<relay>/api/logs`。
- `ACP_RELAY_LOG_UPLOAD_TOKEN` 覆盖 account session bearer token。
- `ACP_RELAY_LOG_UPLOAD_BATCH_SIZE` 调整本地 batch size。
- `ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS` 调整本地 flush interval。

可以在 Cloudflare Logs/Observability 里查，也可以：

```bash
cd packages/relay-worker
wrangler tail acp-relay-worker --format=json
```

搜索 `eventName="acp.relay.log"`、`eventName="acp.relay.transport"`、`source`、
`traceId`、`spanId`，或
`acp.session.id`、`acp.remote.daemon_id` 等 ACP attributes。`uploadId` 只是低层
batch 传输诊断字段。这些日志可能包含 prompt、tool output、路径和错误详情；敏感部署启用前要先关闭上传或增加 redaction。

## Native ACP Client Flow

1. Native ACP client 直接打开 `wss://<relay>/acp?accountId=<account>`，或启动
   配置了同一 relay URL 的通用 stdio bridge。
2. Relay bootstrap 处理 `initialize`，返回 browser auth method。
3. Client 调用 `authenticate`。
4. 用户打开 `/authorize`，登录账号，并选择在线 host。如果页面同时选择了
   agent/workspace，这次选择会保留给这个 connection 上第一个 `session/new` 使用。
5. Relay 校验 account session、grant、host 和 scopes。
6. Relay 签发短期 ticket，并把 ACP connection 绑定到 daemon。
7. 第一次保留的选择被消费后，后续每次 `session/new` 时，client 再进入
   `/authorize`，为这次 session 选择 agent 和 workspace。Workspace 可以从 daemon
   上报的 root tree 里浏览选择；daemon 端仍会做 realpath 校验，保证选择路径没有
   逃出允许 root。
8. Daemon 使用这次 session 的 agent/workspace 选择创建 runtime session。

## Stdio Bridge Compatibility

对于只能启动本地 command、并通过 stdin/stdout 通信的 ACP client，使用 stdio bridge。
bridge 应该：

- 在本地 client 侧通过 stdio 说标准 ACP JSON-RPC
- 连接 relay `/acp` WebSocket
- 暴露同一个 relay bootstrap auth method 和 metadata
- 把 host/workspace 选择保留在 `/authorize`
- 避免 editor-specific 行为，也不要实现 runtime 语义

默认情况下，client 调用 `authenticate` 时，bridge 会打开 relay 返回的 `authUrl`。
如果这次授权已经选择了 agent/workspace，relay 会把它用于第一个 `session/new`；
后续 `session/new` 会再次打开 URL，让用户在 relay UI 里选择这个新 session 的
agent 和 workspace。每个 `session/new` 授权都会带 bridge 生成的 request-scoped
selection id，因此高并发创建 session 时不会消费到其他请求的 agent/workspace
选择。`session/load` 和 `session/resume` 会复用已经绑定的 connection
和已有 session metadata。在新的未绑定 client 进程里，历史 `session/load` 和
`session/resume` 会从 session 持久化的 remote binding metadata 恢复。relay 也会在
成功的 `session/new`、`session/load` 或 `session/resume` 响应后，把这个 binding
写入 control plane；因此即使 ACP client 没保存 `_meta`，bridge 本地 cache 也丢了，
新的未绑定 client 进程仍可恢复。relay 会在转发前重新校验 daemon、grant、agent 和
workspace。授权通过后，daemon 作为 ACP transport proxy：`session/update` 历史回放
来自被选择的 ACP agent，并通过 relay/bridge 转发给 client，不再由 daemon 从 runtime
history 重新构造。它们不会重新打开 `/authorize`；如果 metadata 缺失或已经失效，relay 会返回明确的
ACP error，client 应该新建 session 或显式 authenticate。对于已经绑定的 ACP 流量，只要当前 grant 和已选择的
agent/workspace 仍然有效，relay 会在转发请求前自动续签快过期的 ticket。显式
`authenticate` 仍会返回新的 ticket metadata；bridge 也会始终为显式
authentication 打开当前授权 URL，避免旧浏览器标签页产生 `Unknown ACP connection`。
本地 smoke test 可以同时设置 account session 和
`ACP_REMOTE_AUTO_AUTHORIZE=1` 来绕过 UI，但这不是产品默认路径。

能直连 WebSocket 的 ACP client 应直接连接 `/acp`，不需要 bridge。

## Validation

部署前先跑 focused checks：

```bash
pnpm --filter @saaskit-dev/acp-relay-worker typecheck
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run packages/relay-worker/src/index.test.ts packages/relay-worker/src/native-acp-worker-smoke.test.ts src/runtime/remote/broker-daemon-smoke.test.ts src/runtime/remote/daemon/host-identity.test.ts
```

Worker smoke 已覆盖原生 ACP `initialize`、`authenticate`、`session/new` 和
`session/prompt`，路径经过 Worker routing、Durable Object routing、daemon
connection 和 simulator-backed 本地 runtime。broker/daemon smoke 也覆盖通用
stdio bridge 兼容路径，包括重连队列失败时返回错误的行为。

部署 hosted relay 并启动本地 daemon 后，再跑：

```bash
make remote-prod-smoke
```

这会针对 hosted relay 检查 `/health`、带登录态的 daemon discovery、原生 ACP
`initialize`、授权和 `session/new`。
