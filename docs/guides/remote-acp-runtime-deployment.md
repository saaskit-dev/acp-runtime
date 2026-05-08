# Remote ACP Runtime Deployment Guide

Language:
- English (default)
- [简体中文](../zh-CN/guides/remote-acp-runtime-deployment.md)

This guide covers the current native ACP client deployment slice only. Direct
WebSocket ACP clients can connect to `/acp`; stdio-only ACP clients use the
generic stdio bridge, which exposes a local ACP command and forwards to `/acp`:

```text
Native ACP Client -> /acp -> /authorize -> /daemon -> AcpRuntime
Native ACP Client -> stdio bridge -> /acp -> /authorize -> /daemon -> AcpRuntime
```

First-party IDE clients and remote IDE channels are not part of this deployment
path yet. The stdio bridge is a generic ACP transport adapter, not an
editor-specific integration.

This is an operator/deployment guide. Normal users should follow
[Remote ACP User Install](./remote-user-install.md) and should not deploy the
relay or manually provision control-plane records.

## Cloudflare Worker

1. Create or bind the D1 database named `acp-relay`.
2. Replace `database_id` in `packages/relay-worker/wrangler.jsonc`.
3. Apply the D1 schema:

```bash
pnpm --filter @saaskit-dev/acp-relay-worker db:migrations:apply:local
pnpm --filter @saaskit-dev/acp-relay-worker db:migrations:apply:remote
```

4. Set Worker secrets:

```bash
cd packages/relay-worker
wrangler secret put ACP_RELAY_CONTROL_PLANE_SECRET
wrangler secret put ACP_RELAY_TICKET_PRIVATE_KEY
wrangler secret put ACP_RELAY_ACCOUNT_SESSION_SECRET
```

`ACP_RELAY_TICKET_PRIVATE_KEY` is an Ed25519 PKCS#8 private key encoded as
base64url. Daemons verify tickets with the runtime's built-in relay public key;
private relay deployments can override daemon verification with
`ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS`.

The production relay keeps disconnected client and daemon routes resumable for
24 hours by default (`ACP_RELAY_CLIENT_RECONNECT_GRACE_MS` and
`ACP_RELAY_DAEMON_RECONNECT_GRACE_MS`). Connection tickets last 1 hour by
default (`ACP_RELAY_TICKET_TTL_MS`) and are renewed 5 minutes before expiry
(`ACP_RELAY_TICKET_RENEW_BEFORE_MS`) so short Cloudflare WebSocket drops,
laptop sleep, and daemon reconnects can resume without forcing a new user
authorization.

5. Optionally configure `ACP_RELAY_LOGIN_URL` as a Worker variable. When set,
   unauthenticated `/authorize` requests redirect to this login URL with
   `returnTo` and `accountId` query parameters. When unset, `/authorize` renders
   a minimal sign-in-required page.
6. Deploy:

```bash
pnpm --filter @saaskit-dev/acp-relay-worker deploy
```

## Automatic Control Plane Registration

Normal users should not manually provision relay control-plane records. The
default product path is login-driven:

1. GitHub OAuth creates or updates the relay account.
2. `acp-runtime daemon run` or `install` connects with the account session,
   proves possession of its local daemon private key, and the relay creates or
   updates the daemon host record.
3. The relay creates an account-wide default grant for that daemon with the
   standard ACP scopes.
4. The native client or stdio bridge is registered automatically when the relay
   authorizes a session for that account.

If a user's local daemon identity is lost or regenerated, a valid account
session plus a valid signature from the new daemon key is enough for the relay
to update the host record. Disabled hosts still require admin action.

The control-plane endpoints still exist for admin, enterprise policy, tests,
manual repair, and explicit grant management. They are protected by
`ACP_RELAY_CONTROL_PLANE_SECRET`:

- `/control-plane/accounts`
- `/control-plane/client-devices`
- `/control-plane/hosts`
- `/control-plane/grants`

Use these endpoints only when the default same-account grant is not the desired
policy, for example to revoke a daemon, disable a client, or constrain grants to
specific `workspaceRoots`.

## Daemon Registration

The daemon is the final execution authority. It must:

