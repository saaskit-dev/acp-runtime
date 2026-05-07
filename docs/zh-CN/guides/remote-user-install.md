[English](../../guides/remote-user-install.md)

# Remote ACP 用户安装

本文档面向普通用户，默认 relay 已经由产品方或管理员托管。用户不需要部署
Cloudflare、不需要创建 D1 database，也不需要手工 provision control-plane 记录。

默认托管 relay 是 `relay.saaskit.app`。

## 安装包

```bash
npm install -g @saaskit-dev/acp-runtime
```

安装后会有一个命令和 remote 子命令：

- `acp-runtime daemon`：本机 daemon，负责运行 agent。
- `acp-runtime bridge`：通用 stdio ACP bridge，给不能直连 relay WebSocket 的 client
  使用。

## 安装 Daemon

```bash
acp-runtime daemon install
```

第一次运行时，如果没有登录缓存，会打开浏览器登录。登录后，relay 会按需自动创建
account、daemon host record、default grant 和 client device record。

如果本地登录缓存已经失效，或缓存属于另一个 relay 部署，可以强制重新登录：

```bash
acp-runtime daemon install --force-login
```

默认情况下 daemon 连接 `wss://relay.saaskit.app`，并把用户 home 目录作为 workspace
root。只有需要覆盖默认值时才使用 `--relay-url` 或 `--workspace-root`。

在 macOS 上，`install` 会注册 user LaunchAgent 并立即启动。它会在用户登录时自动
启动，正常退出和异常退出后都会由 launchd 拉起；网络或 relay 短暂断开后，daemon
自身也会用退避策略自动重连。`acp-runtime daemon stop` 会 unload LaunchAgent，所以会
保持停止，直到再次执行 `start` 或 `install`。

常用 daemon 命令：

```bash
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon start
acp-runtime daemon uninstall
acp-runtime daemon run
```

`run` 用于前台调试；普通后台服务使用 `install`。

## 配置 Stdio Client

如果 ACP client 只能启动本地 stdio command，就让它启动 bridge，并在 env 里设置
relay URL：

```json
{
  "command": "acp-runtime",
  "args": ["bridge", "run"]
}
```

bridge 可以输出这个通用配置：

```bash
acp-runtime bridge config
```

能直连 WebSocket 的 ACP client 应直接连接 `wss://relay.saaskit.app/acp`，不需要
bridge。

bridge 是通用兼容层，不是 Zed 专用路径。如果 relay 或网络短暂断开，而 ACP client
仍保持 stdio 进程存活，bridge 会用同一个 connection id 自动重连。短暂重连期间排队
的请求会继续转发；超过有界重连队列或超时时，请求会收到 JSON-RPC error，而不是让
bridge 进程直接退出。

Relay connection ticket 是短期票据，但正常空闲 session 不应该要求用户再次走浏览器
授权。只要已有 daemon、client device、grant、agent 和 workspace 选择仍然有效，
relay 会在转发下一条已绑定 ACP 请求前自动续签 ticket，并把新的 ticket 更新到
daemon route。若 client 离线太久导致 connection 已过期，或 grant 已失效，client
会收到 authentication error；下一次 `authenticate` 会打开新的授权 URL。

## 正常流程

1. 安装 npm 包。
2. 安装 daemon 并登录。
3. 配置 ACP client 或 stdio bridge。
4. 从 client 开启 session。
5. relay 打开授权 UI，用户选择 machine、agent 和 workspace。

授权 UI 会在所选 daemon 上报 `codex-acp` 时默认选中 Codex。用户仍然可以在新
session 里选择其他已上报的 ACP agent。

普通产品路径里，用户不应该输入 relay ticket key、daemon ID、account ID 或
control-plane secret。
