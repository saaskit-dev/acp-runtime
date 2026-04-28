# Remote ACP Runtime Implementation Plan

Language:
- English (default)
- [简体中文](../zh-CN/guides/remote-acp-runtime-implementation-plan.md)

This plan turns [RFC-0006](../rfcs/0006-remote-acp-runtime-relay.md) into an
implementation sequence. The first implementation priority is the native ACP
client path:

```text
Native ACP Client
  -> Relay /acp
  -> bootstrap auth and host selection
  -> Host Daemon
  -> AcpRuntime
  -> local ACP agent
```

First-party clients and remote IDE channels remain the long-term product
direction, but they are intentionally deferred until the native ACP remote path
works end to end.

## Phase 0: Design and Boundaries

- Keep RFC-0006 as the source of truth for account, host, client device, grant,
  ticket, relay, and daemon boundaries.
- Keep local-first runtime behavior intact; existing `AcpRuntime` use must not
  depend on any relay.
- Keep native ACP client compatibility focused on standard ACP
  `initialize/authenticate/session/*` methods.
- Do not build `src/runtime/remote/client` in the first implementation phase.
- Do not build `examples/remote` in the first implementation phase.

## Phase 1: Native ACP Remote MVP

### 1.1 WebSocket ACP Stream

- Implement `ACP JSON-RPC over WebSocket` stream adapters.
- Support both native ACP client side and daemon side full-duplex JSON-RPC.
- Preserve ACP message schema; remote routing metadata stays outside ACP payloads.
- Add tests with SDK `ClientSideConnection` and `AgentSideConnection`.

### 1.2 Relay Bootstrap Facade

- Add relay `/acp` support for unbound native ACP connections.
- Return a browser or device-code auth method from bootstrap `initialize`.
- Handle bootstrap `authenticate` by creating a pending authorization.
- Bind the ACP connection to a selected host after browser authorization.
- Reject runtime methods such as `session/new` until the connection is bound.

### 1.3 Daemon Connection

- Add daemon outbound connection to `/daemon?hostId=...`.
- Register host presence with the relay.
- Receive bound ACP connection frames from relay.
- Create `AgentSideConnection` using `AcpRemoteRuntimeAgent`.
- Drive local `AcpRuntime` through the daemon facade.

### 1.4 Browser Authorization Loop

- Provide a minimal browser authorization page.
- Let the user log in, select account, host, and workspace.
- Issue a short-lived connection ticket for the waiting ACP connection.
- Let relay bind `connectionId -> hostId -> daemon`.
- Keep this minimal; polished first-party client UI comes later.

### 1.5 ACP Session Methods

- Run `initialize`.
- Run `authenticate`.
- Run `session/new`.
- Run `session/prompt`.
- Run `session/cancel`.
- Stream `session/update` notifications.
- Preserve bidirectional client authority callbacks.

### 1.6 Authority Forwarding

- Forward runtime permission requests to the ACP client.
- Forward filesystem read/write when the ACP client advertises `fs` support.
- Forward terminal calls when the ACP client advertises terminal support.
- Treat terminal forwarding as optional for the MVP; do not block basic prompt
  turns on terminal support.

### 1.7 MVP Validation

- Use an SDK-backed ACP client smoke path against the relay endpoint.
- Use simulator agent as the local daemon-side runtime agent.
- Validate prompt text, event streaming, cancellation, and permission flow.
- Keep focused tests deterministic and independent of Cloudflare account state.

## Phase 2: Account, Host, and Ticket Foundation

### 2.1 Account Control Plane

- Add account model.
- Add client device model.
- Add host daemon model.
- Add account-host binding.
- Add grant storage.

### 2.2 Device and Host Keys

- Generate client device keypairs.
- Generate daemon host keypairs.
- Support signed nonce checks.
- Register and revoke client devices.
- Register and revoke host daemons.

### 2.3 Connection Tickets

- Implement signed ticket payloads.
- Bind tickets to `connectionId`.
- Include `hostId`, `workspaceId`, `scopes`, and `policyVersion`.
- Validate ticket signature, expiration, and scopes in daemon.
- Keep tickets short-lived and scoped.

