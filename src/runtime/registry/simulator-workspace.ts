import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveSimulatorWorkspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Source execution: src/runtime/registry -> repo root.
    resolve(here, "..", "..", "..", "packages", "simulator-agent"),
    // Compiled harness execution: dist/src/runtime/registry -> repo root.
    resolve(here, "..", "..", "..", "..", "packages", "simulator-agent"),
    // CLI/scripts are normally launched from the repository root.
    resolve(process.cwd(), "packages", "simulator-agent"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return candidates[0];
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
