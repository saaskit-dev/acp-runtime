import { describe, expect, it } from "vitest";

import type { HarnessSummary } from "./types.js";

import { shouldExitNonZero } from "./run-agent-matrix.js";

type MatrixCaseResult = {
  permissionFamilies?: Array<
    "mode_denied" | "permission_request_cancelled" | "permission_request_end_turn"
  >;
  permissionRequestObserved?: boolean;
};

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

function summarizePermissionObservations(results: MatrixCaseResult[]) {
  return {
    permissionFamilies: [...new Set(
      results.flatMap((item) => item.permissionFamilies ?? []),
    )].sort(),
    permissionRequestObserved: results.some(
      (item) => item.permissionRequestObserved === true,
    ),
  };
}

function summarizeAdmission(results: Array<
  MatrixCaseResult & {
    caseId: string;
    kind?: "interaction" | "protocol" | "scenario";
    level?: "P0" | "P1" | "P2";
    scenarioCategory?: "main-flow" | "host-authority";
    status: "failed" | "mismatch" | "not-applicable" | "not-observed" | "passed";
  }
>) {
  const applicableResults = results.filter((item) => item.status !== "not-applicable");
  const mainFlowResults = applicableResults.filter(
    (item) => item.kind === "scenario" && item.scenarioCategory === "main-flow",
  );
  const requiredP0Cases = mainFlowResults
    .filter((item) => item.level === "P0")
    .map((item) => item.caseId)
    .sort();
  const failedRequiredP0Cases = mainFlowResults
    .filter((item) => item.level === "P0" && item.status !== "passed")
    .map((item) => item.caseId)
    .sort();
  const permissionFamilies = [...new Set(
    results.flatMap((item) => item.permissionFamilies ?? []),
  )].sort() as Array<
    "mode_denied" | "permission_request_cancelled" | "permission_request_end_turn"
  >;
  const familyCases = {
    "scenario.permission-denied-cancelled": "permission_request_cancelled",
    "scenario.permission-denied-end-turn": "permission_request_end_turn",
    "scenario.permission-mode-denied": "mode_denied",
  } as const;
  const expectedPermissionFamilies = [...new Set(
    applicableResults.flatMap((item) => {
      const family = familyCases[item.caseId as keyof typeof familyCases];
      return family ? [family] : [];
    }),
  )].sort() as Array<
    "mode_denied" | "permission_request_cancelled" | "permission_request_end_turn"
  >;
  const missingPermissionFamilies = expectedPermissionFamilies.filter(
    (family) => !permissionFamilies.includes(family),
  );
  const blockers: string[] = [];
  if (failedRequiredP0Cases.length > 0) {
    blockers.push(
      `Required P0 scenarios failed: ${failedRequiredP0Cases.join(", ")}`,
    );
  }
  if (missingPermissionFamilies.length > 0) {
    blockers.push(
      `Applicable permission families missing from evidence: ${missingPermissionFamilies.join(", ")}`,
    );
  }

  return {
    blocked: blockers.length > 0,
    blockers,
    expectedPermissionFamilies,
    failedRequiredP0Cases,
    missingPermissionFamilies,
    p0ScenariosPassed: failedRequiredP0Cases.length === 0,
    requiredP0Cases,
  };
}