### 2.4 Ticket Renewal

- Renew tickets before expiration.
- Require device-key signed renewal proof.
- Re-check account session, grants, revocation, and policy version on renewal.
- Propagate renewed ticket state to daemon.
- Fail gracefully with a short grace period for transient network issues.

### 2.5 Revocation

- Revoke client devices.
- Revoke host grants.
- Revoke workspace grants.
- Stop new sensitive operations when revocation is observed.
- Let daemon enforce local revocation policy even if relay state is stale.

## Phase 3: Relay Reliability

### 3.1 Durable Object Routing Shard

- Use an account-level routing shard first.
- Track daemon WebSockets by `hostId`.
- Track client WebSockets.
- Track pending authorization connections.
- Track connection binding state.

### 3.2 Presence

- Publish daemon online/offline state.
- Add heartbeat.
- Clean up stale sockets.
- Expose lightweight host presence to authorization UI.

### 3.3 Reconnect

- Support client short reconnects for the same `connectionId`.
- Keep bound client routes in Durable Object memory for
  `ACP_RELAY_CLIENT_RECONNECT_GRACE_MS` while the daemon stays online.
- Expire disconnected client routes from the shard alarm and notify the daemon.
- Support daemon short reconnects for the same `hostId`.
- Keep bound clients open for `ACP_RELAY_DAEMON_RECONNECT_GRACE_MS`, then replay
  route `Hello` frames when the daemon reconnects.
- Expire daemon reconnect grace from the shard alarm and close affected clients.
- Resume pending authorization where possible.

### 3.4 Backpressure

- Add frame sequence and ack handling.
- Add send queues.
- Limit buffered frames.
- Reject or defer large payloads.
- Keep future artifact/blob traffic off the ACP control path.

### 3.5 Observability

- Log connection lifecycle metadata.
- Log auth, ticket, routing, and close reasons.
- Do not log prompt, file, terminal, image, or browser payloads.
- Add relay metrics for active hosts, clients, bindings, and reconnects.

## Phase 4: Daemon Productization

### 4.1 Daemon CLI

- Add `acp-runtime daemon start`.
- Add `acp-runtime daemon login`.
- Add `acp-runtime daemon status`.
- Add `acp-runtime daemon logout`.
- Keep daemon commands separate from existing runtime examples.

### 4.2 Host Binding

- Bind daemon to account.
- Register host public key.
- Set host alias.
- Configure workspace allowlist.
- Support host unbind and key rotation.

### 4.3 Runtime Session Registry

- Map remote `session/list` to local runtime/session registry.
- Support remote `session/load`.
- Support remote `session/resume`.
- Preserve local snapshot and registry semantics.
- Sync only lightweight metadata to the control plane when needed.

### 4.4 Local Policy

- Enforce workspace path allowlists.
- Enforce agent allowlists.
- Add file, terminal, browser, and port policy gates.
- Add step-up requirements for high-risk operations.
- Keep daemon as final execution enforcement point.

### 4.5 Failure Cleanup

- Dispose agent processes on remote session creation failures.
- Close remote connections when daemon disconnects.
- Cancel or safely finish active turns on connection loss.
- Keep cleanup targeted to current-run resources.

## Phase 5: Native ACP Compatibility Completion

### 5.1 ACP Auth Compatibility

- Add browser login auth method.
- Add device-code auth method.
- Put login URL, device code, and connection id in standard fields or `_meta`.
- Return clear errors for clients that cannot display browser/device-code
  instructions.

### 5.2 ACP Method Coverage

- Support `session/list`.
- Support `session/load`.
- Support `session/resume`.
- Support `session/close`.
- Support `session/set_mode`.
- Support `session/set_config_option`.

### 5.3 Capability Mapping

- Map ACP client filesystem capability.
- Map ACP client terminal capability.
- Map prompt image/audio/resource capability.
- Map authentication capability.
- Avoid leaking agent-specific quirks into relay; keep profiles in runtime.

### 5.4 Compatibility Tests

