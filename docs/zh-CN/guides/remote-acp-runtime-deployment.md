[English](../../guides/remote-acp-runtime-deployment.md)

# Remote ACP Runtime 部署指南

本文档只覆盖当前原生 ACP client 部署切片：

```text
Native ACP Client -> /acp -> /authorize -> /daemon -> AcpRuntime
```

自家 IDE client、`remote/client` 和 Remote IDE channel 当前不进入这条部署路径。

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
wrangler secret put ACP_RELAY_TICKET_SECRET
wrangler secret put ACP_RELAY_ACCOUNT_SESSION_SECRET
```

5. 可选配置 `ACP_RELAY_LOGIN_URL` Worker variable。配置后，未登录的
   `/authorize` 会重定向到这个登录地址，并附带 `returnTo` 和 `accountId` query
   参数；未配置时，`/authorize` 渲染最小 sign-in-required 页面。
6. 部署：

```bash
pnpm --filter @saaskit-dev/acp-relay-worker deploy
```

## Control Plane Records

Relay 只存关系 metadata。通过以下 control-plane endpoints 写入，所有 endpoint 都由
`ACP_RELAY_CONTROL_PLANE_SECRET` 保护：

- `/control-plane/accounts`
- `/control-plane/client-devices`
- `/control-plane/hosts`
- `/control-plane/grants`

按这个顺序 provision：

1. Account record。
2. Native ACP client metadata record，`clientDeviceId` 固定为
   `"native-acp-client"`。当前原生 ACP 路径使用浏览器账号授权，所以这个 public key
   只是 metadata；在 native device-key registration 做出来前可以用 placeholder。
3. Host record，写入 daemon host public key。
4. Grant record，包含 `acp:connect` 和需要的 ACP scopes，可选写入
   `workspaceRoots`。

## Daemon Registration

Daemon 是最终执行 authority。它必须：

- 加载或创建持久化 host identity。
- 把 host public key 注册到 relay control plane。
- 主动连接 `/daemon?accountId=<account>&hostId=<host>`。
- 用 host private key 签名 daemon registration headers。
- 创建 `AgentSideConnection` 前验证 relay connection ticket。
- 调用本地 `AcpRuntime` 前执行 `workspaceRoots` 检查。

`src/runtime/remote/daemon` 已提供这条路径需要的 identity、header generation、
CLI/env config parser 和 relay connector primitives。

## Native ACP Client Flow

1. Native ACP client 打开 `wss://<relay>/acp?accountId=<account>`。
2. Relay bootstrap 处理 `initialize`，返回 browser auth method。
3. Client 调用 `authenticate`。
4. 用户打开 `/authorize`，登录账号，并选择在线 host。
5. Relay 校验 account session、grant、host 和 scopes。
6. Relay 签发短期 ticket，并把 ACP connection 绑定到 daemon。
7. Daemon 创建 `AgentSideConnection`，提供标准 ACP session 方法。

## Validation

部署前先跑 focused checks：

```bash
pnpm --filter @saaskit-dev/acp-relay-worker typecheck
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run packages/relay-worker/src/index.test.ts packages/relay-worker/src/native-acp-worker-smoke.test.ts src/runtime/remote/daemon/host-identity.test.ts
```

Worker smoke 已覆盖原生 ACP `initialize`、`authenticate`、`session/new` 和
`session/prompt`，路径经过 Worker routing、Durable Object routing、daemon
connection 和 simulator-backed 本地 runtime。
