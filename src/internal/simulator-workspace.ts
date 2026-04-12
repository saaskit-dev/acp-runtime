import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveSimulatorWorkspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "packages", "simulator-agent");
}

export function resolveBuiltSimulatorWorkspaceCliPath(): string {
  const cliPath = join(resolveSimulatorWorkspaceRoot(), "dist", "cli.js");
  if (!existsSync(cliPath)) {
    throw new Error(
      `Missing built simulator CLI at ${cliPath}. Build @saaskit-dev/simulator-agent-acp first.`,
    );
  }
  return cliPath;
}
