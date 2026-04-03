import { spawnSync } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";

import { getAgentMeta } from "./agent-registry.js";
import { loadHarnessCase } from "./case-loader.js";
import type { HarnessRunStatus } from "./types.js";

const CASE_TIMEOUT_MS = 45_000;

type MatrixCaseResult = {
  caseId: string;
  status: HarnessRunStatus;
  notes: string[];
};

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function listCaseFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(dir, entry.name))
    .sort();
}

function cliEntrypoint(): string {
  return new URL("./cli.js", import.meta.url).pathname;
}

async function runSingleCase(
  agentId: string,
  casePath: string,
  outputDir: string,
  cwd: string,
): Promise<MatrixCaseResult> {
  let testCase;
  try {
    testCase = await loadHarnessCase(casePath);
  } catch (error) {
    return {
      caseId: basename(casePath, ".json"),
      status: "failed",
      notes: [`Failed to load case ${casePath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const maxAttempts = (testCase.retries?.count ?? 0) + 1;
  const retryStatuses = new Set(testCase.retries?.onStatuses ?? []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let stderrText = "";
    try {
      const result = spawnSync(
        process.execPath,
        [cliEntrypoint(), "--agent", agentId, "--case", casePath, "--output-dir", outputDir],
        {
          cwd,
          timeout: CASE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024 * 8,
          encoding: "utf8",
        },
      );

      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      stderrText = stderr.trim();

      if (result.error) {
        throw result.error;
      }

      const parsed = JSON.parse(stdout) as {
        status: MatrixCaseResult["status"];
        caseId: string;
        notes: string[];
      };

      if (attempt < maxAttempts && retryStatuses.has(parsed.status as any)) {
        continue;
      }

      return {
        caseId: parsed.caseId,
        status: parsed.status,
        notes: stderrText.length > 0
          ? [...parsed.notes, stderrText]
          : parsed.notes,
      };
    } catch (error) {
      const notes: string[] = [];

      if (error instanceof SyntaxError) {
        notes.push(`Failed to parse case runner output for ${basename(casePath)}: ${error.message}`);
      } else if (error instanceof Error) {
        notes.push(error.message);
      } else {
        notes.push(String(error));
      }

      if (stderrText.length > 0) {
        notes.push(stderrText);
      }

      return {
        caseId: testCase.id,
        status: "failed",
        notes,
      };
    }
  }

  return {
    caseId: testCase.id,
    status: "failed",
    notes: ["Unexpected retry loop termination"],
  };
}

async function main(): Promise<void> {
  const agentId = getArg("--agent");
  const caseFile = getArg("--case");
  const casesRoot = getArg("--cases-root") ?? "./src/harness/cases";
  const outputRoot = getArg("--output-dir") ?? "./harness-outputs";

  if (!agentId) {
    throw new Error("Usage: node dist/harness/run-agent-matrix.js --agent <agent-id> [--case <file>] [--cases-root <dir>] [--output-dir <dir>]");
  }

  const meta = await getAgentMeta(agentId);
  const agent = { id: agentId, displayName: meta.name };
  const caseFiles = caseFile
    ? [resolve(caseFile)]
    : await listCaseFiles(resolve(casesRoot));

  const agentDir = resolve(outputRoot, agent.id);
  await mkdir(agentDir, { recursive: true });

  const results: MatrixCaseResult[] = [];

  for (const caseFile of caseFiles) {
    const result = await runSingleCase(agentId, caseFile, agentDir, process.cwd());
    results.push(result);
  }

  const summary = {
    agentId: agent.id,
    timestamp: new Date().toISOString(),
    totals: {
      total: results.length,
      passed: results.filter((item) => item.status === "passed").length,
      failed: results.filter((item) => item.status === "failed").length,
      notApplicable: results.filter((item) => item.status === "not-applicable").length,
      notObserved: results.filter((item) => item.status === "not-observed").length,
      mismatch: results.filter((item) => item.status === "mismatch").length,
    },
    results,
  };

  await writeFile(join(agentDir, "matrix-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));

  if (summary.totals.failed > 0) {
    process.exitCode = 1;
  }
}

void main();