- Load or create a persistent daemon identity.
- Send its daemon public key during registration so the relay can create or
  update the host record for the logged-in account.
- Connect outbound to `/daemon?accountId=<account>&daemonId=<daemon>`.
- Sign daemon registration headers with the daemon private key.
- Verify relay connection tickets before creating `AgentSideConnection`.
- Enforce `workspaceRoots` before calling local `AcpRuntime`.

`src/runtime/remote/daemon` provides the identity, header-generation, CLI/env
config parser, and relay connector primitives for this path.

The daemon reports ACP registry ids as its primary agent choices. The
authorization ticket preserves the selected registry id, and the daemon passes
that id to `AcpRuntime`, so normal registry resolution owns command, args, env,
cache download, and alias behavior. PATH-discovered ACP binaries are still
reported as compatibility entries for local command overrides.

## Daemon CLI Install

Users should not need to keep a terminal open for the daemon. The packaged
`acp-runtime daemon` command supports a foreground mode and a macOS user service
mode:

```bash
npm install -g @saaskit-dev/acp-runtime

acp-runtime daemon install \
  --relay-url wss://<relay-host> \
  --workspace-root ~/Projects
```

The npm package install does not register a background daemon by itself.
First-time service registration is explicit because it creates a long-running
local process, may open browser login, and may need launchd or sudo privileges.

Users can manage login explicitly with:

```bash
acp-runtime auth login
acp-runtime auth status
acp-runtime auth logout
```

`auth login` stores the account session in `~/.acp/relay-session.json`. After a
fresh login, it installs the default macOS user daemon service only when no
daemon service exists. If a valid cached login already exists, it only reports
that authentication is already complete. Use `auth login --no-daemon` only when
intentionally caching login without registering a background service. `install`
and `run` perform the same login resolution for compatibility: they use
`--account-session` or `ACP_REMOTE_DAEMON_ACCOUNT_SESSION` when provided, then
fall back to the cached session, and open browser OAuth if no cached session
exists. The installed service reuses that cached session, so normal users do not
type relay ticket keys or account tokens. Use `acp-runtime auth login --force`
to refresh an expired or mismatched cached session and reinstall the default
macOS user daemon service. If the machine is already installed in system mode,
`auth login --force` automatically runs the system reinstall path and macOS
prompts for sudo.

On macOS, `install` writes a user LaunchAgent at
`~/Library/LaunchAgents/dev.saaskit.acp-runtime.daemon.plist`, starts it with
`launchctl`, and logs to `~/.acp-runtime/logs/daemon.out.log` and
`~/.acp-runtime/logs/daemon.err.log`. The LaunchAgent uses `RunAtLoad` and
unconditional `KeepAlive`, so launchd restarts it after both successful and
failed exits. The daemon process also reconnects to the relay with exponential
backoff after transient disconnects. `acp-runtime daemon stop` unloads the
LaunchAgent so it stays stopped until `start` or `install` loads it again.

For boot-time startup before GUI login, use the optional system LaunchDaemon:

```bash
acp-runtime auth login
acp-runtime daemon install --system
```

This writes `/Library/LaunchDaemons/dev.saaskit.acp-runtime.daemon.plist` and
sets `UserName` plus `HOME` for `SUDO_USER` by default. The target home is
important: it lets the system daemon reuse the user's cached
`~/.acp/relay-session.json` instead of looking under `/var/root` after sudo. Use
`--user` or `--home-dir` only when overriding the detected default. After a
service is installed, `status`, `start`, `stop`, and `uninstall` auto-detect
whether the installed mode is user or system. Use `--system` only to force
system mode or resolve an unexpected conflict.
Commands that modify the system service automatically re-run through `sudo`, so
macOS prompts for a password when needed.

Only one service mode should be installed on a machine. Installing `--system`
removes the target user's LaunchAgent. Installing user mode refuses to proceed
if a system LaunchDaemon is still installed, because removing it requires sudo.

