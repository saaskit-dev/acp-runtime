#!/usr/bin/env node

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createAcpRemoteWebSocketFactory,
  type AcpRemoteWebSocketConstructor,
} from "../shared/relay-socket.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";
import {
  createAcpRelayBridgeStdioConfig,
  createAcpRelayBridgeZedConfig,
  parseAcpRelayBridgeConfigArgs,
} from "./bridge-config.js";
import { createAcpRemoteStdioBridge } from "./stdio-bridge.js";
import type { AcpRemoteBridgeDebugContext } from "./stdio-bridge.js";
import {
  createAcpRelayLogUploaderFromEnv,
  type AcpRelayLogUploader,
} from "../relay-log-upload.js";

const ACP_RELAY_URL_ENV = "ACP_RELAY_URL";
const ACP_DAEMON_ID_ENV = "ACP_DAEMON_ID";
const ACP_CLIENT_ID_ENV = "ACP_CLIENT_ID";
const ACP_ACCOUNT_SESSION_ENV = "ACP_ACCOUNT_SESSION";
const ACP_REMOTE_AUTO_AUTHORIZE_ENV = "ACP_REMOTE_AUTO_AUTHORIZE";

const LOG_DIR = join(homedir(), ".acp-runtime");
const LOG_PATH = join(LOG_DIR, "bridge.log");
const TEXT_LOG_PATH = join(LOG_DIR, "bridge.log.text.jsonl");
const ERROR_LOG_PATH = join(LOG_DIR, "bridge.log.errors.jsonl");

let relayLogUploader: AcpRelayLogUploader | undefined;
let exiting = false;

function log(
  message: string,
  severityText: "ERROR" | "INFO" = "INFO",
  context?: AcpRemoteBridgeDebugContext,
): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(`[bridge] ${message}\n`);
  relayLogUploader?.writeText(
    message,
    {
      "acp.jsonrpc.id": context?.jsonRpcId,
      "acp.jsonrpc.method": context?.method,
      "acp.remote.component": "bridge",
      "acp.remote.direction": context?.direction,
      "acp.session.id": context?.sessionId,
    },
    {
      severityText,
      spanId: context?.spanId,
      traceId: context?.traceId,
    },
  );
  try {
    appendFileSync(LOG_PATH, line);
    appendClassifiedLog(message, severityText, context);
  } catch (error) {
    process.stderr.write(
      `[bridge] log write failed: ${formatError(error)}\n`,
    );
  }
}

function loadCachedAccountSession(): string | undefined {
  try {
    const data = JSON.parse(
      readFileSync(join(homedir(), ".acp-runtime", "relay-session.json"), "utf8"),
    ) as {
      token?: unknown;
    };
    return typeof data.token === "string" ? data.token : undefined;
  } catch {
    return undefined;
  }
}

function readBooleanEnv(name: string): boolean {
  const value = process.env[name];
  return value === "1" || value?.toLowerCase() === "true";
}

