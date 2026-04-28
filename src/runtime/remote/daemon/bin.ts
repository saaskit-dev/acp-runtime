#!/usr/bin/env node

import {
  connectAcpRemoteDaemonRelayFromCliConfig,
  parseAcpRemoteDaemonCliConfig,
} from "./daemon-cli.js";
import { createAcpRemoteDaemonWebSocketFactory } from "./relay-client.js";
import type { AcpRemoteDaemonWebSocketConstructor } from "./relay-client.js";
import { AcpRuntime } from "../../core/runtime.js";
import { createStdioAcpConnectionFactory } from "../../acp/stdio-connection.js";
import type { AcpRemoteTicketSigningKey } from "../protocol/tickets.js";

const ACP_REMOTE_DAEMON_TICKET_KID_ENV_VAR = "ACP_REMOTE_DAEMON_TICKET_KID";
const ACP_REMOTE_DAEMON_TICKET_SECRET_ENV_VAR =
  "ACP_REMOTE_DAEMON_TICKET_SECRET";

async function resolveWebSocket(): Promise<AcpRemoteDaemonWebSocketConstructor> {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket as unknown as AcpRemoteDaemonWebSocketConstructor;
  }
  const ws = await import("ws");
  return ws.WebSocket as unknown as AcpRemoteDaemonWebSocketConstructor;
}

function readTicketVerificationKeys(): readonly [
  AcpRemoteTicketSigningKey,
  ...AcpRemoteTicketSigningKey[],
] {
  const kid = process.env[ACP_REMOTE_DAEMON_TICKET_KID_ENV_VAR];
  const secret = process.env[ACP_REMOTE_DAEMON_TICKET_SECRET_ENV_VAR];
  if (!kid || !secret) {
    throw new Error(
      `Missing ticket verification key. Set ${ACP_REMOTE_DAEMON_TICKET_KID_ENV_VAR} and ${ACP_REMOTE_DAEMON_TICKET_SECRET_ENV_VAR}.`,
    );
  }
  return [{ kid, secret }];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(
      [
        "Usage: acp-runtime-daemon --account-id <id> --host-id <id> --relay-url <url>",
        "",
        "Options:",
        "  --account-id       Account ID for the relay control plane",
        "  --host-id          Host daemon ID registered in the control plane",
        "  --relay-url        Relay WebSocket URL (wss://...)",
        "  --identity-path    Path to daemon identity file (optional)",
        "",
        "Environment variables:",
        "  ACP_REMOTE_DAEMON_ACCOUNT_ID",
        "  ACP_REMOTE_DAEMON_HOST_ID",
        "  ACP_REMOTE_DAEMON_RELAY_URL",
        "  ACP_REMOTE_DAEMON_IDENTITY_PATH",
        "  ACP_REMOTE_DAEMON_TICKET_KID",
        "  ACP_REMOTE_DAEMON_TICKET_SECRET",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  const config = parseAcpRemoteDaemonCliConfig({ argv });
  const WebSocketConstructor = await resolveWebSocket();
  const ticketVerificationKeys = readTicketVerificationKeys();

  const runtime = new AcpRuntime(createStdioAcpConnectionFactory());

  const connected = await connectAcpRemoteDaemonRelayFromCliConfig({
    agent: {
      command: "simulator-agent-acp",
      type: "simulator",
    },
    config,
    runtime: {
      sessions: {
        async list(options) {
          return runtime.sessions.list(options);
        },
        async load(options) {
          return runtime.sessions.load(options);
        },
        async resume(options) {
          return runtime.sessions.resume(options);
        },
        async start(options) {
          return runtime.sessions.start(options);
        },
      },
    },
    socketFactory: createAcpRemoteDaemonWebSocketFactory(WebSocketConstructor),
    ticketVerificationKeys,
  });

  function shutdown(): void {
    connected.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
