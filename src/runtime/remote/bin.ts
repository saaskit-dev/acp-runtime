#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "daemon") {
    await runInternalBin("daemon/bin.js", rest);
    return;
  }
  if (command === "auth") {
    await runInternalBin("auth-bin.js", rest);
    return;
  }
  if (command === "bridge") {
    const bridgeArgs = rest[0] === "run" ? rest.slice(1) : rest;
    await runInternalBin("client/relay-bridge.js", bridgeArgs);
    return;
  }
  throw new Error(`Unknown acp-runtime command: ${command}`);
}

function runInternalBin(relativePath: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const binPath = join(dirname(fileURLToPath(import.meta.url)), relativePath);
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  acp-runtime auth login",
      "  acp-runtime auth status",
      "  acp-runtime auth logout",
      "  acp-runtime daemon install",
      "  acp-runtime daemon status",
      "  acp-runtime daemon run",
      "  acp-runtime bridge run",
      "  acp-runtime bridge config",
      "",
      "Run a subcommand with --help for details.",
    ].join("\n") + "\n",
  );
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