function loadOrCreateClientId(): string {
  const env = process.env[ACP_CLIENT_ID_ENV];
  if (env) {
    return env;
  }

  const configDir = join(homedir(), ".acp-runtime", "client");
  const configPath = join(configDir, "device.json");
  try {
    if (existsSync(configPath)) {
      const data = JSON.parse(readFileSync(configPath, "utf8")) as {
        deviceId?: unknown;
      };
      if (typeof data.deviceId === "string") {
        return data.deviceId;
      }
    }
  } catch (error) {
    log(`client id cache read failed: ${formatError(error)}`);
  }

  const deviceId = crypto.randomUUID();
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ deviceId }, undefined, 2),
    );
  } catch (error) {
    log(`client id cache write failed: ${formatError(error)}`);
  }
  return deviceId;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printHelp();
    return;
  }
  if (argv[0] === "config") {
    const options = parseAcpRelayBridgeConfigArgs(argv.slice(1));
    const stdioConfig = createAcpRelayBridgeStdioConfig(options);
    const zedConfig = createAcpRelayBridgeZedConfig(options);
    if (options.format === "generic") {
      process.stdout.write(`${JSON.stringify(stdioConfig, null, 2)}\n`);
      return;
    }
    if (options.format === "zed") {
      process.stdout.write(`${JSON.stringify(zedConfig, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      [
        "ACP Runtime Bridge Config",
        "",
        `Command: ${stdioConfig.command}`,
        `Relay URL: ${stdioConfig.env.ACP_RELAY_URL}`,
        "",
        "Generic stdio ACP client:",
        JSON.stringify(stdioConfig, null, 2),
        "",
        "Zed custom agent config:",
        JSON.stringify(zedConfig, null, 2),
        "",
      ].join("\n"),
    );
    return;
  }

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_PATH, "");
    writeFileSync(TEXT_LOG_PATH, "");
    writeFileSync(ERROR_LOG_PATH, "");
  } catch (error) {
    process.stderr.write(
      `[bridge] log initialization failed: ${formatError(error)}\n`,
    );
  }

  const relayUrl = process.env[ACP_RELAY_URL_ENV] ?? ACP_REMOTE_DEFAULT_RELAY_URL;
  const clientId = loadOrCreateClientId();
  const daemonId = process.env[ACP_DAEMON_ID_ENV];
  const accountSession =
    process.env[ACP_ACCOUNT_SESSION_ENV] ?? loadCachedAccountSession();
  relayLogUploader = createAcpRelayLogUploaderFromEnv({
    accountSession,
    context: {
      "acp.remote.client_id": clientId,
      "acp.remote.daemon_id": daemonId,
    },
    onError(error) {
      process.stderr.write(
        `[bridge] relay log upload failed: ${formatError(error)}\n`,
      );
    },
    relayUrl,
    source: "bridge",
  });
  const autoAuthorize = readBooleanEnv(ACP_REMOTE_AUTO_AUTHORIZE_ENV);
  const { WebSocket } = await import("ws");
  const debugLog = (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ): void => {
    log(message, context?.severityText ?? "INFO", context);
  };

  const bridge = createAcpRemoteStdioBridge({
    accountSession,
    autoAuthorize: autoAuthorize && accountSession
      ? { accountSession, daemonId }
      : undefined,
    clientId,
    daemonId,
    debugLog,
    onClose() {
      log("bridge closed.");
      exitAfterLogUpload(0);
    },
    onError(error) {
      log(`relay connection error: ${error.message}`, "ERROR");
    },
    reconnect: {
      maxDelayMs: 30_000,
      minDelayMs: 1_000,
    },
    relayUrl,
    socketFactory: createAcpRemoteWebSocketFactory(
      WebSocket as unknown as AcpRemoteWebSocketConstructor,
    ),
  });

  log("stdio ACP bridge connected to relay.");
  process.on("SIGINT", () => bridge.close());
  process.on("SIGTERM", () => bridge.close());
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  acp-runtime bridge run",
      "  acp-runtime bridge config [--relay-url <ws-url>] [--command <path>] [--zed|--all]",
      "",
      "Runtime environment:",
      `  ACP_RELAY_URL              Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  ACP_CLIENT_ID              Optional persistent client id override",
      "  ACP_DAEMON_ID              Optional daemon id pin",
      "  ACP_ACCOUNT_SESSION        Optional account session token",
      "  ACP_REMOTE_AUTO_AUTHORIZE  Test-only auto authorization flag",
      "",
      "Config options:",
      "  --command        Override the acp-runtime command path in generated config.",
      "  --format         Output format: generic, zed, or all. Default: generic.",
      "  --legacy-command Generate a config where command contains the full launcher.",
      "  --zed            Shortcut for --format zed.",
      "  --all            Shortcut for --format all.",
      "",
      "The bridge is a generic stdio ACP adapter. Configure stdio-only ACP",
      "clients to launch `acp-runtime bridge run`. ACP_RELAY_URL is optional for the default relay.",
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error), "ERROR");
  exitAfterLogUpload(1);
});

process.on("uncaughtException", (error) => {
  if (isBrokenPipeError(error)) {
    exitAfterLogUpload(0);
    return;
  }
  log(
    `Uncaught: ${error instanceof Error ? error.message : String(error)}`,
    "ERROR",
  );
  exitAfterLogUpload(1);
});

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendClassifiedLog(
  message: string,
  severityText: "ERROR" | "INFO",
  context?: AcpRemoteBridgeDebugContext,
): void {
  const line = `${JSON.stringify({
    body: message,
    connectionId: context?.connectionId,
    direction: context?.direction,
    eventName: context?.eventName,
    jsonRpcId: context?.jsonRpcId,
    kind: "text",
    method: context?.method,
    observedAt: new Date().toISOString(),
    severityText,
    sessionId: context?.sessionId,
    spanId: context?.spanId,
    source: "bridge",
    traceId: context?.traceId,
    traceparent: context?.traceparent,
  })}\n`;
  appendFileSync(TEXT_LOG_PATH, line);
  if (severityText === "ERROR") {
    appendFileSync(ERROR_LOG_PATH, line);
  }
  if (!context?.sessionId) {
    return;
  }
  const sessionDir = bridgeSessionLogDir(context.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  appendFileSync(join(sessionDir, "bridge.log.text.jsonl"), line);
  if (severityText === "ERROR") {
    appendFileSync(join(sessionDir, "bridge.log.errors.jsonl"), line);
  }
}

function bridgeSessionLogDir(sessionId: string): string {
  return join(
    LOG_DIR,
    "logs",
    "sessions",
    sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session",
  );
}

function exitAfterLogUpload(code: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  void (relayLogUploader?.close() ?? Promise.resolve())
    .catch((error) => {
      process.stderr.write(
        `[bridge] relay log shutdown failed: ${formatError(error)}\n`,
      );
    })
    .finally(() => {
      process.exit(code);
    });
}
