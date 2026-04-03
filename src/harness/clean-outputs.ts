import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CleanupResult = {
  removed: string[];
  kept: string[];
};

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

export async function listDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dir, entry.name))
    .sort();
}

async function hasFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.some((entry) => entry.isFile());
}

export async function cleanupRunGroup(dir: string, dryRun: boolean): Promise<CleanupResult> {
  const runDirs = await listDirectories(dir);

  if (runDirs.length <= 1) {
    // Still clean up if the sole directory is empty
    if (runDirs.length === 1 && !await hasFiles(runDirs[0]) && !dryRun) {
      await rm(runDirs[0], { recursive: true, force: true });
      return { removed: runDirs, kept: [] };
    }
    return {
      removed: [],
      kept: runDirs,
    };
  }

  // Prefer the latest directory that actually contains files
  let kept: string | undefined;
  const removed: string[] = [];

  for (let i = runDirs.length - 1; i >= 0; i--) {
    if (!kept && await hasFiles(runDirs[i])) {
      kept = runDirs[i];
    } else {
      removed.push(runDirs[i]);
    }
  }

  // If no directory had files, keep the latest anyway (may still be writing)
  if (!kept) {
    kept = runDirs[runDirs.length - 1];
    removed.length = 0;
    removed.push(...runDirs.slice(0, -1));
  }

  if (!dryRun) {
    for (const runDir of removed) {
      await rm(runDir, { recursive: true, force: true });
    }
  }

  return { removed, kept: kept ? [kept] : [] };
}

export async function cleanupAgent(agentDir: string, dryRun: boolean): Promise<CleanupResult> {
  const groups = await listDirectories(agentDir);
  const summary: CleanupResult = { removed: [], kept: [] };

  for (const groupDir of groups) {
    const result = await cleanupRunGroup(groupDir, dryRun);
    summary.removed.push(...result.removed);
    summary.kept.push(...result.kept);
  }

  return summary;
}

async function main(): Promise<void> {
  const outputsRoot = resolve(getArg("--outputs-dir") ?? "./harness-outputs");
  const agentFilter = getArg("--agent");
  const dryRun = process.argv.includes("--dry-run");

  const agentDirs = await listDirectories(outputsRoot);
  const selectedAgentDirs = agentFilter
    ? agentDirs.filter((dir) => dir.endsWith(`/${agentFilter}`))
    : agentDirs;

  if (selectedAgentDirs.length === 0) {
    throw new Error(`No agent outputs found under ${outputsRoot}${agentFilter ? ` for agent ${agentFilter}` : ""}`);
  }

  const summary = {
    outputsRoot,
    dryRun,
    agents: [] as Array<{
      agentId: string;
      removed: string[];
      kept: string[];
    }>,
  };

  for (const agentDir of selectedAgentDirs) {
    const agentId = agentDir.split("/").at(-1) ?? agentDir;
    const result = await cleanupAgent(agentDir, dryRun);
    summary.agents.push({
      agentId,
      removed: result.removed,
      kept: result.kept,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
