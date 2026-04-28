# RFC-0006: Remote ACP Runtime Relay

Language:
- English (default)
- [简体中文](../zh-CN/rfcs/0006-remote-acp-runtime-relay.md)

## Summary

This RFC defines the target direction for turning `acp-runtime` from a
local-first runtime into a remote-capable runtime infrastructure. The design
prioritizes first-party web, desktop, and mobile clients while preserving a
standards-compatible ACP entry point for native ACP clients as a first-class
compatibility feature.

The core principle is:

> The account control plane provides convenience and grants, the relay forwards
> lightweight online traffic, and the host daemon remains the execution and
> local enforcement authority.

## Goals

- Support one account managing many host daemons and many client devices.
- Prioritize first-party clients for host, workspace, session, and future
  remote IDE workflows.
- Preserve a native ACP client path through standard ACP authentication and
  session methods.
- Keep relay/content storage boundaries clear: store relationships and grants,
  not prompts, files, terminal output, images, browser streams, or transcripts.
- Make Cloudflare Workers and Durable Objects the preferred initial deployment
  target while keeping VPS and self-hosted relay backends replaceable.
- Design transport, identity, security, and authorization foundations that can
  later support file, terminal, port, browser, artifact, and log channels.

## Non-goals

- Do not require users to run a local client-side proxy for first-party web or
  mobile use.
- Do not make native ACP clients understand account, host, workspace, or device
  management UI.
- Do not make the relay the final workspace authority.
- Do not store sensitive content or runtime transcripts in the relay/control
  plane by default.
- Do not force remote IDE features into the ACP protocol surface.

## Current Implementation Scope

The active implementation slice is intentionally native ACP only:

- `/acp` accepts native ACP JSON-RPC over WebSocket.
- `/authorize` performs browser account authorization and host selection.
- `/daemon` connects the host daemon and creates daemon-side ACP connections.
- Relay/account metadata is limited to relationships, keys, grants, tickets,
  presence, and revocation state.
- Worker/Durable Object smoke validates native ACP `initialize`, `authenticate`,
  `session/new`, and `session/prompt` against the simulator agent.

First-party IDE clients, `remote/client`, `examples/remote`, and remote IDE UI
are explicitly paused until the native ACP path is deployment-ready.

## Architecture

```text
First-party Client / Native ACP Client
        |
        | HTTPS / WebSocket / ACP over WebSocket
        v
Relay URL
        |
        +-- Account Control Plane
        |     login, devices, hosts, grants, tickets
        |
        +-- Relay Data Plane
              online routing, websocket broker, heartbeat, rate limits
        |
        v
Host Daemon
        |
        +-- AcpRuntime
        +-- local ACP agents
        +-- workspace filesystem
        +-- terminal, port, browser, artifact adapters
        +-- local policy enforcement
```

### First-party clients

First-party clients are the primary product surface. They should own:

- account login and device registration
- multi-host and multi-workspace selection
- runtime session lists and session switching
- connection ticket renewal
- permission and step-up UI
- future remote IDE channels such as files, terminal, ports, browser, and
  artifacts

### Native ACP clients

Native ACP clients are compatibility clients. They should only need ACP:

- connect to the relay ACP endpoint
- call `initialize`
- use ACP `authMethods` and `authenticate`
- use ACP `session/*` methods after authorization

Host and workspace selection for native ACP clients happens in a browser
authorization page, not inside the ACP client.

### Native ACP bootstrap facade

A native ACP client that connects to a single relay URL does not know the target
host yet. The relay/control plane therefore needs a minimal ACP bootstrap
facade for unbound native connections.

The bootstrap facade may handle only:

- `initialize`
- account/host-selection `authMethods`
- `authenticate` for browser or device-code login
- binding the connection to a selected host after authorization

It must not implement normal runtime semantics such as `session/new`,
`session/prompt`, file access, terminal access, or agent-specific compatibility.
After a host is selected, the relay binds the connection to a daemon and forwards
runtime ACP traffic. The relay should pass the original client initialize
metadata/capabilities to the daemon-side ACP facade so the daemon can establish
the actual runtime session context.

### Account control plane

The account control plane owns lightweight durable metadata:

- accounts and identity provider links
- client device public keys
- host daemon public keys
- account-to-host bindings
- client, host, workspace, and channel grants
- default host/workspace preferences
- revocation state and policy versions
- lightweight audit metadata

It must not store:

- prompt contents
- ACP transcripts
- file contents
- terminal output
- images and artifacts
- browser streams
- workspace indexes
- agent private state

### Relay data plane

The relay data plane owns ephemeral online traffic:

- WebSocket entrypoints
- presence and online routing
- routing shards
- heartbeat and disconnect detection
- rate limiting and abuse controls
- forwarding ACP and remote IDE channel frames

It should not make final authorization decisions beyond validating that a
connection ticket is structurally valid and routable.

### Host daemon

The host daemon owns execution:

- connects outbound to the relay
- registers host presence
- syncs policy/grant versions
- validates connection tickets and device identity
- exposes the remote ACP facade
- calls local `AcpRuntime`
- enforces workspace allowlists and local policy
- handles local filesystem, terminal, port, browser, and artifact adapters