After package upgrades, an already-installed daemon watches its own executable
path and exits when npm replaces that file; launchd `KeepAlive` restarts it with
the upgraded code. Rerun `acp-runtime daemon install` for user services, or
`acp-runtime daemon install --system` for system services, when installing for
the first time, switching modes, changing service options, or rewriting a plist
whose global npm command path changed. `start` only loads the existing plist.

Useful commands:

```bash
acp-runtime auth status
acp-runtime daemon status
acp-runtime daemon stop
acp-runtime daemon start
acp-runtime daemon uninstall
acp-runtime daemon run --relay-url wss://<relay-host> --workspace-root ~/Projects
```

`run` remains the foreground/debug path and is still what local Makefile targets
use. Service install currently targets macOS launchd; Linux systemd support
should use the same CLI contract when added.

## Relay Observability

The relay Worker has Cloudflare observability enabled and exposes
`POST /api/logs` for account-session-authenticated runtime telemetry. The
endpoint writes structured JSON records to Cloudflare logs with
`eventName: "acp.relay.log"`, the relay account id, source, upload id, context,
and the original record.

Runtime demo, stdio bridge, and daemon processes auto-enable relay uploads when
they have both a relay URL and an account session token. Local logs are still
written in the existing locations:

- runtime demo: `~/.acp-runtime/logs/runtime.log` and `.jsonl`
- runtime demo classified JSONL:
  `runtime.log.text.jsonl`, `runtime.log.events.jsonl`,
  `runtime.log.spans.jsonl`, and `runtime.log.errors.jsonl`
- session mirror: `~/.acp-runtime/logs/sessions/<sessionId>/`
- stdio bridge: `~/.acp-runtime/bridge.log`
- stdio bridge classified JSONL:
  `~/.acp-runtime/bridge.log.text.jsonl` and
  `~/.acp-runtime/bridge.log.errors.jsonl`
- stdio bridge session mirror:
  `~/.acp-runtime/logs/sessions/<sessionId>/bridge.log.text.jsonl` and
  `bridge.log.errors.jsonl`
- daemon service: `~/.acp-runtime/logs/daemon.out.log` and `daemon.err.log`
- daemon classified JSONL:
  `~/.acp-runtime/logs/daemon.log.text.jsonl` and
  `~/.acp-runtime/logs/daemon.log.errors.jsonl`
- daemon session mirror:
  `~/.acp-runtime/logs/sessions/<sessionId>/daemon.log.text.jsonl` and
  `daemon.log.errors.jsonl`

The uploaded sources are `runtime-demo`, `bridge`, and `daemon`. Runtime demo
uploads console lines, OpenTelemetry log records, and OpenTelemetry spans. The
daemon installs a global OpenTelemetry logger/tracer provider before connecting
to the relay, so ACP runtime logs and spans emitted while proxying local agents
are uploaded as well.

The stdio bridge ensures every outbound ACP request carries W3C
`_meta.traceparent` metadata when the client did not provide one. Bridge and
daemon local transport logs read that metadata and upload top-level `traceId`
and `spanId` fields, so a single request/response path can be filtered across
bridge, relay, and daemon records. The relay Durable Object also writes
`eventName: "acp.relay.transport"` when forwarding traced ACP frames. The
daemon runtime facade restores this metadata as the parent context for runtime
session start/load/resume/list/fork spans. Session creation has no `sessionId`
until the response, so the first `session/new` request is only
trace-correlated; its response and later session traffic are also mirrored under
the session log directory.

Useful environment variables:

- `ACP_RELAY_LOG_UPLOAD=0` disables uploads locally.
- `ACP_RELAY_LOG_UPLOAD_URL` overrides the derived `https://<relay>/api/logs`.
- `ACP_RELAY_LOG_UPLOAD_TOKEN` overrides the account session bearer token.
- `ACP_RELAY_LOG_UPLOAD_BATCH_SIZE` changes the local batch size.
- `ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS` changes the local flush interval.

Use Cloudflare Logs/Observability or:

```bash
cd packages/relay-worker
wrangler tail acp-relay-worker --format=json
```

Search for `eventName="acp.relay.log"`, `eventName="acp.relay.transport"`,
`source`, `traceId`, `spanId`, or the
ACP attributes such as `acp.session.id` and `acp.remote.daemon_id`. `uploadId`
is only a low-level batch-delivery diagnostic. These logs can contain prompts,
tool output, paths, and error details; disable upload or add redaction before
enabling it for sensitive deployments.

