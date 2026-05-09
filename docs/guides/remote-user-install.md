# Remote ACP User Install

Language:
- English (default)
- [简体中文](../zh-CN/guides/remote-user-install.md)

This page is for normal users. It assumes the relay is already hosted by the
product or by an administrator. Users do not deploy Cloudflare, create D1
databases, or manually provision control-plane records.

The default hosted relay is `relay.saaskit.app`.

## Install From Source

Recommended one-command install:

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash
```

The script clones the source repository, builds it, installs the CLI globally
from that source checkout, then runs `acp-runtime auth login`. On a fresh macOS
login, that installs the default user daemon if no daemon service exists. From a
local checkout, run the same script directly to build and install that checkout:

```bash
./scripts/install.sh
```

Use `--system` when this machine should use the boot-time system daemon:

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --system
```

This installs one command with remote subcommands:

- `acp-runtime auth`: browser login and cached account-session management.
- `acp-runtime daemon`: the local machine daemon that runs agents.
- `acp-runtime bridge`: a generic stdio ACP bridge for clients that cannot connect
  to the relay WebSocket directly.

Source install does not register a background daemon by itself. First-time
service registration happens through `auth login` because it may open browser
login and may need launchd or sudo privileges.

## Sign In

```bash
acp-runtime auth login
```

This opens browser login and stores the account session at
`~/.acp/relay-session.json`. If this is a fresh login and no daemon service is
installed yet, it also installs the default macOS user daemon service. If a
valid cached login already exists, it only reports that authentication is
already complete. Use `--no-daemon` only when intentionally caching login
without registering a background service. Check or clear that login with:

```bash
acp-runtime auth status
acp-runtime auth logout
```

If the cached login is expired or belongs to a different relay deployment,
refresh it explicitly. On macOS user mode, this also reinstalls the default user
daemon service so the launchd plist and service process match the refreshed
login and current CLI configuration. If the machine is already installed in
system mode, the same command automatically runs the system reinstall path and
macOS prompts for sudo:

```bash
acp-runtime auth login --force
```

## Advanced: Install Daemon

```bash
acp-runtime daemon install
```

Most users do not need to run this command directly; `auth login` handles the
default user daemon after a fresh login. `daemon install` remains useful for
system mode, changing relay/workspace options, and repairing or rewriting the
launchd plist.

If no cached session exists, daemon install still opens browser login for
backward compatibility. In the normal fresh-login flow, `auth login` installs
the default user daemon when no service exists, so `daemon install` is mainly for
changing service options, switching service mode, or repairing an install. After
login, the relay
automatically creates the account, daemon host record, default grant, and client
device records as needed. Use `acp-runtime auth login --force` to refresh an
expired or mismatched cached session and reinstall the default user daemon.

By default the daemon connects to `wss://relay.saaskit.app` and exposes the
user's home directory as the workspace root. Use `--relay-url` or
`--workspace-root` only when overriding those defaults.

On macOS, `install` registers a user LaunchAgent and starts it immediately. It
runs at login and is restarted by launchd after both successful and failed
exits. It also reconnects to the relay with backoff after transient network
failures. `acp-runtime daemon stop` unloads the LaunchAgent so it stays stopped
until `restart` or `install` loads it again.

If the daemon must start at system boot before the user logs in, install the
optional system LaunchDaemon:

```bash
acp-runtime auth login
acp-runtime daemon install --system
```

System install writes `/Library/LaunchDaemons/dev.saaskit.acp-runtime.daemon.plist`
and runs the daemon as `SUDO_USER` by default, so it can read that user's cached
`~/.acp/relay-session.json` and write logs under that user's home directory. Use
`--user` or `--home-dir` only when overriding that detected default. After a
service is installed, `status`, `restart`, `stop`, and `uninstall` auto-detect the
installed mode. `--system` is only needed to force system mode or resolve an
unexpected conflict. Commands that modify the system service automatically
re-run through `sudo`, so macOS prompts for a password when needed.

Only one service mode should be installed on a machine. Installing `--system`
removes the target user's LaunchAgent. Installing user mode refuses to proceed
if a system LaunchDaemon is still installed, because removing it requires sudo.

Useful daemon commands:

```bash
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon restart
acp-runtime daemon uninstall
acp-runtime daemon run
```

Use `run` for foreground debugging. Use `install` for the normal background
service.

## Upgrade Daemon

If a daemon service is already installed, the running daemon watches its own
executable path and exits when that file changes. Because launchd has
`KeepAlive`, it restarts with the upgraded code after a source reinstall that
replaces the same command path:

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --no-login
acp-runtime daemon status
```

Run `daemon install` again only when switching between user and system mode,
changing workspace roots or relay options, or when the global command path
itself changed and the plist must be rewritten:

```bash
acp-runtime daemon install
```

For the optional boot-time service, use:

```bash
curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash -s -- --no-login
acp-runtime daemon install --system
acp-runtime daemon status
```

`install` rewrites the plist and kickstarts launchd, so the next daemon process
uses the newly installed global package path. `daemon restart` force-loads and
kickstarts an existing plist; use `install` after upgrades that change service
configuration or command path.

## Configure Stdio Clients

If the ACP client can only launch a local stdio command, configure it to run the
bridge with the relay URL in the environment:

```json
{
  "command": "/absolute/path/to/acp-runtime",
  "args": ["bridge", "run"],
  "env": {
    "ACP_RELAY_URL": "wss://relay.saaskit.app"
  }
}
```

The bridge can print this generic config. By default it resolves the installed
`acp-runtime` command to an absolute path with `command -v acp-runtime`; use
`--command <path>` to override it:

```bash
acp-runtime bridge config
```

For Zed, generate the custom agent config with `--zed` and place it under
`agent_servers` in Zed settings:

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
2. Sign in; on fresh login, this installs the default user daemon on macOS if no service exists.
3. Configure the ACP client or stdio bridge.
4. Start a session from the client.
5. The relay opens authorization UI where the user selects machine, agent, and
   workspace.

The authorization UI defaults to Codex (`codex-acp`) when the selected daemon
advertises it. Users can still choose a different advertised ACP agent for a new
session.

Users should not type relay ticket keys, daemon IDs, account IDs, or control
plane secrets in the normal product flow.
