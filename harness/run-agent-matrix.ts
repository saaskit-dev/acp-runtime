import { spawnSync } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { pathToFileURL } from "node:url";

import { getAgentMeta } from "./agent-registry.js";
import { loadHarnessCase } from "./case-loader.js";
import { caseAppliesToAgent } from "./run-case.js";
import type {
  HarnessPermissionFamily,
  HarnessRunStatus,
  HarnessScenarioCategory,
  HarnessSummary,
} from "./types.js";

const CASE_TIMEOUT_MS = 45_000;
const PERMISSION_FAMILY_CASES = {
  "scenario.permission-denied-cancelled": "permission_request_cancelled",
  "scenario.permission-denied-end-turn": "permission_request_end_turn",
  "scenario.permission-mode-denied": "mode_denied",
} as const satisfies Record<string, HarnessPermissionFamily>;

type MatrixCaseResult = {
  caseId: string;
  kind?: "interaction" | "protocol" | "scenario";
  level?: "P0" | "P1" | "P2";
  scenarioCategory?: HarnessScenarioCategory;
  status: HarnessRunStatus;
  notes: string[];
  permissionFamilies?: HarnessPermissionFamily[];
  permissionRequestObserved?: boolean;
};

type MatrixExitMode = "admission" | "full";

type MatrixSummary = {
  agentType: string;
  timestamp: string;
  permissionFamilies: HarnessPermissionFamily[];
  missingPermissionFamilies: HarnessPermissionFamily[];
  permissionRequestObserved: boolean;
  admission: {
    blocked: boolean;
    blockers: string[];
    p0ScenariosPassed: boolean;
    requiredP0Cases: string[];
    failedRequiredP0Cases: string[];
    expectedPermissionFamilies: HarnessPermissionFamily[];
    permissionFamiliesCovered: HarnessPermissionFamily[];
    permissionFamiliesMissing: HarnessPermissionFamily[];
  };
  mainFlow: {
    requiredP0Cases: string[];
    failedRequiredP0Cases: string[];
    passedRequiredP0Cases: string[];
    p0ScenariosPassed: boolean;
  };
  hostAuthority: {
    applicableCases: string[];
    passedCases: string[];
    failedCases: string[];
    notApplicableCases: string[];
  };
  totals: {
    total: number;
    passed: number;
    failed: number;
    notApplicable: number;
    notObserved: number;
    mismatch: number;
  };
  results: MatrixCaseResult[];
};

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function parseExitMode(value: string | undefined): MatrixExitMode {
  if (value === undefined || value === "full") {
    return "full";
  }

  if (value === "admission") {
    return "admission";
  }

  throw new Error(`Unsupported --gate value: ${value}. Expected "admission" or "full".`);
}

