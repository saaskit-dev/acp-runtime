import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Extract } from "unzipper";
import { extract as tarExtract } from "tar";

import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../runtime/agents/index.js";
import { createNpxCommandLaunch } from "./launch-config.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "./simulator-workspace.js";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCAL_SIMULATOR_AGENT_ID = LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID;
const CACHE_ROOT_ENV_VAR = "ACP_RUNTIME_CACHE_DIR";

type BinaryTarget = {
  archive: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
};

type BinaryDistribution = {
  "darwin-aarch64"?: BinaryTarget;
  "darwin-x86_64"?: BinaryTarget;
  "linux-aarch64"?: BinaryTarget;
  "linux-x86_64"?: BinaryTarget;
  "windows-aarch64"?: BinaryTarget;
  "windows-x86_64"?: BinaryTarget;
};

type NpxDistribution = {
  package: string;
  args?: string[];
  env?: Record<string, string>;
};

type UvxDistribution = {
  package: string;
  args?: string[];
  env?: Record<string, string>;
};

type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  distribution: {
    binary?: BinaryDistribution;
    npx?: NpxDistribution;
    uvx?: UvxDistribution;
  };
};

type Registry = {
  version: string;
  agents: RegistryAgent[];
};

export type AgentLaunchConfig = {
  command: string;
  args: string[];
  env?: Record<string, string | undefined>;
};

function isLocalSimulatorAgent(agentId: string): boolean {
  return agentId === LOCAL_SIMULATOR_AGENT_ID;
}

function resolveLocalSimulatorLaunch(): AgentLaunchConfig {
  return {
    args: [
      resolveBuiltSimulatorWorkspaceCliPath(),
      "--auth-mode",
      "none",
      "--storage-dir",
      resolve(process.cwd(), ".tmp/simulator-agent-acp-harness"),
    ],
    command: process.execPath,
    env: {},
  };
}

function currentPlatformKey(): keyof BinaryDistribution {
  const os = platform();
  const cpu = arch();

  if (os === "darwin" && cpu === "arm64") return "darwin-aarch64";
  if (os === "darwin") return "darwin-x86_64";
  if (os === "linux" && cpu === "arm64") return "linux-aarch64";
  if (os === "linux") return "linux-x86_64";
  if (os === "win32" && cpu === "arm64") return "windows-aarch64";
  if (os === "win32") return "windows-x86_64";

  throw new Error(`Unsupported platform: ${os}/${cpu}`);
}

