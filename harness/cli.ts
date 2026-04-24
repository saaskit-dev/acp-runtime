import { resolve } from "node:path";

import { getAgentMeta } from "./agent-registry.js";
import { loadHarnessCase } from "./case-loader.js";
import { caseAppliesToAgent, runHarnessCase } from "./run-case.js";
import { executeHarnessCaseOverStdio } from "./stdio-executor.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const agentType = getArg("--type") ?? getArg("--agent");
  const casePath = getArg("--case");
  const outputRoot = getArg("--output-dir") ?? "./.tmp/harness-outputs";

  if (!agentType || !casePath) {
    throw new Error("Usage: node dist/harness/cli.js --type <agent-type> --case <case.json> [--output-dir <dir>]");
  }

  const meta = await getAgentMeta(agentType);
  const agent = { type: agentType, displayName: meta.name };
  const testCase = await loadHarnessCase(resolve(casePath));
  const outputDir = resolve(outputRoot);

  if (!caseAppliesToAgent(testCase, agentType)) {
    console.log(JSON.stringify({
      status: "not-applicable",
      agentType,
      caseId: testCase.id,
      outputDir,
      notes: [`Case ${testCase.id} does not apply to ${agentType}.`],
    }, null, 2));
    return;
  }

  const result = await runHarnessCase({
    agent,
    testCase,
    outputDir,
    executor: executeHarnessCaseOverStdio,
  });

  console.log(JSON.stringify({
    status: result.status,
    agentType: result.agentType,
    caseId: result.caseId,
    outputDir,
    notes: result.notes,
    summaryPatch: result.summaryPatch,
  }, null, 2));

  if (result.status === "failed" || result.status === "mismatch") {
    process.exitCode = 1;
  }
}

void main();
