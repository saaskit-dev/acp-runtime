[English](../../guides/remote-user-install.md)

# Remote ACP 用户安装

本文档面向普通用户，默认 relay 已经由产品方或管理员托管。用户不需要部署
Cloudflare、不需要创建 D1 database，也不需要手工 provision control-plane 记录。

默认托管 relay 是 `relay.saaskit.app`。

## 从源码安装

推荐的一条命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash
```

这个脚本会 clone 源码仓库、构建源码、从该源码 checkout 全局安装 CLI，然后执行
`acp-runtime auth login`。在 macOS 上，如果这是新登录并且还没有 daemon service，会
安装默认 user daemon。本地 checkout 里也可以直接运行同一个脚本，它会构建并安装当前
checkout：

安装会跟随用户当前的 npm global prefix，不要求安装过 `n`。如果 npm global bin
目录不在 `PATH` 里，脚本会输出 `acp-runtime` 的绝对路径，以及应该加到 shell profile
里的 `PATH` 配置。

```bash
./scripts/install.sh
```

如果这台机器要使用开机级 system daemon，使用：

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --system
```

安装后会有一个命令和 remote 子命令：

- `acp-runtime auth`：浏览器登录和本地 account session 缓存管理。
- `acp-runtime daemon`：本机 daemon，负责运行 agent。
- `acp-runtime bridge`：通用 stdio ACP bridge，给不能直连 relay WebSocket 的 client
  使用。

源码安装本身不会自动注册后台 daemon。首次注册 service 通过 `auth login` 触发，因为
它可能打开浏览器登录，也可能需要 launchd 或 sudo 权限。

## 登录

```bash
acp-runtime auth login
```

这个命令会打开浏览器登录，把 account session 保存到
`~/.acp/relay-session.json`。如果这是一次新的登录，并且机器上还没有 daemon service，
它也会安装默认的 macOS user daemon service。如果本地已经有有效登录缓存，它只提示
已经登录。只有想单纯缓存登录、不注册后台服务时才使用 `--no-daemon`。可以用下面的
命令查看或清理登录状态：

```bash
acp-runtime auth status
acp-runtime auth logout
```

如果本地登录缓存已经失效，或缓存属于另一个 relay 部署，可以强制重新登录。在 macOS
user mode 下，这也会重装默认 user daemon service，确保 launchd plist 和 service 进程
对应刷新后的登录和当前 CLI 配置。如果机器已经是 system mode，同一个命令会自动走
system reinstall 路径，macOS 会提示输入 sudo 密码：

```bash
acp-runtime auth login --force
```

## 高级：安装 Daemon

```bash
acp-runtime daemon install
```

大多数用户不需要直接运行这个命令；新登录后，`auth login` 会处理默认 user daemon。
`daemon install` 主要保留给 system mode、修改 relay/workspace 参数，以及修复或重写
launchd plist。

为了兼容旧流程，如果没有登录缓存，daemon install 仍然会打开浏览器登录。正常新登录
流程里，如果没有 service，`auth login` 会安装默认 user daemon，所以 `daemon install`
主要用于修改 service 参数、切换 service mode 或修复安装。登录后，relay 会按需自动
创建 account、daemon host record、default grant 和 client device record。安装或更新
daemon 前，如果需要刷新过期或不匹配的缓存 session 并重装默认 user daemon，使用
`acp-runtime auth login --force`。

默认情况下 daemon 连接 `wss://relay.saaskit.app`，并把用户 home 目录作为 workspace
root。只有需要覆盖默认值时才使用 `--relay-url` 或 `--workspace-root`。

在 macOS 上，`install` 会注册 user LaunchAgent 并立即启动。它会在用户登录时自动
启动，正常退出和异常退出后都会由 launchd 拉起；网络或 relay 短暂断开后，daemon
自身也会用退避策略自动重连。`acp-runtime daemon stop` 会 unload LaunchAgent，所以会
保持停止，直到再次执行 `restart` 或 `install`。

如果 daemon 必须在系统启动时、用户登录前就拉起，可以安装可选的 system
LaunchDaemon：

```bash
acp-runtime auth login
acp-runtime daemon install --system
```

system install 会写入
`/Library/LaunchDaemons/dev.saaskit.acp-runtime.daemon.plist`，默认让 daemon 以
`SUDO_USER` 身份运行，这样它可以读取该用户的 `~/.acp/relay-session.json` 登录缓存，
并把日志写到该用户 home 下。只有需要覆盖自动检测结果时才使用 `--user` 或
`--home-dir`。service 安装后，`status`、`restart`、`stop` 和 `uninstall` 会自动判断当前
安装模式。只有需要强制 system mode，或处理异常冲突时才需要 `--system`。会修改
system service 的命令会自动通过 `sudo` 重新执行，所以需要权限时 macOS 会提示输入
密码。

一台机器应该只安装一种 service 模式。安装 `--system` 会移除目标用户的 LaunchAgent。
安装 user mode 时，如果 system LaunchDaemon 仍然存在，会拒绝继续，因为移除它需要
sudo。

常用 daemon 命令：

```bash
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon restart
acp-runtime daemon uninstall
acp-runtime daemon run
```

`run` 用于前台调试；普通后台服务使用 `install`。

## 升级 Daemon

如果 daemon service 已经安装，运行中的 daemon 会监控自己的可执行文件路径；源码重新
安装替换同一路径后，daemon 会退出。由于 launchd 配了 `KeepAlive`，它会自动用升级后
的代码重新拉起：

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --no-login
acp-runtime daemon status
```

只有切换 user/system 模式、修改 workspace root 或 relay 参数，或者全局命令路径本身
变化、需要重写 plist 时，才需要重新执行：

```bash
acp-runtime daemon install
```

如果使用开机级 system service，则使用：

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --no-login
acp-runtime daemon install --system
acp-runtime daemon status
```

`install` 会重写 plist 并 kickstart launchd，所以新的 daemon 进程会使用刚安装的全局
包路径。`daemon restart` 会强制加载并 kickstart 已有 plist；升级后如果 service 配置或
命令路径变化，应使用 `install`。

## 配置 Stdio Client

如果 ACP client 只能启动本地 stdio command，就让它启动 bridge，并在 env 里设置
relay URL：

```json
{
  "command": "/absolute/path/to/acp-runtime",
  "args": ["bridge", "run"],
  "env": {
    "ACP_RELAY_URL": "wss://relay.saaskit.app"
  }
}
```

bridge 可以输出这个通用配置。默认会用 `command -v acp-runtime` 把已安装的
`acp-runtime` 解析成绝对路径；也可以用 `--command <path>` 手动覆盖：

```bash
acp-runtime bridge config
```

Zed 使用 `--zed` 生成 custom agent 配置，并放到 Zed settings 的
`agent_servers` 下：

```bash
acp-runtime bridge config --zed
```

```json
{
  "type": "custom",
  "command": "/absolute/path/to/acp-runtime",
  "args": ["bridge", "run"],
  "env": {
    "ACP_RELAY_URL": "wss://relay.saaskit.app"
  }
}
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

1. 从源码安装 CLI。
2. 登录；新登录时，如果没有 service，这个步骤会在 macOS 上安装默认 user daemon。
3. 配置 ACP client 或 stdio bridge。
4. 从 client 开启 session。
5. relay 打开授权 UI，用户选择 machine、agent 和 workspace。

授权 UI 会在所选 daemon 上报 `codex-acp` 时默认选中 Codex。用户仍然可以在新
session 里选择其他已上报的 ACP agent。

普通产品路径里，用户不应该输入 relay ticket key、daemon ID、account ID 或
control-plane secret。
