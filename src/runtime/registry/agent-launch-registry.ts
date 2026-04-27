import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Extract } from "unzipper";
import { extract as tarExtract } from "tar";

import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../agents/index.js";
import { createNpxCommandLaunch } from "../agents/launch-config.js";
import { resolveBuiltSimulatorWorkspaceCliPath } from "./simulator-workspace.js";
import {
  resolveRuntimeCachePath,
  resolveRuntimeHomePath,
} from "../paths.js";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LOCK_TIMEOUT_MS = 5_000;
const CACHE_LOCK_STALE_MS = 30_000;
const CACHE_LOCK_RETRY_MS = 25;
export const LOCAL_SIMULATOR_AGENT_ID = LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID;

let registryFetchInFlight: Promise<Registry> | undefined;

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

export const ACP_REGISTRY_AGENT_ALIASES = {
  claude: "claude-acp",
  codex: "codex-acp",
  copilot: "github-copilot-cli",
  "cursor-agent": "cursor",
  "gemini-cli": "gemini",
  github: "github-copilot-cli",
  "github-copilot": "github-copilot-cli",
  "open-code": "opencode",
  pi: "pi-acp",
  qwen: "qwen-code",
  sim: LOCAL_SIMULATOR_AGENT_ID,
  simulator: LOCAL_SIMULATOR_AGENT_ID,
} as const;

export function resolveAgentRegistryId(agentId: string): string {
  const normalized = agentId.trim();
  return ACP_REGISTRY_AGENT_ALIASES[
    normalized.toLowerCase() as keyof typeof ACP_REGISTRY_AGENT_ALIASES
  ] ?? normalized;
}

function isLocalSimulatorAgent(agentId: string): boolean {
  return resolveAgentRegistryId(agentId) === LOCAL_SIMULATOR_AGENT_ID;
}

function resolveLocalSimulatorLaunch(): AgentLaunchConfig {
  return {
    args: [
      resolveBuiltSimulatorWorkspaceCliPath(),
      "--auth-mode",
      "none",
      "--storage-dir",
      resolveRuntimeHomePath("simulator-agent-acp-harness"),
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
  return [resolveRuntimeCachePath()];
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

  if (!registryFetchInFlight) {
    registryFetchInFlight = fetchAndPersistRegistry().finally(() => {
      registryFetchInFlight = undefined;
    });
  }
  return registryFetchInFlight;
}

async function fetchAndPersistRegistry(): Promise<Registry> {
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
      await withCacheLock(`${cachePath}.lock`, async () => {
        await writeFileAtomically(cachePath, data);
      });
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
      return await withCacheLock(join(cacheDir, ".prepare.lock"), async () => {
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
      });
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
  const resolvedAgentId = resolveAgentRegistryId(agentId);

  if (isLocalSimulatorAgent(resolvedAgentId)) {
    return resolveLocalSimulatorLaunch();
  }

  const registry = await fetchRegistry();
  const agent = findAgent(registry, resolvedAgentId);
  const { distribution } = agent;

  if (distribution.binary) {
    return resolveBinary(resolvedAgentId, distribution.binary);
  }

  if (distribution.npx) {
    return resolveNpx(distribution.npx);
  }

  if (distribution.uvx) {
    return resolveUvx(distribution.uvx);
  }

  throw new Error(`Agent "${resolvedAgentId}" has no supported distribution type`);
}

export async function getAgentMeta(agentId: string): Promise<{ name: string; version: string; description: string }> {
  const resolvedAgentId = resolveAgentRegistryId(agentId);

  if (isLocalSimulatorAgent(resolvedAgentId)) {
    return {
      name: "Simulator Agent ACP (Local)",
      version: "0.1.0",
      description: "Launches the local simulator-agent-acp workspace build for harness baseline validation.",
    };
  }

  const registry = await fetchRegistry();
  const agent = findAgent(registry, resolvedAgentId);
  return { name: agent.name, version: agent.version, description: agent.description };
}

async function writeFileAtomically(path: string, data: string | Buffer): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  await writeFile(tempPath, data);
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withCacheLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await removeStaleCacheLock(lockPath);
      if (Date.now() - start >= CACHE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for cache lock: ${lockPath}`);
      }
      await wait(CACHE_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleCacheLock(lockPath: string): Promise<void> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs >= CACHE_LOCK_STALE_MS) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
