#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";

const DEFAULT_RELAY_URL = "https://relay.saaskit.app";
const relayUrl = process.env.ACP_RELAY_HTTP_URL ?? DEFAULT_RELAY_URL;
const clientId = process.env.ACP_CLIENT_ID ?? `remote-smoke-${Date.now()}`;
const connectionId =
  process.env.ACP_CONNECTION_ID ?? `remote-smoke-${crypto.randomUUID()}`;
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const agentId = process.env.AGENT_ID;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);

const session = await loadSession();
await checkHealth();
const daemons = await listDaemons(session.token);
const daemon = resolveDaemon(daemons);
await runNativeAcpSmoke({ daemon, token: session.token });

console.log(
  JSON.stringify(
    {
      connectionId,
      daemonId: daemon.daemonId,
      ok: true,
      relayUrl,
      workspaceRoot,
    },
    null,
    2,
  ),
);

async function loadSession() {
  const raw = await readFile(join(homedir(), ".acp", "relay-session.json"), "utf8");
  const session = JSON.parse(raw);
  if (!session?.token || !session?.accountId) {
    throw new Error("Missing ~/.acp/relay-session.json. Run `acp-runtime daemon install` first.");
  }
  return session;
}

async function checkHealth() {
  const response = await fetch(new URL("/health", relayUrl));
  if (!response.ok) {
    throw new Error(`Relay health check failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (body?.ok !== true) {
    throw new Error("Relay health check did not return ok=true.");
  }
}

async function listDaemons(token) {
  const response = await fetch(new URL("/api/daemons", relayUrl), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Daemon discovery failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  return Array.isArray(body?.daemons) ? body.daemons : [];
}

function resolveDaemon(daemons) {
  const daemonId = process.env.DAEMON_ID;
  const daemon = daemonId
    ? daemons.find((entry) => entry?.daemonId === daemonId)
    : daemons[0];
  if (!daemon?.daemonId) {
    throw new Error("No online daemon found. Start it with `acp-runtime daemon start`.");
  }
  return daemon;
}

async function runNativeAcpSmoke({ daemon, token }) {
  const url = new URL("/acp", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("connectionId", connectionId);

  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  await onceOpen(socket);
  const initialize = request(socket, pending, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      clientCapabilities: {},
      protocolVersion: 1,
    },
  });
  const initializeResult = await withTimeout(initialize, timeoutMs, "initialize");
  if (initializeResult.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initializeResult.error)}`);
  }

  const sessionNew = request(socket, pending, {
    id: 2,
    jsonrpc: "2.0",
    method: "session/new",
    params: {
      cwd: workspaceRoot,
      mcpServers: [],
    },
  });
  await authorize({ daemon, token });
  const sessionResult = await withTimeout(sessionNew, timeoutMs, "session/new");
  if (sessionResult.error) {
    throw new Error(`session/new failed: ${JSON.stringify(sessionResult.error)}`);
  }
  const sessionId = sessionResult.result?.sessionId;
  if (!sessionId) {
    throw new Error(`session/new returned no sessionId: ${JSON.stringify(sessionResult)}`);
  }
  await withTimeout(
    request(socket, pending, {
      id: 3,
      jsonrpc: "2.0",
      method: "session/close",
      params: { sessionId },
    }),
    timeoutMs,
    "session/close",
  ).catch(() => undefined);
  socket.close(1000, "remote smoke completed");
}

async function authorize({ daemon, token }) {
  const response = await fetch(new URL(`/authorize?connectionId=${connectionId}`, relayUrl), {
    body: JSON.stringify({
      agentId: agentId ?? daemon.metadata?.agentTypes?.[0]?.id,
      daemonId: daemon.daemonId,
      workspaceRoots: [workspaceRoot],
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Authorization failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (body?.ok !== true) {
    throw new Error(`Authorization failed: ${JSON.stringify(body)}`);
  }
}

function request(socket, pending, message) {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    socket.send(JSON.stringify(message));
  });
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
