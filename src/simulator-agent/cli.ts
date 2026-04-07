#!/usr/bin/env node

import { Readable, Writable } from "node:stream";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { createSimulatorAgentAcp, type SimulatorAgentAcpOptions } from "./simulator-agent.js";

function parseArgs(argv: string[]): SimulatorAgentAcpOptions & { authHelper: boolean } {
  const options: SimulatorAgentAcpOptions & { authHelper: boolean } = {
    authHelper: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--name":
        options.name = next;
        index += 1;
        break;
      case "--title":
        options.title = next;
        index += 1;
        break;
      case "--version":
        options.version = next;
        index += 1;
        break;
      case "--storage-dir":
        options.storageDir = next;
        index += 1;
        break;
      case "--auth-mode":
        if (next === "none" || next === "optional" || next === "required") {
          options.authMode = next;
        }
        index += 1;
        break;
      case "--auth-helper":
        options.authHelper = true;
        break;
      default:
        break;
    }
  }

  return options;
}

async function runAuthHelper(): Promise<void> {
  process.stdout.write("Simulator Agent ACP terminal authentication helper\n");
  process.stdout.write("Authentication is simulated. Close this helper and call authenticate.\n");
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.authHelper) {
    await runAuthHelper();
    return;
  }

  const storageDir = options.storageDir ?? join(process.cwd(), ".simulator-agent-acp");
  await mkdir(storageDir, { recursive: true });

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );

  const connection = new AgentSideConnection(
    (conn) =>
      createSimulatorAgentAcp(conn, {
        ...options,
        storageDir,
        onFatalExit: (code) => {
          process.exit(code);
        },
      }),
    stream,
  );

  await connection.closed;
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