function runtimeCacheRootCandidates(): string[] {
  const candidates = [
    process.env[CACHE_ROOT_ENV_VAR]?.trim(),
    join(homedir(), ".cache", "acp-runtime"),
    resolve(process.cwd(), ".tmp", "acp-runtime-cache"),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function registryCachePaths(): string[] {
  return runtimeCacheRootCandidates().map((root) => join(root, "registry.json"));
}

function agentCacheDirs(agentId: string): string[] {
  return runtimeCacheRootCandidates().map((root) => join(root, "agents", agentId));
}

async function isCacheFresh(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return Date.now() - info.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

async function fetchRegistry(): Promise<Registry> {
  for (const cachePath of registryCachePaths()) {
    if (await isCacheFresh(cachePath)) {
      const raw = await readFile(cachePath, "utf8");
      return JSON.parse(raw) as Registry;
    }
  }

  const response = await fetch(REGISTRY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ACP registry: ${response.status} ${response.statusText}`);
  }

  const data = await response.text();
  await persistRegistryCache(data);

  return JSON.parse(data) as Registry;
}

async function persistRegistryCache(data: string): Promise<void> {
  for (const cachePath of registryCachePaths()) {
    const cacheRoot = dirname(cachePath);
    try {
      await mkdir(cacheRoot, { recursive: true });
      await writeFile(cachePath, data, "utf8");
      return;
    } catch {
      // Try the next writable cache root. Cache persistence is best effort.
    }
  }
}

function findAgent(registry: Registry, agentId: string): RegistryAgent {
  const agent = registry.agents.find((a) => a.id === agentId);
  if (!agent) {
    const available = registry.agents.map((a) => a.id).join(", ");
    throw new Error(`Agent "${agentId}" not found in ACP registry. Available: ${available}`);
  }
  return agent;
}

function isCommandInPath(cmd: string): boolean {
  const which = platform() === "win32" ? "where" : "which";
  const result = spawnSync(which, [cmd], { encoding: "utf8", stdio: "pipe" });
  return result.status === 0;
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(destPath, Buffer.from(buffer));
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });

  if (archivePath.endsWith(".zip")) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const stream = createReadStream(archivePath)
        .pipe(Extract({ path: destDir }));
      stream.on("close", resolvePromise);
      stream.on("error", rejectPromise);
    });
  } else if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await tarExtract({ file: archivePath, cwd: destDir });
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

async function ensureBinaryFromArchive(agentId: string, target: BinaryTarget): Promise<AgentLaunchConfig> {
  const archiveUrl = target.archive;
  const archiveFilename = archiveUrl.split("/").pop() ?? "agent.archive";
  const cmdName = target.cmd.replace(/^\.\//, "");
  const failures: string[] = [];

  for (const cacheDir of agentCacheDirs(agentId)) {
    const archivePath = join(cacheDir, archiveFilename);
    const cachedCmd = resolve(cacheDir, cmdName);

    try {
      await stat(cachedCmd);
      return {
        command: cachedCmd,
        args: target.args ?? [],
        env: target.env ?? {},
      };
    } catch (_) {
      void _;
    }

    try {
      await mkdir(cacheDir, { recursive: true });
      process.stderr.write(`Downloading ${agentId} from ${archiveUrl}...\n`);
      await downloadFile(archiveUrl, archivePath);

      process.stderr.write(`Extracting ${archiveFilename}...\n`);
      await extractArchive(archivePath, cacheDir);

      if (platform() !== "win32") {
        spawnSync("chmod", ["+x", cachedCmd]);
      }

      return {
        command: cachedCmd,
        args: target.args ?? [],
        env: target.env ?? {},
      };
    } catch (error) {
      failures.push(`${cacheDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Failed to prepare cached binary for agent "${agentId}". Tried: ${failures.join(" | ")}`,
  );
}

async function resolveBinary(agentId: string, dist: BinaryDistribution): Promise<AgentLaunchConfig> {
  const platformKey = currentPlatformKey();
  const target = dist[platformKey];

  if (!target) {
    throw new Error(`No binary distribution for platform "${platformKey}" for agent "${agentId}"`);
  }

  const cmdName = target.cmd.replace(/^\.\//, "").replace(/\.exe$/, "");

  if (isCommandInPath(cmdName)) {
    return {
      command: cmdName,
      args: target.args ?? [],
      env: target.env ?? {},
    };
  }

  return ensureBinaryFromArchive(agentId, target);
}

function resolveNpx(dist: NpxDistribution): AgentLaunchConfig {
  return createNpxCommandLaunch({
    args: dist.args,
    env: dist.env,
    packageSpec: dist.package,
  });
}

function resolveUvx(dist: UvxDistribution): AgentLaunchConfig {
  return {
    command: "uvx",
    args: [dist.package, ...(dist.args ?? [])],
    env: dist.env ?? {},
  };
}

export async function resolveAgentLaunch(agentId: string): Promise<AgentLaunchConfig> {
  if (isLocalSimulatorAgent(agentId)) {
    return resolveLocalSimulatorLaunch();
  }

  const registry = await fetchRegistry();
  const agent = findAgent(registry, agentId);
  const { distribution } = agent;

  if (distribution.binary) {
    return resolveBinary(agentId, distribution.binary);
  }

  if (distribution.npx) {
    return resolveNpx(distribution.npx);
  }

  if (distribution.uvx) {
    return resolveUvx(distribution.uvx);
  }

  throw new Error(`Agent "${agentId}" has no supported distribution type`);
}

export async function getAgentMeta(agentId: string): Promise<{ name: string; version: string; description: string }> {
  if (isLocalSimulatorAgent(agentId)) {
    return {
      name: "Simulator Agent ACP (Local)",
      version: "0.1.0",
      description: "Launches the local simulator-agent-acp workspace build for harness baseline validation.",
    };
  }

  const registry = await fetchRegistry();
  const agent = findAgent(registry, agentId);
  return { name: agent.name, version: agent.version, description: agent.description };
}
