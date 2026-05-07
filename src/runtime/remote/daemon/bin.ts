#!/usr/bin/env node

import {
  connectAcpRemoteDaemonRelayFromCliConfig,
  parseAcpRemoteDaemonCliConfig,
} from "./daemon-cli.js";
import type { AcpRemoteDaemonDebugContext } from "./relay-connection.js";
import type { DaemonMetadata } from "./relay-client.js";
import { createAcpRemoteWebSocketFactory } from "../shared/index.js";
import type { AcpRemoteWebSocketConstructor } from "../shared/index.js";
import { createStdioAcpConnectionFactory } from "../../acp/stdio-connection.js";
import {
  CLAUDE_CODE_ACP_REGISTRY_ID,
  CODEX_ACP_REGISTRY_ID,
  CURSOR_ACP_REGISTRY_ID,
  GEMINI_CLI_ACP_REGISTRY_ID,
  GITHUB_COPILOT_ACP_REGISTRY_ID,
  OPENCODE_ACP_REGISTRY_ID,
  PI_ACP_REGISTRY_ID,
} from "../../agents/index.js";
import {
  ACP_REMOTE_DEFAULT_TICKET_PUBLIC_KEYS,
  type AcpRemoteTicketVerificationKey,
} from "../protocol/tickets.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";
import {
  loadCachedSession,
  saveSession,
  loginViaOAuth,
  type DaemonSession,
} from "./daemon-login.js";
import { configureAcpRelayTelemetryFromEnv } from "../relay-log-upload.js";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  getAcpRemoteDaemonUserServiceStatus,
  installAcpRemoteDaemonUserService,
  startAcpRemoteDaemonUserService,
  stopAcpRemoteDaemonUserService,
  uninstallAcpRemoteDaemonUserService,
} from "./service.js";

const ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS_ENV_VAR =
  "ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS";
const ACP_REMOTE_DAEMON_ACCOUNT_SESSION_ENV_VAR =
  "ACP_REMOTE_DAEMON_ACCOUNT_SESSION";
const DEFAULT_RECONNECT_MIN_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DAEMON_LOG_DIR = join(homedir(), ".acp-runtime", "logs");
const DAEMON_TEXT_LOG_PATH = join(DAEMON_LOG_DIR, "daemon.log.text.jsonl");
const DAEMON_ERROR_LOG_PATH = join(DAEMON_LOG_DIR, "daemon.log.errors.jsonl");

type DaemonAgentMetadata = DaemonMetadata["agentTypes"][number];

const DEFAULT_REGISTRY_AGENTS: readonly DaemonAgentMetadata[] = [
  { id: CODEX_ACP_REGISTRY_ID, label: "Codex" },
  { id: CLAUDE_CODE_ACP_REGISTRY_ID, label: "Claude Code" },
  { id: OPENCODE_ACP_REGISTRY_ID, label: "OpenCode" },
  { id: GITHUB_COPILOT_ACP_REGISTRY_ID, label: "GitHub Copilot" },
  { id: CURSOR_ACP_REGISTRY_ID, label: "Cursor" },
  { id: GEMINI_CLI_ACP_REGISTRY_ID, label: "Gemini" },
  { id: PI_ACP_REGISTRY_ID, label: "Pi" },
  { id: "qwen-code", label: "Qwen Code" },
];

async function resolveWebSocket(): Promise<AcpRemoteWebSocketConstructor> {
  const ws = await import("ws");
  return ws.WebSocket as unknown as AcpRemoteWebSocketConstructor;
}

const LOCAL_DEV_TICKET_VERIFICATION_KEYS = [
  {
    kid: "relay-local",
    secret: "local-ticket-secret-for-dev",
  },
] as const satisfies readonly [
  AcpRemoteTicketVerificationKey,
  ...AcpRemoteTicketVerificationKey[],
];