- Add SDK in-memory ACP client tests.
- Add WebSocket ACP client tests.
- Add simulator-backed daemon tests.
- Add permission/file/terminal smoke cases.

### 5.5 Harness Integration

- Add remote admission gate.
- Add remote simulator matrix.
- Add relay disconnect scenarios.
- Add daemon reconnect scenarios.
- Keep generated output under temporary output directories.

## Phase 6: First-party Client Foundation

### 6.1 Account UI

- Implement login.
- Register client device.
- Show device list.
- Support device revoke.

### 6.2 Host and Workspace UI

- Show host list.
- Show host online/offline state.
- Select workspace.
- Set default host/workspace.
- Show recent sessions.

### 6.3 ACP Channel

- Request connection ticket directly.
- Open ACP channel to relay.
- Renew ticket automatically.
- Stream runtime events.
- Handle reconnect and re-auth prompts.

### 6.4 Permission UI

- Render permission prompts.
- Support allow once and allow for session.
- Add step-up for terminal, file write, port forward, and browser control.
- Show daemon/local policy denials.

### 6.5 Session UI

- Create session.
- Send prompt.
- Stream updates.
- Cancel turn.
- List/load/resume sessions.

## Phase 7: Remote IDE Channels

### 7.1 Filesystem Channel

- Add file tree.
- Add file read/write.
- Add diff view.
- Add file watch.
- Add upload/download.

### 7.2 Terminal Channel

- Add PTY start.
- Stream terminal output.
- Send terminal input.
- Resize terminal.
- Kill and release terminals.
- Record audit metadata without recording terminal payload by default.

### 7.3 Artifact Channel

- Support image, log, and blob artifacts.
- Add chunking.
- Add encrypted blob option.
- Prefer daemon/client storage over relay storage.

### 7.4 Port Channel

- Add local preview server forwarding.
- Support HTTP and WebSocket proxying.
- Add per-port grants.
- Add private/public preview policy.

### 7.5 Browser Channel

- Add local browser or CDP control.
- Add screenshot stream.
- Add click/type/navigation commands.
- Keep cloud browser as optional future backend.

## Phase 8: Security Hardening

### 8.1 End-to-end Encryption

- Encrypt client-daemon payloads.
- Let relay see only routing metadata where possible.
- Add key rotation.
- Add recovery and rekey flows.

### 8.2 Passkey and OIDC

- Add passkey login.
- Add GitHub/OIDC login.
- Reserve organization SSO.
- Keep account identity separate from daemon execution grants.

### 8.3 Risk Controls

- Detect unusual device or location signals.
- Trigger step-up for risky operations.
- Detect token replay.
- Rate limit repeated auth failures.

### 8.4 Audit

- Audit grant changes.
- Audit host binding and unbinding.
- Audit high-risk operation decisions.
- Keep audit logs metadata-only by default.

### 8.5 Secrets

- Prevent secrets in relay logs.
- Redact sensitive metadata.
- Keep daemon-local secrets local.
- Avoid persisting agent credentials in relay/control plane.

## Phase 9: Deployment and Operations

### 9.1 Cloudflare

- Deploy Worker.
- Deploy Durable Objects.
- Add D1/KV metadata stores.
- Add staging and production environments.
- Configure environment-specific secrets and keys.

### 9.2 VPS and Self-host

- Implement the same relay contracts.
- Add Postgres or SQLite adapter.
- Add WebSocket broker.
- Add Docker deployment.
- Keep self-hosted behavior compatible with Cloudflare behavior.

### 9.3 CI/CD

- Add relay-worker typecheck.
- Add relay-worker tests.
- Add remote integration tests.
- Add deployment workflow.
- Keep root checks deterministic and account-free.

### 9.4 Observability

- Add metrics.
- Add traces.
- Add error dashboards.
- Add session diagnostics without payload content.
- Add daemon and relay correlation ids.

### 9.5 Quotas

- Limit connections per account.
- Limit hosts per account.
- Limit bandwidth.
- Add rate limits.
- Add abuse controls.

## Phase 10: Release and Package Split

### 10.1 Stabilize Internal APIs

