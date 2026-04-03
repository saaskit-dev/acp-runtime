import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadHarnessAgentDefinition } from "./agent-registry.js";
import { loadHarnessCase } from "./case-loader.js";
import { buildCaseOutputDir, runHarnessCase } from "./run-case.js";
import { executeHarnessCaseOverStdio } from "./stdio-executor.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const agentPath = getArg("--agent");
  const casePath = getArg("--case");
  const outputRoot = getArg("--output-dir") ?? "./research/harness/outputs";

  if (!agentPath || !casePath) {
    throw new Error("Usage: node dist/harness/cli.js --agent <agent.json> --case <case.json> [--output-dir <dir>]");
  }

  const agent = await loadHarnessAgentDefinition(resolve(agentPath));
  const testCase = await loadHarnessCase(resolve(casePath));
  const runId = new Date().toISOString().replaceAll(":", "-");
  const outputDir = buildCaseOutputDir(resolve(outputRoot), agent.id, testCase.id, runId);
  await mkdir(outputDir, { recursive: true });

  const result = await runHarnessCase({
    agent,
    testCase,
    outputDir,
    executor: executeHarnessCaseOverStdio,
  });

  console.log(JSON.stringify({
    status: result.status,
    agentId: result.agentId,
    caseId: result.caseId,
    outputDir,
    notes: result.notes,
  }, null, 2));

  if (result.status === "failed" || result.status === "mismatch") {
    process.exitCode = 1;
  }
}

void main();
