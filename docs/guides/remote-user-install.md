# Remote ACP User Install

Language:
- English (default)
- [简体中文](../zh-CN/guides/remote-user-install.md)

This page is for normal users. It assumes the relay is already hosted by the
product or by an administrator. Users do not deploy Cloudflare, create D1
databases, or manually provision control-plane records.

The default hosted relay is `relay.saaskit.app`.

## Install Package

```bash
npm install -g @saaskit-dev/acp-runtime
```

This installs one command with remote subcommands:

- `acp-runtime daemon`: the local machine daemon that runs agents.
- `acp-runtime bridge`: a generic stdio ACP bridge for clients that cannot connect
  to the relay WebSocket directly.

## Install Daemon

```bash
acp-runtime daemon install
```

The first run opens browser login if no cached session exists. After login, the
relay automatically creates the account, daemon host record, default grant, and
client device records as needed.

If the cached login is expired or belongs to a different relay deployment,
refresh it explicitly:

```bash
acp-runtime daemon install --force-login
```

By default the daemon connects to `wss://relay.saaskit.app` and exposes the
user's home directory as the workspace root. Use `--relay-url` or
`--workspace-root` only when overriding those defaults.

On macOS, `install` registers a user LaunchAgent and starts it immediately. It
runs at login and is restarted by launchd after both successful and failed
exits. It also reconnects to the relay with backoff after transient network
failures. `acp-runtime daemon stop` unloads the LaunchAgent so it stays stopped
until `start` or `install` loads it again.

Useful daemon commands:

```bash
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon start
acp-runtime daemon uninstall
acp-runtime daemon run
```

Use `run` for foreground debugging. Use `install` for the normal background
service.

## Configure Stdio Clients

If the ACP client can only launch a local stdio command, configure it to run the
bridge with the relay URL in the environment:

```json
{
  "command": "acp-runtime",
  "args": ["bridge", "run"]
}
```

The bridge can print this generic config:

```bash
acp-runtime bridge config
```

Direct WebSocket-capable ACP clients should connect to
`wss://relay.saaskit.app/acp` and do not need the bridge.

The bridge is designed as a compatibility layer, not as a Zed-specific path. If
the relay or network drops while the ACP client keeps the stdio process alive,
the bridge reconnects with the same connection id. Requests queued during a
short reconnect are replayed; requests that exceed the bounded reconnect queue
or timeout receive JSON-RPC errors instead of causing the bridge process to
exit.

Relay connection tickets are short lived, but normal idle sessions should not
force the user through browser authorization again. When the existing daemon,
client device, grant, agent, and workspace selection are still valid, the relay
renews the ticket before forwarding the next bound ACP request and updates the
daemon route. If the client was offline long enough for the connection to expire
or the grant is no longer valid, the client receives an authentication error and
the next `authenticate` opens a fresh authorization URL.

## Normal Flow

1. Install package.
2. Install daemon and sign in.
3. Configure the ACP client or stdio bridge.
4. Start a session from the client.
5. The relay opens authorization UI where the user selects machine, agent, and
   workspace.

The authorization UI defaults to Codex (`codex-acp`) when the selected daemon
advertises it. Users can still choose a different advertised ACP agent for a new
session.

Users should not type relay ticket keys, daemon IDs, account IDs, or control
plane secrets in the normal product flow.