- Stabilize remote protocol types.
- Stabilize daemon facade.
- Stabilize ticket issuer/verifier.
- Stabilize relay contracts.

### 10.2 Split Packages

- Keep `@saaskit-dev/acp-runtime` as the core local runtime package.
- Extract `@saaskit-dev/acp-remote-protocol`.
- Extract `@saaskit-dev/acp-runtime-daemon`.
- Keep `@saaskit-dev/acp-relay-worker` as the Cloudflare worker package.
- Add `@saaskit-dev/acp-remote-client` after first-party client APIs stabilize.

### 10.3 Public Docs

- Add remote setup guide.
- Add daemon setup guide.
- Add native ACP client compatibility guide.
- Add security model guide.
- Add Cloudflare deploy guide.

### 10.4 Versioning

- Version remote protocol.
- Define migration policy.
- Maintain compatibility matrix.
- Document supported ACP protocol versions.

## Current Implementation Checkpoint

- Active implementation scope is locked to the native ACP client path. Do not
  implement first-party IDE clients, `src/runtime/remote/client`,
  `examples/remote`, or remote IDE channel UI in this slice.
- `src/runtime/remote/protocol` defines versioned remote frames and a WebSocket
  JSON-RPC stream adapter.
- `packages/relay-worker` exposes `/acp`, `/client`, `/daemon`, `/authorize`,
  and `/renew`.
- `packages/relay-worker` includes Cloudflare deployment entrypoints, Wrangler
  scripts, and a D1 migration under `packages/relay-worker/migrations`.
- The relay uses an account-level routing shard, not a user-facing room.
- Unbound native ACP clients receive a bootstrap ACP auth method from `/acp`.
- `packages/relay-worker` has a lightweight control-plane store interface and an
  in-memory implementation for accounts, client devices, hosts, and grants.
- `packages/relay-worker` also has a writable D1-backed control-plane store
  adapter and a D1 schema in `packages/relay-worker/schema.sql`.
- The Worker exposes formal control-plane mutation endpoints for relationship
  metadata: `/control-plane/accounts`, `/control-plane/client-devices`,
  `/control-plane/hosts`, and `/control-plane/grants`. These endpoints require
  `ACP_RELAY_CONTROL_PLANE_SECRET`, write only relationship metadata, and trigger
  route authorization reconciliation after mutations.
- Native ACP `/authorize` is protected by product account sessions. The Worker
  requires `ACP_RELAY_ACCOUNT_SESSION_SECRET` and accepts a signed account
  session from `Authorization: Bearer`, `x-acp-account-session`, or the
  `acp_relay_session` cookie before routing the authorization UI to an account
  shard.
- When `ACP_RELAY_LOGIN_URL` is configured, unauthenticated native `/authorize`
  requests redirect to the product login page with `returnTo` and `accountId`.
  Without it, the Worker renders a minimal sign-in-required page.
- `/authorize` can bind `connectionId -> hostId` only when an active grant allows
  the account/client device to access that host, and the relay signs a short-lived
  connection ticket for the daemon.
- When binding a native ACP route, the relay sends a remote `Hello` plus an
  internal daemon-side `initialize` request. The internal response is swallowed so
  native ACP clients do not see relay bootstrap implementation details.
- Before forwarding bound native ACP traffic, the relay re-checks account/client
  device/host grants and method scopes. If the connection grant is revoked, the
  relay stops the daemon route before forwarding new ACP payloads.
- Native ACP ticket renewal is explicit: a bound native ACP client calls the
  relay auth method again, the relay re-checks grants, sends remote `Renew` to
  the daemon, and returns the renewed ticket metadata. Regular ACP traffic no
  longer performs opportunistic ticket renewal.
- First-party clients can renew with `/renew` by signing account id, client
  device id, connection id, host id, current ticket JTI, timestamp, and nonce
  with the registered client-device Ed25519 key. The relay re-checks device
  status and grants, issues a new ticket, and propagates `Renew` to the daemon.
- `/daemon` requires a registered host public key. Daemon shared-secret
  registration has been removed from the runtime path.