function readTicketVerificationKeys(
  relayUrl: string,
):
  readonly [AcpRemoteTicketVerificationKey, ...AcpRemoteTicketVerificationKey[]] {
  const configured = process.env[ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS_ENV_VAR];
  if (!configured) {
    if (isLocalRelayUrl(relayUrl)) {
      return LOCAL_DEV_TICKET_VERIFICATION_KEYS;
    }
    return ACP_REMOTE_DEFAULT_TICKET_PUBLIC_KEYS;
  }
  const parsed = JSON.parse(configured) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `${ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS_ENV_VAR} must be a non-empty JSON array.`,
    );
  }
  const keys = parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { kid?: unknown }).kid !== "string"
    ) {
      throw new Error(
        `${ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS_ENV_VAR} entries must include kid and (publicKey or secret) strings.`,
      );
    }
    const { kid, publicKey, secret } = entry as { kid: string; publicKey?: string; secret?: string };
    if (!publicKey && !secret) {
      throw new Error(
        `${ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS_ENV_VAR} entries must include kid and (publicKey or secret) strings.`,
      );
    }
    return {
      kid,
      ...(publicKey ? { alg: "Ed25519" as const, publicKey } : {}),
      ...(secret ? { secret } : {}),
    };
  });
  return keys as [AcpRemoteTicketVerificationKey, ...AcpRemoteTicketVerificationKey[]];
}

