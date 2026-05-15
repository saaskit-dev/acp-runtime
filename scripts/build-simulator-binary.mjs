#!/usr/bin/env node

import { mkdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(repoRoot, "packages", "simulator-agent", "dist-bin");
const targets = readTargets();

rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const outfile = join(outDir, binaryNameForTarget(target));
  const result = spawnSync(
    "bun",
    [
      "build",
      "packages/simulator-agent/src/cli.ts",
      "--compile",
      "--minify",
      "--bytecode",
      `--target=${target}`,
      "--outfile",
      outfile,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`built ${outfile}\n`);
}

function readTargets() {
  const explicit = process.env.SIMULATOR_AGENT_BINARY_TARGETS;
  if (explicit) {
    return explicit.split(",").map((target) => target.trim()).filter(Boolean);
  }
  return [defaultTarget()];
}

function defaultTarget() {
  const os = platform();
  const cpu = arch();
  if (os === "darwin" && cpu === "arm64") return "bun-darwin-arm64";
  if (os === "darwin" && cpu === "x64") return "bun-darwin-x64";
  if (os === "linux" && cpu === "arm64") return "bun-linux-arm64";
  if (os === "linux" && cpu === "x64") return "bun-linux-x64";
  throw new Error(`Unsupported binary target for ${os}/${cpu}`);
}

function binaryNameForTarget(target) {
  const suffix = target.replace(/^bun-/, "");
  return suffix.includes("windows")
    ? `simulator-agent-acp-${suffix}.exe`
    : `simulator-agent-acp-${suffix}`;
}