export function shouldExitNonZero(summary: MatrixSummary, mode: MatrixExitMode): boolean {
  if (mode === "admission") {
    return summary.admission.blocked;
  }

  return summary.totals.failed > 0 || summary.admission.blocked;
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

function extractPermissionObservation(
  summaryPatch: Partial<HarnessSummary> | undefined,
): Pick<MatrixCaseResult, "permissionFamilies" | "permissionRequestObserved"> {
  const permission = summaryPatch?.discovery?.permission;
  return {
    permissionFamilies:
      permission?.deniedFamilies && permission.deniedFamilies.length > 0
        ? [...permission.deniedFamilies]
        : undefined,
    permissionRequestObserved: permission?.requestObserved,
  };
}

async function runSingleCase(
  agentType: string,
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
      kind: "protocol",
      status: "failed",
      notes: [`Failed to load case ${casePath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!caseAppliesToAgent(testCase, agentType)) {
    return {
      caseId: testCase.id,
      kind: testCase.kind,
      level: testCase.level,
      scenarioCategory: testCase.scenarioCategory,
      status: "not-applicable",
      notes: [`Case ${testCase.id} does not apply to ${agentType}.`],
    };
  }

  const maxAttempts = (testCase.retries?.count ?? 0) + 1;
  const retryStatuses = new Set(testCase.retries?.onStatuses ?? []);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let stderrText = "";
    try {
      const result = spawnSync(
        process.execPath,
        [cliEntrypoint(), "--type", agentType, "--case", casePath, "--output-dir", outputDir],
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
        summaryPatch?: Partial<HarnessSummary>;
      };

      if (attempt < maxAttempts && retryStatuses.has(parsed.status as any)) {
        continue;
      }

      return {
        caseId: parsed.caseId,
        kind: testCase.kind,
        level: testCase.level,
        scenarioCategory: testCase.scenarioCategory,
        status: parsed.status,
        notes: stderrText.length > 0
          ? [...parsed.notes, stderrText]
          : parsed.notes,
        ...extractPermissionObservation(parsed.summaryPatch),
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
        kind: testCase.kind,
        level: testCase.level,
        scenarioCategory: testCase.scenarioCategory,
        status: "failed",
        notes,
      };
    }
  }

  return {
    caseId: testCase.id,
    kind: testCase.kind,
    level: testCase.level,
    scenarioCategory: testCase.scenarioCategory,
    status: "failed",
    notes: ["Unexpected retry loop termination"],
  };
}

async function main(): Promise<void> {
  const agentType = getArg("--type") ?? getArg("--agent");
  const caseFile = getArg("--case");
  const casesRoot = getArg("--cases-root") ?? "./harness/cases";
  const outputRoot = getArg("--output-dir") ?? "./.tmp/harness-outputs";
  const exitMode = parseExitMode(getArg("--gate"));

  if (!agentType) {
    throw new Error("Usage: node dist/harness/run-agent-matrix.js --type <agent-type> [--case <file>] [--cases-root <dir>] [--output-dir <dir>] [--gate <admission|full>]");
  }

  const meta = await getAgentMeta(agentType);
  const agent = { type: agentType, displayName: meta.name };
  const caseFiles = caseFile
    ? [resolve(caseFile)]
    : await listCaseFiles(resolve(casesRoot));

  const agentDir = resolve(outputRoot, agent.type);
  await mkdir(agentDir, { recursive: true });

  const results: MatrixCaseResult[] = [];

  for (const caseFile of caseFiles) {
    const result = await runSingleCase(agentType, caseFile, agentDir, process.cwd());
    results.push(result);
  }

  const applicableResults = results.filter((item) => item.status !== "not-applicable");
  const mainFlowResults = applicableResults.filter(
    (item) => item.kind === "scenario" && item.scenarioCategory === "main-flow",
  );
  const hostAuthorityResults = results.filter(
    (item) => item.kind === "scenario" && item.scenarioCategory === "host-authority",
  );
  const requiredP0Cases = mainFlowResults
    .filter((item) => item.level === "P0")
    .map((item) => item.caseId)
    .sort();
  const failedRequiredP0Cases = mainFlowResults
    .filter((item) => item.level === "P0" && item.status !== "passed")
    .map((item) => item.caseId)
    .sort();
  const observedPermissionFamilies = [...new Set(
    results.flatMap((item) => item.permissionFamilies ?? []),
  )].sort() as HarnessPermissionFamily[];
  const expectedPermissionFamilies = [...new Set(
    applicableResults.flatMap((item) => {
      const family = PERMISSION_FAMILY_CASES[item.caseId as keyof typeof PERMISSION_FAMILY_CASES];
      return family ? [family] : [];
    }),
  )].sort() as HarnessPermissionFamily[];
  const missingPermissionFamilies = expectedPermissionFamilies.filter(
    (family) => !observedPermissionFamilies.includes(family),
  );
  const admissionBlockers: string[] = [];
  if (failedRequiredP0Cases.length > 0) {
    admissionBlockers.push(
      `Required P0 scenarios failed: ${failedRequiredP0Cases.join(", ")}`,
    );
  }
  if (missingPermissionFamilies.length > 0) {
    admissionBlockers.push(
      `Applicable permission families missing from evidence: ${missingPermissionFamilies.join(", ")}`,
    );
  }

  const summary: MatrixSummary = {
    agentType: agent.type,
    timestamp: new Date().toISOString(),
    permissionFamilies: observedPermissionFamilies,
    missingPermissionFamilies,
    permissionRequestObserved: results.some(
      (item) => item.permissionRequestObserved === true,
    ),
    admission: {
      blocked: admissionBlockers.length > 0,
      blockers: admissionBlockers,
      p0ScenariosPassed: failedRequiredP0Cases.length === 0,
      requiredP0Cases,
      failedRequiredP0Cases,
      expectedPermissionFamilies,
      permissionFamiliesCovered: observedPermissionFamilies,
      permissionFamiliesMissing: missingPermissionFamilies,
    },
    mainFlow: {
      requiredP0Cases,
      failedRequiredP0Cases,
      passedRequiredP0Cases: requiredP0Cases.filter((caseId) => !failedRequiredP0Cases.includes(caseId)),
      p0ScenariosPassed: failedRequiredP0Cases.length === 0,
    },
    hostAuthority: {
      applicableCases: hostAuthorityResults
        .filter((item) => item.status !== "not-applicable")
        .map((item) => item.caseId)
        .sort(),
      passedCases: hostAuthorityResults
        .filter((item) => item.status === "passed")
        .map((item) => item.caseId)
        .sort(),
      failedCases: hostAuthorityResults
        .filter((item) => item.status !== "passed" && item.status !== "not-applicable")
        .map((item) => item.caseId)
        .sort(),
      notApplicableCases: hostAuthorityResults
        .filter((item) => item.status === "not-applicable")
        .map((item) => item.caseId)
        .sort(),
    },
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

  if (shouldExitNonZero(summary, exitMode)) {
    process.exitCode = 1;
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  void main();
}