## Native ACP Client Flow

1. Native ACP client opens `wss://<relay>/acp?accountId=<account>` directly, or
   launches the generic stdio bridge configured with the same relay URL.
2. Relay bootstrap handles `initialize` and returns a browser auth method.
3. Client calls `authenticate`.
4. User opens `/authorize`, signs in, and selects an online host. If the page
   also selects an agent/workspace, that choice is reserved for the first
   `session/new` on this connection.
5. Relay validates the account session, grant, host, and scopes.
6. Relay signs a short-lived ticket and binds the ACP connection to the daemon.
7. After the first reserved selection is consumed, each later `session/new`
   returns to `/authorize` to select the agent and workspace for that session.
   Workspace selection can browse the daemon-provided root tree; daemon-side
   realpath checks keep selection inside the advertised roots.
8. Daemon creates the runtime session using that per-session agent/workspace
   selection.

## Stdio Bridge Compatibility

Use the stdio bridge for ACP clients that can only launch a local command and
communicate over stdin/stdout. The bridge should:

- speak standard ACP JSON-RPC over stdio to the local client
- connect to the relay `/acp` WebSocket
- expose the same relay bootstrap auth method and metadata
- keep host/workspace selection in `/authorize`
- avoid editor-specific behavior and avoid implementing runtime semantics

By default the bridge opens the relay `authUrl` when the client calls
`authenticate`. If that authorization selected an agent/workspace, the relay
uses it for the first `session/new`. Later `session/new` calls open the URL
again so the user can select that new session's agent and workspace in the relay
UI. Each `session/new` authorization is request-scoped with a bridge-generated
selection id, so concurrent session creation cannot consume another request's
agent/workspace selection. `session/load` and `session/resume` reuse the already bound connection and
existing session metadata. On a fresh unbound client process, historical
`session/load` and `session/resume` restore from the session's remote binding
metadata. The relay also persists this binding in the control plane after
successful `session/new`, `session/load`, or `session/resume` responses, so a
later unbound client process can restore even if the ACP client did not preserve
`_meta` and the bridge-local cache is gone. The relay revalidates the daemon,
grant, agent, and workspace before forwarding. After authorization, the daemon
acts as an ACP transport proxy: `session/update` history replay comes from the
selected ACP agent and is forwarded back through relay/bridge without daemon
runtime-history reconstruction. They do not reopen `/authorize`; if the metadata is missing or no
longer valid, the relay returns a clear ACP error and the client should start a
new session or explicitly authenticate.
For already bound ACP traffic, the relay renews near-expiry tickets before
forwarding the request when the current grant and selected agent/workspace are
still valid. Explicit `authenticate` still returns fresh ticket metadata, and
the bridge always opens the current authorization URL for explicit
authentication so stale browser tabs do not produce `Unknown ACP connection`.
Local smoke tests may set `ACP_REMOTE_AUTO_AUTHORIZE=1` together with an account
session to bypass the UI, but that is not the product default.

Direct WebSocket-capable ACP clients should connect to `/acp` without the
bridge.

## Validation

Run focused checks before deploying:

```bash
pnpm --filter @saaskit-dev/acp-relay-worker typecheck
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run packages/relay-worker/src/index.test.ts packages/relay-worker/src/native-acp-worker-smoke.test.ts src/runtime/remote/broker-daemon-smoke.test.ts src/runtime/remote/daemon/host-identity.test.ts
```

The Worker smoke covers native ACP `initialize`, `authenticate`, `session/new`,
and `session/prompt` through Worker routing, Durable Object routing, daemon
connection, and the simulator-backed local runtime. The broker/daemon smoke also
covers the generic stdio bridge compatibility path, including reconnect backlog
failure behavior.

After deploying the hosted relay and starting a local daemon, run:

```bash
make remote-prod-smoke
```

This checks `/health`, authenticated daemon discovery, native ACP
`initialize`, authorization, and `session/new` against the hosted relay.
