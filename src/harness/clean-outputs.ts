import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type AgentCleanResult = {
  agentId: string;
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

async function listAgentDirs(outputsRoot: string): Promise<string[]> {
  const entries = await readdir(outputsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputsRoot, entry.name))
    .sort();
}

export async function cleanAgentOutputs(agentDir: string, dryRun: boolean): Promise<AgentCleanResult> {
  const agentId = agentDir.split("/").at(-1) ?? agentDir;
  const entries = await readdir(agentDir, { withFileTypes: true });

  const toRemove = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name === "matrix-summary.json"))
    .map((entry) => join(agentDir, entry.name));

  if (!dryRun) {
    for (const filePath of toRemove) {
      await rm(filePath, { force: true });
    }
  }

  return {
    agentId,
    removed: toRemove,
    kept: [],
  };
}

async function main(): Promise<void> {
  const outputsRoot = resolve(getArg("--outputs-dir") ?? "./harness-outputs");
  const agentFilter = getArg("--agent");
  const dryRun = process.argv.includes("--dry-run");

  const agentDirs = await listAgentDirs(outputsRoot);
  const selectedAgentDirs = agentFilter
    ? agentDirs.filter((dir) => dir.endsWith(`/${agentFilter}`))
    : agentDirs;

  if (selectedAgentDirs.length === 0) {
    throw new Error(`No agent outputs found under ${outputsRoot}${agentFilter ? ` for agent ${agentFilter}` : ""}`);
  }

  const results: AgentCleanResult[] = [];

  for (const agentDir of selectedAgentDirs) {
    const result = await cleanAgentOutputs(agentDir, dryRun);
    results.push(result);
  }

  console.log(JSON.stringify({ outputsRoot, dryRun, agents: results }, null, 2));
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main();
}