The daemon must keep the local-first runtime usable even when the relay is
unavailable.

The initial daemon facade may accept local `workspaceRoots` configuration. When
configured, remote session methods must resolve `cwd` under one of those roots
before calling `AcpRuntime`; later product flows should populate the roots from
host/account workspace configuration.

## Identity Model

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

Users log into accounts. Clients and daemons prove device or host identity with
keypairs. The account control plane maps accounts, clients, hosts, and grants;
the daemon enforces those grants locally before executing runtime actions.

## Authorization Model

Authorization is layered:

```text
account role
  -> client device trust
  -> host grant
  -> workspace grant
  -> channel scope
  -> runtime permission request
  -> daemon local policy
```

Account login alone must not imply unlimited daemon access. A signed-in client
must also present a registered device key and a grant for the target host,
workspace, and channel scopes.

Example scopes:

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

High-risk scopes such as terminal control, file writes, port forwarding, and
browser control should support step-up confirmation and daemon-side local
policy overrides.

## Connection Tickets

Long-lived account sessions are for user convenience. Short-lived connection
tickets are for runtime access.

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

Rules:

- The account control plane signs connection tickets.
- The relay uses tickets to route connections.
- The daemon verifies ticket signature, host id, client device id, scopes,
  policy version, expiration, and connection binding.
- Tickets should be short-lived and automatically renewed.
- Leaked tickets should have limited value because they are scoped, expiring,
  and bound to connection/device context.

## Renewal

Users should not repeatedly log in or re-authorize normal usage. Renewal should
be transport-level and transparent to ACP.

```text
client has account session + device key
 -> ticket approaches expiration
 -> client or transport requests renewal
 -> client signs nonce + connectionId with device key
 -> control plane checks grants and revocation state
 -> control plane signs a new ticket
 -> relay and daemon validate it
 -> ACP connection continues
```

Renewal must not be based on trusting the old ticket alone. Each renewal should
re-check account session validity, device status, host/workspace grants,
revocation state, and policy versions.

Native ACP clients renew explicitly through the relay ACP auth method. The relay
re-checks grants and revocation state, sends a `Renew` frame to the daemon, and
returns updated ticket metadata. First-party clients renew through `/renew` with
a device-key signed proof over the account id, client device id, connection id,
host id, current ticket JTI, timestamp, and nonce.

If renewal fails, the runtime should prefer a graceful failure mode:

- allow a short grace period for transient network issues
- stop new high-risk operations
- allow active turns to finish or cancel when safe
- prompt first-party clients to re-login or re-authorize

## First-party Client Flow

```text
1. User opens web, desktop, or mobile client.
2. Client logs into account.
3. Client registers or restores its clientDeviceId and device key.
4. Client loads hosts, workspaces, and recent sessions.
5. User selects host and workspace.
6. Client requests a connection ticket.
7. Client opens the relay `/client` WebSocket for remote frames, or `/acp` when
   it only needs the ACP channel.
8. Relay routes to the selected online daemon.
9. Daemon validates ticket and local policy.
10. ACP channel starts.
11. Remote IDE channels start on demand.
```

This flow is the primary product experience and may use enhanced APIs outside
ACP for host lists, device management, grants, and remote IDE channels.

First-party client SDK work is intentionally not part of the first
implementation milestone. The early runtime implementation should keep this flow
as the target product direction but prioritize a native ACP client end-to-end
path first.

## Native ACP Client Flow

Native ACP clients should connect to one relay URL and use ACP authentication:

```text
1. Native ACP client connects to wss://relay.example.com/acp.
2. Client calls initialize.
3. Relay bootstrap facade exposes an ACP auth method such as browser-login.
4. Client calls authenticate({ methodId: "browser-login" }).
5. User opens the browser URL or device code page.
6. User logs in, selects host/workspace, and approves the connection.
7. Control plane issues a connection ticket for that ACP connection.
8. Relay binds the connection to the selected daemon.
9. Relay forwards the original initialize context and ticket to the daemon.
10. Daemon validates the ticket and initializes its runtime ACP facade.
11. Client continues with standard ACP session methods.
```

The ACP client does not need multi-host UI. Host and workspace selection happen
out of band in the browser authorization flow.

If a native ACP client cannot display browser/device-code instructions from
standard fields or `_meta`, it may not support this compatibility flow. That
does not affect first-party clients, which use enhanced account APIs before
opening the ACP channel.

## Protocol Layering

ACP remains the agent control plane:

- `initialize`
- `authenticate`
- `session/new`
- `session/list`
- `session/load`
- `session/resume`
- `session/prompt`
- `session/cancel`
- runtime events
- auth and permission forwarding

Remote IDE channels are separate data-plane channels:

- `fs`
- `terminal`
- `port`
- `browser`
- `artifact`
- `logs`

First-party clients can use all channels. Native ACP clients only need the ACP
channel. This keeps ACP compatibility intact while leaving room for a complete
remote IDE.

## Infrastructure Targets

### Cloudflare first

Preferred initial Cloudflare mapping:

- Worker: HTTP/WebSocket entrypoint, auth prechecks, rate limits, dispatch.
- Durable Object: preferably an account-level routing shard first; WebSocket
  broker, host presence, heartbeat, and optional hibernation.
- D1/KV: lightweight control-plane metadata such as accounts, client devices,
  hosts, grants, workspace policy metadata, policy versions, and revocation
  state. The initial D1 schema stores identifiers, scope lists, status flags,
  public keys, and metadata, not ACP or IDE content payloads.

Heartbeat should use remote `Ping`/`Pong` frames on daemon routes. The broker
may expose deterministic heartbeat hooks first, then wire them to Durable Object
alarms or timers for production liveness checks and stale route cleanup.
The Cloudflare Worker package uses `ACP_RELAY_HEARTBEAT_INTERVAL_MS` and
`ACP_RELAY_HEARTBEAT_TIMEOUT_MS` to configure this alarm-driven loop.

The Worker exposes control-plane mutation endpoints for relationship metadata:
`/control-plane/accounts`, `/control-plane/client-devices`,
`/control-plane/hosts`, and `/control-plane/grants`. They are protected by
`ACP_RELAY_CONTROL_PLANE_SECRET`, and product account/session validation should
sit in front of them for user-facing flows.

The native ACP authorization UI is protected by signed account sessions using
`ACP_RELAY_ACCOUNT_SESSION_SECRET`. First-party device renewal uses `/renew` and
the registered client-device public key instead of asking the user to log in for
every ticket refresh.

### Replaceable backends

The implementation should define backend interfaces so Cloudflare, VPS, and
self-hosted deployments can share product logic:

- `AccountStore`
- `DeviceStore`
- `HostStore`
- `GrantStore`
- `TicketIssuer`
- `PresenceRouter`
- `RelayBroker`

VPS/self-hosted deployments may use Postgres, SQLite, Redis, Nginx/Caddy, or a
single relay service as long as they implement the same contracts.

## Security Requirements

- Every client device and host daemon has its own keypair.
- The Cloudflare relay can store host `publicKey` and `previousPublicKey` values
  in D1 and verify `/daemon` registration with either key during staged host key
  rotation. Host key registration is the only daemon registration path.
- Account sessions are not enough to access a daemon.
- Connection tickets are short-lived, scoped, signed, and renewable.
- Daemons verify tickets and enforce local policy.
- Workspace roots may be embedded in signed connection tickets so a daemon can
  enforce per-connection workspace policy before touching local runtime state.
- Relay/control-plane storage excludes sensitive content by default.
- Audit logs record metadata, not sensitive payloads.
- Remote IDE channels use explicit scopes and step-up when necessary.
- Payload end-to-end encryption should remain possible for ACP and remote IDE
  channels so the relay can become content-blind in stricter deployments.

## Phases

### Phase 0: RFC and protocol skeleton

- Define identity, grants, tickets, relay contracts, and channel envelope.
- Keep local runtime behavior unchanged.

### Phase 1: Remote ACP MVP

- Host daemon connects outbound to relay.
- Relay exposes `/acp` over WebSocket.
- Native ACP client uses the relay bootstrap ACP facade.
- Browser auth selects account, host, and workspace for the ACP connection.
- Relay binds the native ACP connection to the selected daemon.
- Daemon validates the ticket and serves the runtime ACP facade.
- Support `initialize`, `authenticate`, `session/new`, `session/prompt`, events,
  and basic cancellation.
- Do not build `examples/remote` in this phase.
- Do not build `remote/client` or first-party client SDK helpers in this phase.
- Validation should use an ACP client-compatible smoke path against the relay
  endpoint.

### Phase 2: Reliability

- Ticket renewal.
- Heartbeats.
- Reconnect and resume.
- Backpressure.
- Revocation propagation.
- Multi-host presence.

### Phase 3: Account and multi-device productization

- Device management UI.
- Host binding and unbinding.
- Grant management.
- Default host and workspace.
- Multi-client web, desktop, mobile, and CLI behavior.

### Phase 4: Remote IDE channels

- Filesystem channel.
- Terminal channel.
- Artifact and image channel.
- Port forwarding.
- Browser control.

### Phase 5: Production hardening

- Cloudflare deployment.
- VPS/self-host adapter.
- Audit and observability.
- Quotas and abuse controls.
- Organization and team policies.
- Optional end-to-end encryption.
- High availability and region routing.

## Implementation Notes

- Keep remote relay code out of examples unless the example is specifically a
  remote runtime example.
- Keep agent-specific ACP behavior in runtime profiles, not the relay.
- Do not require native ACP clients to run a local proxy for the main remote
  WebSocket path.
- If stdio-only ACP clients are supported later, a local proxy may be offered as
  an optional compatibility bridge, not as the primary architecture.
- Preserve the local-first runtime API so hosts can use `AcpRuntime` without any
  relay dependency.
- Initial implementation should focus on `src/runtime/remote/protocol`,
  `src/runtime/remote/daemon`, and `packages/relay-worker`. Defer
  `src/runtime/remote/client` and `examples/remote` until the native ACP client
  path is working end to end.
