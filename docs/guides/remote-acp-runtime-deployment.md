# Remote ACP Runtime Deployment Guide

Language:
- English (default)
- [简体中文](../zh-CN/guides/remote-acp-runtime-deployment.md)

This guide covers the current native ACP client deployment slice only:

```text
Native ACP Client -> /acp -> /authorize -> /daemon -> AcpRuntime
```

First-party IDE clients, `remote/client`, and remote IDE channels are not part of
this deployment path yet.

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
wrangler secret put ACP_RELAY_TICKET_SECRET
wrangler secret put ACP_RELAY_ACCOUNT_SESSION_SECRET
```

5. Optionally configure `ACP_RELAY_LOGIN_URL` as a Worker variable. When set,
   unauthenticated `/authorize` requests redirect to this login URL with
   `returnTo` and `accountId` query parameters. When unset, `/authorize` renders
   a minimal sign-in-required page.
6. Deploy:

```bash
pnpm --filter @saaskit-dev/acp-relay-worker deploy
```

## Control Plane Records

The relay stores relationship metadata only. Provision records through the
control-plane endpoints, protected by `ACP_RELAY_CONTROL_PLANE_SECRET`:

- `/control-plane/accounts`
- `/control-plane/client-devices`
- `/control-plane/hosts`
- `/control-plane/grants`

Provision in this order:

1. Account record.
2. Native ACP client metadata record with `clientDeviceId:
   "native-acp-client"`. The current native ACP path uses browser account
   authorization, so this public key is metadata and can be a placeholder until
   native device-key registration exists.
3. Host record with the daemon host public key.
4. Grant record with `acp:connect` plus the required ACP scopes, and optional
   `workspaceRoots`.

## Daemon Registration

The daemon is the final execution authority. It must:

- Load or create a persistent host identity.
- Register the host public key in the relay control plane.
- Connect outbound to `/daemon?accountId=<account>&hostId=<host>`.
- Sign daemon registration headers with the host private key.
- Verify relay connection tickets before creating `AgentSideConnection`.
- Enforce `workspaceRoots` before calling local `AcpRuntime`.

`src/runtime/remote/daemon` provides the identity, header-generation, CLI/env
config parser, and relay connector primitives for this path.

## Native ACP Client Flow

1. Native ACP client opens `wss://<relay>/acp?accountId=<account>`.
2. Relay bootstrap handles `initialize` and returns a browser auth method.
3. Client calls `authenticate`.
4. User opens `/authorize`, signs in, and selects an online host.
5. Relay validates the account session, grant, host, and scopes.
6. Relay signs a short-lived ticket and binds the ACP connection to the daemon.
7. Daemon creates `AgentSideConnection` and serves normal ACP session methods.

## Validation

Run focused checks before deploying:

```bash
pnpm --filter @saaskit-dev/acp-relay-worker typecheck
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run packages/relay-worker/src/index.test.ts packages/relay-worker/src/native-acp-worker-smoke.test.ts src/runtime/remote/daemon/host-identity.test.ts
```

The Worker smoke covers native ACP `initialize`, `authenticate`, `session/new`,
and `session/prompt` through Worker routing, Durable Object routing, daemon
connection, and the simulator-backed local runtime.