describe("run-agent-matrix permission aggregation", () => {
  it("extracts permission observations from a harness summary patch", () => {
    expect(
      extractPermissionObservation({
        discovery: {
          permission: {
            deniedFamilies: ["permission_request_cancelled"],
            requestObserved: true,
          },
        },
      }),
    ).toEqual({
      permissionFamilies: ["permission_request_cancelled"],
      permissionRequestObserved: true,
    });
  });

  it("aggregates unique permission families across matrix case results", () => {
    expect(
      summarizePermissionObservations([
        {
          permissionFamilies: ["permission_request_cancelled"],
          permissionRequestObserved: true,
        },
        {
          permissionFamilies: ["mode_denied", "permission_request_end_turn"],
          permissionRequestObserved: false,
        },
      ]),
    ).toEqual({
      permissionFamilies: [
        "mode_denied",
        "permission_request_cancelled",
        "permission_request_end_turn",
      ],
      permissionRequestObserved: true,
    });
  });

  it("derives admission-oriented P0 and permission coverage summaries", () => {
    expect(
      summarizeAdmission([
        {
          caseId: "scenario.new-prompt-complete",
          kind: "scenario",
          scenarioCategory: "main-flow",
          level: "P0",
          status: "passed",
          permissionFamilies: ["permission_request_cancelled"],
        },
        {
          caseId: "scenario.write-file",
          kind: "scenario",
          scenarioCategory: "main-flow",
          level: "P0",
          status: "failed",
          permissionFamilies: ["permission_request_end_turn"],
        },
        {
          caseId: "scenario.permission-denied-end-turn",
          kind: "scenario",
          scenarioCategory: "main-flow",
          level: "P1",
          status: "passed",
          permissionFamilies: ["permission_request_end_turn"],
        },
        {
          caseId: "scenario.permission-mode-denied",
          kind: "scenario",
          scenarioCategory: "main-flow",
          level: "P1",
          status: "passed",
        },
        {
          caseId: "host.read-file",
          kind: "scenario",
          scenarioCategory: "host-authority",
          level: "P1",
          status: "failed",
        },
        {
          caseId: "protocol.initialize",
          kind: "protocol",
          level: "P0",
          status: "passed",
        },
      ]),
    ).toEqual({
      blocked: true,
      blockers: [
        "Required P0 scenarios failed: scenario.write-file",
        "Applicable permission families missing from evidence: mode_denied",
      ],
      expectedPermissionFamilies: [
        "mode_denied",
        "permission_request_end_turn",
      ],
      failedRequiredP0Cases: ["scenario.write-file"],
      missingPermissionFamilies: ["mode_denied"],
      p0ScenariosPassed: false,
      requiredP0Cases: [
        "scenario.new-prompt-complete",
        "scenario.write-file",
      ],
    });
  });

  it("separates host-authority cases from main-flow admission", () => {
    const results = [
      {
        caseId: "scenario.read-file",
        kind: "scenario" as const,
        scenarioCategory: "main-flow" as const,
        level: "P0" as const,
        status: "passed" as const,
      },
      {
        caseId: "host.read-file",
        kind: "scenario" as const,
        scenarioCategory: "host-authority" as const,
        level: "P1" as const,
        status: "not-applicable" as const,
      },
    ];

    expect(summarizeAdmission(results)).toMatchObject({
      blocked: false,
      p0ScenariosPassed: true,
      requiredP0Cases: ["scenario.read-file"],
      failedRequiredP0Cases: [],
    });
  });

  it("uses admission-only exit behavior for admission mode", () => {
    const summary = {
      agentType: "codex-acp",
      timestamp: "2026-04-22T00:00:00.000Z",
      permissionFamilies: ["permission_request_cancelled"] as const,
      missingPermissionFamilies: [],
      permissionRequestObserved: true,
      admission: {
        blocked: false,
        blockers: [],
        p0ScenariosPassed: true,
        requiredP0Cases: ["scenario.read-file"],
        failedRequiredP0Cases: [],
        expectedPermissionFamilies: ["permission_request_cancelled"] as const,
        permissionFamiliesCovered: ["permission_request_cancelled"] as const,
        permissionFamiliesMissing: [],
      },
      mainFlow: {
        requiredP0Cases: ["scenario.read-file"],
        failedRequiredP0Cases: [],
        passedRequiredP0Cases: ["scenario.read-file"],
        p0ScenariosPassed: true,
      },
      hostAuthority: {
        applicableCases: [],
        passedCases: [],
        failedCases: [],
        notApplicableCases: ["host.read-file"],
      },
      totals: {
        total: 10,
        passed: 7,
        failed: 2,
        notApplicable: 1,
        notObserved: 0,
        mismatch: 0,
      },
      results: [],
    };

    expect(shouldExitNonZero(summary, "admission")).toBe(false);
    expect(shouldExitNonZero(summary, "full")).toBe(true);
  });
});