- Registered hosts can now carry `publicKey` and `previousPublicKey` in D1. When
  present, `/daemon` verifies the registration proof with the host current or
  previous public key instead of the shared bootstrap secret, enabling staged
  host key rotation.
- `src/runtime/remote/daemon` now also provides host identity primitives for
  daemon-side keypair provisioning: persistent local identity files, key
  rotation with `previousPublicKey`, and relay registration header generation
  using Ed25519 signatures.
- `src/runtime/remote/daemon` can also produce the account/host/public-key
  registration record expected by the relay control plane.
- The runtime now also exposes a transport-agnostic daemon relay connector that
  loads persistent host identity, builds `/daemon` registration headers, and
  hands URL plus headers to an injected WebSocket factory.
- The daemon connector also has a CLI/env config parser for `--account-id`,
  `--host-id`, `--relay-url`, and `--identity-path`, so product CLIs can wire the
  real WebSocket implementation into the same connector path without adding a
  local proxy.
- Host-key registration is the only daemon registration path.
- `src/runtime/remote/daemon` creates `AgentSideConnection` instances from relay
  ACP frames after validating the connection ticket. Ticket verification keys are
  required by the daemon connection API.
- Daemon-side ACP method dispatch enforces ticket scopes for session creation,
  session listing, session resume/load/fork/close, mode/config changes, prompt
  turns, and turn cancellation.
- The daemon runtime facade supports `workspaceRoots`; when configured, remote
  `session/new`, `session/list`, `session/load`, and `session/resume` must use a
  `cwd` inside an allowed local workspace root before touching `AcpRuntime`.
  Workspace roots can now come from the signed connection ticket, so
  control-plane grants can scope a connection without relying only on process
  options.
- Relay routing now keeps bound native ACP client routes during short client
  reconnects and keeps clients open during short daemon reconnects. The shard
  uses `ACP_RELAY_CLIENT_RECONNECT_GRACE_MS` and
  `ACP_RELAY_DAEMON_RECONNECT_GRACE_MS`; daemon reconnect replays route `Hello`
  frames for existing bindings.
- Relay and daemon transport now exchange remote `Ack` frames for ACP and future
  remote IDE channels. The relay keeps bounded pending data-frame queues, replays
  unacked daemon-bound frames after daemon reconnect, buffers daemon-to-client
  frames during client reconnect grace, and applies channel scopes for `fs`,
  `terminal`, `browser`, `port`, `artifact`, and `logs` frames.
  `ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION` controls the per-route in-memory
  frame limit on the relay.
- Control-plane mutations trigger shard-local authorization
  reconciliation, so account/device/host/grant revocations proactively close
  existing bound native ACP routes instead of waiting for the next ACP request.
- Relay cleanup still closes and removes bound native ACP client routes when
  reconnect grace expires or a daemon sends a remote `Close` frame.
- Remote frame heartbeat is implemented at the protocol edge: daemon connections
  answer `Ping` with `Pong`, and the relay broker can ping daemon sockets,
  record matching pongs, and close heartbeat-stale daemon routes.
- The Cloudflare Durable Object shard can schedule those heartbeat checks via
  alarm using `ACP_RELAY_HEARTBEAT_INTERVAL_MS` and
  `ACP_RELAY_HEARTBEAT_TIMEOUT_MS`.
- The current Worker smoke covers native ACP client JSON-RPC through Worker
  routing, Durable Object routing, daemon connection, and simulator-backed local
  runtime.

## Immediate Next Work

The active 1-4 native ACP implementation slice is now represented in code:

1. WebSocket ACP stream adapter.
2. Relay `/acp` accepts native ACP JSON-RPC.
3. Daemon `/daemon` receives relay frames and creates `AgentSideConnection`.
4. Worker/Durable Object smoke drives native ACP `initialize`, `authenticate`,
   `session/new`, and `session/prompt` against the simulator agent.

Next implementation work should stay native ACP only until this path is
deployment-ready: real login-provider integration for `/authorize`, daemon CLI
packaging, Cloudflare staging deployment, and native ACP compatibility smoke.
First-party IDE client work remains explicitly paused.