function isLocalRelayUrl(relayUrl: string): boolean {
  try {
    const url = new URL(relayUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

function readWorkspaceRoots(argv: readonly string[]): string[] {
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (
      argv[index] === "--workspace-root" &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--")
    ) {
      roots.push(argv[index + 1]);
      index += 1;
    }
  }
  const envRoots = process.env["ACP_REMOTE_DAEMON_WORKSPACE_ROOTS"];
  if (envRoots) {
    roots.push(
      ...envRoots
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    );
  }
  return roots.length > 0 ? roots : [homedir()];
}

/**
 * Scan PATH for installed ACP agent binaries.
 * Returns entries like { command: "simulator-agent-acp", label: "Simulator Agent ACP" }.
 */
function discoverAgentsInPath(): {
  command: string;
  label: string;
  type?: string;
}[] {
  const knownAgents = [
    { command: "codex-acp", label: "Codex" },
    { command: "claude-acp", label: "Claude Code" },
    { command: "qwen-code", label: "Qwen Code" },
    { command: "opencode", label: "OpenCode" },
    { command: "pi-acp", label: "Pi" },
    { command: "cursor-acp", label: "Cursor" },
    { command: "gemini-acp", label: "Gemini" },
    { command: "github-copilot-cli", label: "GitHub Copilot" },
    {
      command: "simulator-agent-acp",
      label: "Simulator Agent",
      type: "simulator",
    },
  ];

  const discovered: { command: string; label: string; type?: string }[] = [];
  for (const agent of knownAgents) {
    try {
      // Resolve full path — `which` may return a shell shim that spawn() can't execute.
      // Use `node -e "require('child_process').execSync..."` or just check with shell.
      const fullPath = execSync(`command -v ${agent.command} 2>/dev/null || which ${agent.command} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (fullPath) {
        discovered.push({ ...agent, command: fullPath });
      }
    } catch {
      // not in PATH, skip
    }
  }
  return discovered;
}

function buildDaemonMetadata(
  discoveredAgents: readonly DaemonAgentMetadata[],
  workspaceRoots: string[],
): DaemonMetadata | undefined {
  const agentTypes = dedupeDaemonAgents([
    ...DEFAULT_REGISTRY_AGENTS,
    ...discoveredAgents,
  ]);
  if (workspaceRoots.length === 0 && agentTypes.length === 0) {
    return { agentTypes: [], workspaceRoots: [] };
  }
  return {
    agentTypes,
    machine: hostname(),
    workspaceRoots: workspaceRoots.map((path) => ({ path })),
  };
}

function dedupeDaemonAgents(
  agents: readonly DaemonAgentMetadata[],
): DaemonAgentMetadata[] {
  const seen = new Set<string>();
  const result: DaemonAgentMetadata[] = [];
  for (const agent of agents) {
    const key = agent.id ? `id:${agent.id}` : `command:${agent.command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(agent);
  }
  return result;
}

async function resolveSession(
  argv: readonly string[],
  relayUrl: string,
  options: { forceLogin?: boolean } = {},
): Promise<DaemonSession> {
  // 1. CLI/env override
  const idx = argv.indexOf("--account-session");
  if (idx !== -1 && argv[idx + 1]) {
    return { accountId: "", token: argv[idx + 1], savedAt: Date.now() };
  }
  const envToken = process.env[ACP_REMOTE_DAEMON_ACCOUNT_SESSION_ENV_VAR];
  if (envToken) {
    return { accountId: "", token: envToken, savedAt: Date.now() };
  }

  // 2. Cached session
  if (!options.forceLogin) {
    const cached = await loadCachedSession();
    if (cached) {
      process.stderr.write(`Using cached session (${cached.accountId}).\n`);
      return cached;
    }
  } else {
    process.stderr.write("Ignoring cached session because --force-login was set.\n");
  }

  // 3. Browser OAuth flow
  process.stderr.write(
    "No cached session. Opening browser for GitHub login...\n",
  );
  const session = await loginViaOAuth(relayUrl);
  await saveSession(session);
  process.stderr.write(`Session saved for account ${session.accountId}.\n`);
  return session;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

async function main(rawArgv: readonly string[]): Promise<void> {
  const command = readCommand(rawArgv);
  const argv = command.argv;

  if (argv.includes("--help")) {
    printHelp();
    return;
  }

  switch (command.name) {
    case "install":
      await installService(argv);
      return;
    case "uninstall":
      await uninstallAcpRemoteDaemonUserService();
      process.stdout.write("ACP remote daemon service uninstalled.\n");
      return;
    case "start": {
      const status = startAcpRemoteDaemonUserService();
      printServiceStatus(status);
      return;
    }
    case "stop": {
      const status = stopAcpRemoteDaemonUserService();
      printServiceStatus(status);
      return;
    }
    case "status": {
      const status = getAcpRemoteDaemonUserServiceStatus();
      printServiceStatus(status);
      return;
    }
    case "run":
      await runDaemon(argv);
      return;
  }
}

async function installService(argv: readonly string[]): Promise<void> {
  const config = parseAcpRemoteDaemonCliConfig({ argv });
  const workspaceRoots = readWorkspaceRoots(argv);
  const session = await resolveSession(argv, config.relayUrl, {
    forceLogin: config.forceLogin,
  });
  const env = {
    ...process.env,
    ...(session.accountId ? { ACP_REMOTE_DAEMON_ACCOUNT_ID: session.accountId } : {}),
    ...(config.accountSession ? { ACP_REMOTE_DAEMON_ACCOUNT_SESSION: config.accountSession } : {}),
  };
  const status = await installAcpRemoteDaemonUserService({
    daemonBinPath: process.argv[1],
    daemonId: config.daemonId,
    env,
    identityPath: config.identityPath,
    nodePath: process.execPath,
    relayUrl: config.relayUrl,
    workspaceRoots,
  });
  printServiceStatus(status);
  process.stdout.write(
    `Installed ACP remote daemon service. Logs: ${homedir()}/.acp-runtime/logs/daemon.err.log\n`,
  );
}

async function runDaemon(argv: readonly string[]): Promise<void> {
  const config = parseAcpRemoteDaemonCliConfig({ argv });
  const workspaceRoots = readWorkspaceRoots(argv);
  const discoveredAgents = discoverAgentsInPath();
  config.daemonMetadata = buildDaemonMetadata(discoveredAgents, workspaceRoots);
  const WebSocketConstructor = await resolveWebSocket();
  const ticketVerificationKeys = readTicketVerificationKeys(config.relayUrl);
  const session = await resolveSession(argv, config.relayUrl, {
    forceLogin: config.forceLogin,
  });
  config.accountSession = session.token;
  config.accountId = session.accountId;
  const relayTelemetry = configureAcpRelayTelemetryFromEnv({
    accountSession: config.accountSession,
    context: {
      "acp.remote.account_id": config.accountId,
      "acp.remote.daemon_id": config.daemonId,
      "acp.remote.machine": config.daemonMetadata?.machine,
      "acp.remote.workspace_roots": workspaceRoots,
    },
    onError(error) {
      process.stderr.write(
        `Relay log upload failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
    relayUrl: config.relayUrl,
    source: "daemon",
  });
  const writeDaemonLog = (
    message: string,
    attributes?: Record<string, unknown>,
    severityText: "ERROR" | "INFO" = "INFO",
    context?: AcpRemoteDaemonDebugContext,
  ): void => {
    process.stderr.write(`${message}\n`);
    appendDaemonClassifiedLog(message, severityText, context);
    relayTelemetry?.uploader.writeText(
      message,
      {
        "acp.jsonrpc.id": context?.jsonRpcId,
        "acp.jsonrpc.method": context?.method,
        "acp.remote.component": "daemon",
        "acp.remote.connection_id": context?.connectionId,
        "acp.remote.direction": context?.direction,
        "acp.session.id": context?.sessionId,
        ...attributes,
      },
      {
        severityText,
        spanId: context?.spanId,
        traceId: context?.traceId,
      },
    );
  };
  const debugLog = (
    message: string,
    context?: AcpRemoteDaemonDebugContext,
  ): void => {
    writeDaemonLog(message, undefined, context?.severityText ?? "INFO", context);
  };

  const connectionFactory = createStdioAcpConnectionFactory();
  const agentList =
    config.daemonMetadata?.agentTypes.length
      ? config.daemonMetadata.agentTypes
          .map((a) => a.id ?? a.command)
          .filter(Boolean)
          .join(", ")
      : "(none configured)";
  let stopping = false;
  let reconnectDelayMs = DEFAULT_RECONNECT_MIN_DELAY_MS;
  let active: { close(): void } | undefined;
  const stop = () => {
    stopping = true;
    active?.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopping) {
    writeDaemonLog(
      `Connecting to ${config.relayUrl}${config.daemonId ? ` (${config.daemonId})` : ""} (agents: ${agentList})...`,
      { "acp.remote.relay_url": config.relayUrl },
    );
    try {
      const connected = await connectAcpRemoteDaemonRelayFromCliConfig({
        config,
        connectionFactory,
        debugLog,
        socketFactory: createAcpRemoteWebSocketFactory(WebSocketConstructor),
        ticketVerificationKeys,
      });
      active = connected;
      reconnectDelayMs = DEFAULT_RECONNECT_MIN_DELAY_MS;
      writeDaemonLog(
        `Daemon connected (${connected.daemonId}). Waiting for clients...`,
        { "acp.remote.daemon_id": connected.daemonId },
      );
      await waitForDaemonDisconnect(connected);
      active = undefined;
      if (!stopping) {
        writeDaemonLog("Relay connection closed. Reconnecting...");
      }
    } catch (error) {
      active = undefined;
      if (stopping) {
        break;
      }
      writeDaemonLog(
        `Relay connection failed: ${error instanceof Error ? error.message : error}`,
        { "acp.remote.error": error instanceof Error ? error.message : String(error) },
        "ERROR",
      );
    }

    if (!stopping) {
      writeDaemonLog(`Retrying in ${Math.round(reconnectDelayMs / 1000)}s...`);
      await delay(reconnectDelayMs);
      reconnectDelayMs = Math.min(
        reconnectDelayMs * 2,
        DEFAULT_RECONNECT_MAX_DELAY_MS,
      );
    }
  }
  await relayTelemetry?.close();
}

function appendDaemonClassifiedLog(
  message: string,
  severityText: "ERROR" | "INFO",
  context?: AcpRemoteDaemonDebugContext,
): void {
  try {
    mkdirSync(DAEMON_LOG_DIR, { recursive: true });
    const line = `${JSON.stringify({
      body: message,
      connectionId: context?.connectionId,
      direction: context?.direction,
      jsonRpcId: context?.jsonRpcId,
      kind: "text",
      method: context?.method,
      observedAt: new Date().toISOString(),
      severityText,
      sessionId: context?.sessionId,
      spanId: context?.spanId,
      source: "daemon",
      traceId: context?.traceId,
      traceparent: context?.traceparent,
    })}\n`;
    appendFileSync(DAEMON_TEXT_LOG_PATH, line);
    if (severityText === "ERROR") {
      appendFileSync(DAEMON_ERROR_LOG_PATH, line);
    }
    if (!context?.sessionId) {
      return;
    }
    const sessionDir = daemonSessionLogDir(context.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    appendFileSync(join(sessionDir, "daemon.log.text.jsonl"), line);
    if (severityText === "ERROR") {
      appendFileSync(join(sessionDir, "daemon.log.errors.jsonl"), line);
    }
  } catch (error) {
    process.stderr.write(
      `Daemon classified log write failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function daemonSessionLogDir(sessionId: string): string {
  return join(
    DAEMON_LOG_DIR,
    "sessions",
    sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session",
  );
}

function waitForDaemonDisconnect(input: {
  close(): void;
  socket: {
    addEventListener(type: "close" | "error", listener: () => void): void;
    send(data: string): void;
  };
}): Promise<void> {
  const heartbeat = setInterval(() => {
    try {
      input.socket.send(
        JSON.stringify({ frameType: "ping", nonce: crypto.randomUUID() }),
      );
    } catch (error) {
      process.stderr.write(
        `Daemon heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }, 15_000);
  return new Promise((resolve) => {
    const done = () => {
      clearInterval(heartbeat);
      resolve();
    };
    input.socket.addEventListener("close", done);
    input.socket.addEventListener("error", done);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCommand(argv: readonly string[]): {
  argv: readonly string[];
  name: "install" | "run" | "start" | "status" | "stop" | "uninstall";
} {
  const first = argv[0];
  if (
    first === "install" ||
    first === "run" ||
    first === "start" ||
    first === "status" ||
    first === "stop" ||
    first === "uninstall"
  ) {
    return { argv: argv.slice(1), name: first };
  }
  return { argv, name: "run" };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  acp-runtime daemon run [--relay-url <ws-url>]",
      "  acp-runtime daemon install [--relay-url <ws-url>] [--workspace-root <path>...]",
      "  acp-runtime daemon status",
      "  acp-runtime daemon stop",
      "  acp-runtime daemon start",
      "  acp-runtime daemon uninstall",
      "",
      "Options:",
      `  --relay-url          Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  --host-id            Daemon ID (optional; default: persistent machine ID)",
      "  --identity-path      Daemon identity path (optional)",
      "  --workspace-root     Workspace root path (repeatable; default: home directory)",
      "  --account-session    Account session token (skip browser OAuth)",
      "  --force-login        Ignore cached session and open browser OAuth",
      "",
      "Environment variables:",
      "  ACP_REMOTE_DAEMON_RELAY_URL            Relay WebSocket URL",
      "  ACP_REMOTE_DAEMON_TICKET_PUBLIC_KEYS   JSON public key set for private relays",
      "  ACP_REMOTE_DAEMON_WORKSPACE_ROOTS      Comma-separated workspace roots",
      "  ACP_REMOTE_DAEMON_ACCOUNT_SESSION      Account session token",
      "",
      "Service install:",
      "  install writes a macOS user LaunchAgent with RunAtLoad and KeepAlive.",
      "  The daemon process also reconnects to the relay with exponential backoff.",
      "",
      "Agent discovery:",
      "  The daemon reports ACP registry ids to the relay by default.",
      "  PATH-discovered ACP agent binaries are also reported as compatibility entries.",
      "  The actual agent is selected during the authorize flow.",
      "",
      "Login flow:",
      "  If no --account-session or env var is set, the daemon checks",
      "  ~/.acp/relay-session.json, otherwise opens browser OAuth and saves it.",
      "  Use --force-login to refresh an expired or mismatched cached session.",
      "",
      "Local development:",
      "  When --relay-url points at localhost/127.0.0.1, the daemon accepts the",
      "  default local relay ticket key from packages/relay-worker/.dev.vars.",
      "",
      "Defaults:",
      `  relay: ${ACP_REMOTE_DEFAULT_RELAY_URL}`,
      "  workspace root: home directory",
    ].join("\n") + "\n",
  );
}

function printServiceStatus(status: {
  installed: boolean;
  label: string;
  plistPath: string;
  running: boolean;
}): void {
  process.stdout.write(
    [
      `label: ${status.label}`,
      `installed: ${status.installed ? "yes" : "no"}`,
      `running: ${status.running ? "yes" : "no"}`,
      `plist: ${status.plistPath}`,
    ].join("\n") + "\n",
  );
}
