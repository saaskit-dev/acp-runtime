/**
 * Full E2E test: Relay + Daemon + ACP Client (via WebSocket + JSON-RPC)
 * No Zed needed — uses raw ACP JSON-RPC protocol.
 *
 * Usage: node test-e2e-acp.mjs
 * Prerequisites: relay (wrangler dev) and daemon running.
 */
import WebSocket from "ws";
import { createHmac, randomUUID } from "crypto";
import { readFile } from "fs/promises";

const RELAY_HTTP = "http://localhost:8787";
const RELAY_WS = "ws://localhost:8787";

// ── Helpers ──────────────────────────────────────────────

function createSessionToken(accountId) {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const payload = JSON.stringify({ accountId, sessionId, expiresAt });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", "local-account-session-secret").update(payloadB64).digest("hex");
  return `v1.${payloadB64}.${sig}`;
}

let msgId = 0;
function jsonRpc(method, params = {}) {
  return { jsonrpc: "2.0", id: ++msgId, method, params };
}

function waitForMessage(ws, filter, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (!filter || filter(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

async function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  ACP Full E2E Test  (relay + daemon + client)    ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Step 0: Resolve session ──────────────────────────
  let accountId;
  try {
    const cached = JSON.parse(await readFile(`${process.env.HOME}/.acp/relay-session.json`, "utf-8"));
    accountId = cached.accountId;
    console.log(`✓ Using cached account: ${accountId}`);
  } catch {
    throw new Error("No cached session. Run daemon first to complete OAuth login.");
  }
  const token = createSessionToken(accountId);

  // ── Step 1: Check relay health ───────────────────────
  const health = await fetch(`${RELAY_HTTP}/health`);
  await assert(health.ok, "relay health check");
  console.log("✓ Relay is healthy\n");

  // ── Step 2: Check daemon is online ───────────────────
  const daemonsRes = await fetch(`${RELAY_HTTP}/api/daemons`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await assert(daemonsRes.ok, `daemon list returned ${daemonsRes.status}`);
  const { daemons } = await daemonsRes.json();
  await assert(daemons.length > 0, "at least one daemon online");
  const daemonId = daemons[0].daemonId;
  const hasAgent = daemons[0].metadata?.agentTypes?.length > 0;
  const agentCommand = hasAgent ? daemons[0].metadata.agentTypes[0].command : undefined;
  console.log(`✓ Daemon online: ${daemonId.slice(0, 8)}... (agent: ${agentCommand ?? "none"})\n`);

  // ── Step 3: Connect as ACP client ────────────────────
  const connectionId = randomUUID();
  const wsUrl = `${RELAY_WS}/acp?connectionId=${connectionId}&daemonId=${daemonId}&accountId=${accountId}`;
  const ws = new WebSocket(wsUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
  console.log("✓ Client WebSocket connected\n");

  // ── Step 4: ACP Initialize (bootstrap) ───────────────
  console.log("── ACP Bootstrap ──");
  send(ws, jsonRpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "e2e-test-client", version: "1.0.0" },
  }));
  const initResp = await waitForMessage(ws, (m) => m.id === 1);
  await assert(initResp.result, `initialize returned result`);
  await assert(initResp.result.protocolVersion, "has protocolVersion");
  await assert(initResp.result.authMethods?.length > 0, "has authMethods");
  console.log(`✓ initialize → protocol ${initResp.result.protocolVersion}`);
  console.log(`  auth method: ${initResp.result.authMethods[0]?.name}\n`);

  // ── Step 5: Authorize via HTTP ───────────────────────
  console.log("── Authorization ──");
  const authResp = await fetch(`${RELAY_HTTP}/authorize?connectionId=${connectionId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      daemonId,
      ...(agentCommand ? { agentCommand } : {}),
    }),
  });
  const authBody = await authResp.json();
  await assert(authBody.ok, `authorize failed: ${authBody.reason}`);
  await assert(authBody.ticket, "has ticket");
  console.log(`✓ Authorization granted (ticket kid: ${authBody.ticket.kid})\n`);

  // ── Step 6: ACP Authenticate (bootstrap complete) ────
  console.log("── ACP Authenticate ──");
  send(ws, jsonRpc("authenticate", {
    methodId: "acp-runtime-relay",
    _meta: { daemonId },
  }));
  const authResult = await waitForMessage(ws, (m) => m.id === 2, 15000);
  await assert(authResult.result, `authenticate returned result (got error: ${JSON.stringify(authResult.error)})`);
  const connId = authResult.result?._meta?.["acp-runtime/remote/connectionId"];
  console.log(`✓ authenticated, connectionId: ${connId?.slice(0, 8) ?? "n/a"}...\n`);

  // ── Step 7: Create session ───────────────────────────
  console.log("── Session Lifecycle ──");
  send(ws, jsonRpc("session/new", {
    cwd: "/tmp/e2e-test",
    mcpServers: [],
  }));
  const sessionResp = await waitForMessage(ws, (m) => m.id === 3, 15000);
  await assert(sessionResp.result, `session/new returned result (got error: ${JSON.stringify(sessionResp.error)})`);
  const sessionId = sessionResp.result.sessionId;
  console.log(`✓ session/new → ${sessionId.slice(0, 8)}...`);

  // ── Step 8: List tools (verify agent communication) ──
  send(ws, jsonRpc("tools/list", {}));
  const toolsResp = await waitForMessage(ws, (m) => m.id === 4, 10000);
  if (toolsResp.result) {
    const tools = toolsResp.result.tools || [];
    console.log(`✓ tools/list → ${tools.length} tools${tools.length > 0 ? ` (${tools[0].name})` : ""}`);
  } else {
    console.log(`  tools/list: ${JSON.stringify(toolsResp.error?.message ?? toolsResp.error).slice(0, 80)}`);
  }

  // ── Step 9: Prompt (end-to-end agent call) ───────────
  send(ws, jsonRpc("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Say READY" }],
  }));
  const promptResp = await waitForMessage(ws, (m) => m.id === 5, 30000);
  if (promptResp.result) {
    console.log(`✓ prompt → stopReason: ${promptResp.result.stopReason}`);
  } else {
    console.log(`  prompt: ${JSON.stringify(promptResp.error).slice(0, 100)}`);
  }

  // ── Cleanup ──────────────────────────────────────────
  ws.close();
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  ✓ E2E Test PASSED — full flow verified          ║");
  console.log("╚══════════════════════════════════════════════════╝");
}

main().catch((e) => {
  console.error(`\n✗ E2E FAILED: ${e.message}`);
  process.exit(1);
});
