---
name: acp-runtime-log-triage
description: Use this skill whenever the user asks to debug, inspect, search, explain, or correlate acp-runtime logs, relay logs, bridge logs, daemon logs, runtime CLI logs, Cloudflare logs, traceId/sessionId issues, missing remote sessions, auth failures, daemon disconnects, timeouts, or "全链路日志". This skill gives the project-specific log locations, IDs, filters, and troubleshooting playbooks for acp-runtime.
---

# acp-runtime Log Triage

Use this skill to diagnose `acp-runtime` behavior from logs before changing code. The goal is to reconstruct the path of one request or session across:

```text
client/native ACP or stdio bridge -> relay Worker/Durable Object -> daemon -> runtime -> local ACP agent
```

Prefer concrete evidence: exact `traceId`, `sessionId`, `connectionId`, `jsonRpcId`, method, timestamp, and source.

## First Response

When the user asks to investigate a problem:

1. Ask for or infer the narrowest identifier available.
2. If they gave no ID, start from local errors and latest logs.
3. State which log surfaces you will inspect.
4. Do not claim a root cause until bridge, relay, daemon, and runtime evidence agree.

High-signal opening questions when needed:

- "有 `traceId`、`sessionId`、`connectionId` 或大概时间吗？"
- "这是本地 runtime CLI、stdio bridge，还是 remote daemon/relay 链路？"
- "问题发生在 `session/new`、`session/load`、`session/prompt`、auth，还是 daemon 连接阶段？"

Do not block on questions if local logs are available. Start with recent errors.

## Key IDs

Use these IDs in this order:

- `traceId`: best cross-process request/response correlation key. It should appear in bridge uploaded logs, relay `acp.relay.transport`, daemon logs, and daemon runtime spans.
- `sessionId`: best session-scoped key after a session exists. `session/new` request has no `sessionId` until the response.
- `connectionId`: relay route between one client connection and daemon.
- `daemonId`: host daemon selected for execution.
- `clientId`: client device or bridge identity.
- `jsonRpcId`: one ACP request/response pair inside a connection.
- `method`: ACP method such as `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/close`.
- `turnId`: prompt/turn-level runtime key when available.
- `uploadId`: low-level log upload batch diagnostic only. Do not use it as the primary troubleshooting key.

Important trace behavior:

- stdio bridge injects W3C `_meta.traceparent` into outbound ACP requests when absent.
- relay logs traced frame forwarding as `eventName: "acp.relay.transport"`.
- daemon reads the same trace metadata and logs top-level `traceId` / `spanId`.
- daemon runtime facade restores trace metadata as OTel parent context for session start/load/resume/list/fork spans.

## Local Log Map

Default runtime home is `~/.acp-runtime`.

Runtime CLI:

- `~/.acp-runtime/logs/runtime.log`
- `~/.acp-runtime/logs/runtime.log.jsonl`
- `~/.acp-runtime/logs/runtime.log.text.jsonl`
- `~/.acp-runtime/logs/runtime.log.events.jsonl` (derived event view)
- `~/.acp-runtime/logs/runtime.log.spans.jsonl` (derived span view)
- `~/.acp-runtime/logs/runtime.log.errors.jsonl` (derived warning/error view)

Runtime CLI session mirror:

- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log`
- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log.text.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log.events.jsonl` (derived event mirror)
- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log.spans.jsonl` (derived span mirror)
- `~/.acp-runtime/logs/sessions/<sessionId>/runtime.log.errors.jsonl` (derived warning/error mirror)

stdio bridge:

- `~/.acp-runtime/bridge.log`
- `~/.acp-runtime/bridge.log.text.jsonl`
- `~/.acp-runtime/bridge.log.errors.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/bridge.log.text.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/bridge.log.errors.jsonl`

daemon:

- `~/.acp-runtime/logs/daemon.out.log`
- `~/.acp-runtime/logs/daemon.err.log`
- `~/.acp-runtime/logs/daemon.log.text.jsonl`
- `~/.acp-runtime/logs/daemon.log.errors.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/daemon.log.text.jsonl`
- `~/.acp-runtime/logs/sessions/<sessionId>/daemon.log.errors.jsonl`

Overrides:

- `ACP_RUNTIME_HOME_DIR`
- `ACP_RUNTIME_CACHE_DIR`
- runtime CLI `--log-file`

## Local Commands

Use `rg` first. Use `jq` only if available.

Recent errors:

```bash
rg -n '"severityText":"ERROR"|error|failed|timeout|denied|missing|closed' ~/.acp-runtime/logs ~/.acp-runtime/bridge.log* 2>/dev/null
```

Find by `traceId`:

```bash
rg -n '<traceId>' ~/.acp-runtime ~/.acp-runtime/logs 2>/dev/null
```

Find by `sessionId`:

```bash
rg -n '<sessionId>' ~/.acp-runtime/logs/sessions ~/.acp-runtime/bridge.log* ~/.acp-runtime/logs/daemon.log.* 2>/dev/null
```

Tail active bridge and daemon logs:

```bash
tail -f ~/.acp-runtime/bridge.log.text.jsonl ~/.acp-runtime/logs/daemon.log.text.jsonl
```

Inspect one session:

```bash
ls -la ~/.acp-runtime/logs/sessions/<sessionId>
rg -n '"severityText":"ERROR"|traceId|sessionId|method|jsonRpcId' ~/.acp-runtime/logs/sessions/<sessionId>
```

Pretty-print JSONL when `jq` exists:

```bash
jq -c '{observedAt,source,severityText,traceId,spanId,sessionId,direction,method,jsonRpcId,body}' ~/.acp-runtime/logs/sessions/<sessionId>/*.jsonl
```

## Cloudflare Logs

Remote upload is enabled by default when the process has both relay URL and account session. Disable only with:

```bash
ACP_RELAY_LOG_UPLOAD=0
```

Useful env:

- `ACP_RELAY_LOG_UPLOAD_URL`
- `ACP_RELAY_LOG_UPLOAD_TOKEN`
- `ACP_RELAY_LOG_UPLOAD_BATCH_SIZE`
- `ACP_RELAY_LOG_UPLOAD_FLUSH_INTERVAL_MS`

Tail relay logs:

```bash
cd packages/relay-worker
wrangler tail acp-relay-worker --format=json
```

Search/filter fields:

- Uploaded local telemetry: `eventName="acp.relay.log"`
- Relay transport forwarding: `eventName="acp.relay.transport"`
- Connection lifecycle: `eventName` beginning with `acp.relay.client.` or `acp.relay.daemon.`
- `traceId`
- `spanId`
- `source`: `runtime-demo`, `bridge`, `daemon`, `relay`
- `record.attributes.acp.session.id` or top-level `sessionId`
- `connectionId`
- `daemonId`
- `clientId`
- `jsonRpcId`
- `method`
- `direction`: `client_to_daemon`, `daemon_to_client`, `client_to_relay`, `relay_to_client`, `relay_to_daemon`, `daemon_to_relay`

Cloudflare examples:

```bash
wrangler tail acp-relay-worker --format=json | rg '<traceId>|acp.relay.transport|acp.relay.log'
```

```bash
wrangler tail acp-relay-worker --format=json | rg '"sessionId":"<sessionId>"|"acp.session.id":"<sessionId>"'
```

If relay uploads are missing, check:

1. Process has account session token.
2. Process has relay URL.
3. `ACP_RELAY_LOG_UPLOAD` is not `0`, `false`, or `off`.
4. Local stderr did not print `Relay log upload failed`.
5. `/api/logs` accepts the account session.

## Triage Playbooks

### No Session Created

Start with `session/new`.

1. Find bridge `client -> relay method=session/new`.
2. Copy its `traceId`.
3. In CF, find `acp.relay.transport` with that `traceId` and `direction=client_to_daemon`.
4. Confirm daemon saw `relay -> daemon method=session/new`.
5. Confirm daemon response `daemon -> relay method=session/new`.
6. If response has `sessionId`, switch to session-scoped logs.
7. If response is error, inspect `body`, `reason`, `requiredScope`, `daemonId`, workspace fields.

Common causes:

- Authorization selection not completed.
- Selected daemon offline.
- Grant lacks `acp:session:create`.
- Selected agent or workspace not advertised by daemon.
- Workspace denied by daemon realpath policy.

### Prompt Hangs Or Times Out

Use `session/prompt`.

1. Search session mirror first.
2. Find `method=session/prompt` and `jsonRpcId`.
3. Correlate `traceId` across bridge, relay, daemon.
4. Check daemon runtime spans/events for turn start, tool calls, permission requests, and completion/failure.
5. Check agent stdio protocol logs if enabled.

Common causes:

- Daemon did not respond before relay timeout.
- Client disconnected before ack.
- Native client ack withheld daemon ack.
- Agent process exited or failed auth.
- Permission request blocked by host/client handler.

### Session Load Or Resume Fails

Use both `sessionId` and `traceId`.

1. Search `~/.acp-runtime/logs/sessions/<sessionId>/`.
2. Search CF for `sessionId`.
3. Check relay session binding restore events around `session/load` or `session/resume`.
4. Confirm daemon selection metadata includes `daemonId`, agent, and workspace roots.
5. Inspect daemon error details.

Common causes:

- Missing remote session binding metadata.
- Binding points to offline daemon.
- Grant no longer allows daemon/agent/workspace.
- Local runtime snapshot missing.
- Runtime load and resume both failed.

### Authentication Or Authorization Failure

Check:

- `authenticate` request/response.
- relay `authUrl`.
- account session validation.
- daemon online state.
- grant scopes.
- selected agent/workspace validation.

Useful strings:

```bash
rg -n 'Authentication required|unsupported relay authentication|host selection|session selection|No active grant|missing scope|authorization' ~/.acp-runtime packages/relay-worker 2>/dev/null
```

### Daemon Offline Or Reconnect

Check relay lifecycle events:

- `acp.relay.daemon.connected`
- `acp.relay.daemon.disconnected`
- `acp.relay.daemon_frame.replay`
- `acp.relay.client.disconnected`
- `acp.relay.client.resumed`
- `acp.relay.client_route.closed`

Then check local daemon:

```bash
rg -n 'Connecting to|Daemon connected|Relay connection closed|Relay connection failed|Retrying|heartbeat' ~/.acp-runtime/logs/daemon* 2>/dev/null
```

Common causes:

- daemon service not running.
- invalid account session.
- daemon identity/signature failure.
- relay ticket verification mismatch.
- heartbeat timeout.
- reconnect grace expired.

### Workspace Denied

Look for:

- `Remote workspace policy denied cwd.`
- `Selected workspace is not advertised by this daemon.`
- `Selected workspace is outside the granted workspace roots.`
- `Workspace root is not allowed.`
- `Workspace path is outside the selected root.`

Compare:

- requested `cwd`
- authorization workspace
- daemon advertised `workspaceRoots`
- grant `workspaceRoots`
- daemon-side realpath result

### Trace Missing Or Broken

Expected:

- bridge outbound request has `_meta.traceparent`.
- bridge local classified log has `traceId`.
- relay has `eventName="acp.relay.transport"` with same `traceId`.
- daemon local classified log has same `traceId`.
- daemon runtime spans inherit same trace for session start/load/resume/list/fork.

If missing:

1. Confirm traffic is going through stdio bridge or a client that propagates `_meta.traceparent`.
2. Check request params are an object; bridge will not inject trace into non-object params.
3. Check local bridge version includes trace injection.
4. Check relay transport log only emits when trace metadata exists.
5. Check daemon logs are from the same time and connection.

## Reading Results

Prefer this final response shape:

```markdown
结论：...

证据：
- traceId=..., sessionId=..., connectionId=...
- bridge: ...
- relay: ...
- daemon: ...
- runtime/agent: ...

判断：
- ...

下一步：
- ...
```

If evidence is incomplete, say exactly which leg is missing:

- client/bridge -> relay
- relay -> daemon
- daemon -> runtime
- runtime -> agent
- daemon -> relay
- relay -> client/bridge

## Safety And Privacy

Logs may contain prompts, tool output, paths, environment-derived details, and error bodies. Do not paste large raw logs into chat. Quote only the small fields needed to prove the diagnosis. Recommend disabling upload or adding redaction before sensitive deployments.
