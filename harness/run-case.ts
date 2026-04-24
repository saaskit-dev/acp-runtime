import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  HarnessAgentDefinition,
  HarnessCase,
  HarnessClassification,
  HarnessFailureStatus,
  HarnessPermissionFamily,
  HarnessRunResult,
  HarnessRuntimeEvent,
  TranscriptEntry,
} from "./types.js";
import { writeTranscript } from "./transcript-writer.js";

export type HarnessCaseExecutor = (context: {
  agent: HarnessAgentDefinition;
  testCase: HarnessCase;
  emitRuntimeEvent(event: HarnessRuntimeEvent): void;
  emitWireEntry(entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] }): void;
}) => Promise<{
  status: HarnessRunResult["status"];
  summaryPatch: HarnessRunResult["summaryPatch"];
  notes?: string[];
}>;

export type RunHarnessCaseOptions = {
  agent: HarnessAgentDefinition;
  testCase: HarnessCase;
  outputDir: string;
  executor: HarnessCaseExecutor;
};

export function caseAppliesToAgent(testCase: HarnessCase, agentType: string): boolean {
  const include = testCase.agents?.include;
  if (include && include.length > 0 && !include.includes(agentType)) {
    return false;
  }

  const exclude = testCase.agents?.exclude;
  if (exclude && exclude.includes(agentType)) {
    return false;
  }

  return true;
}

function mapRunStatusToCoverageStatus(status: HarnessRunResult["status"]): "PASS" | "FAIL" | "N/A" | "MISMATCH" | "NOT_OBSERVED" {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "not-applicable":
      return "N/A";
    case "mismatch":
      return "MISMATCH";
    case "not-observed":
      return "NOT_OBSERVED";
    default: {
      const exhaustiveCheck: never = status;
      throw new Error(`Unsupported run status: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

function defaultFailureStatus(
  classification: HarnessClassification | undefined,
  reason: "assertion" | "timeout" | "execution",
): HarnessFailureStatus {
  if (reason === "assertion") {
    return classification?.assertionFailureStatus ?? "failed";
  }

  if (reason === "timeout") {
    return classification?.timeoutStatus ?? "failed";
  }

  return classification?.executionErrorStatus ?? "failed";
}

function nowIso(): string {
  return new Date().toISOString();
}

function getValueAtPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, root);
}

function derivePermissionFamilies(
  transcript: TranscriptEntry[],
  currentModeId: unknown,
): HarnessPermissionFamily[] {
  const families = new Set<HarnessPermissionFamily>();
  const permissionRequestObserved = transcript.some(
    (entry) => entry.method === "session/request_permission" && entry.direction === "inbound",
  );
  const promptResponse = transcript.find(
    (entry) => entry.method === "session/prompt" && entry.direction === "inbound" && entry.payload,
  );
  const stopReason = getValueAtPath(promptResponse?.payload, "stopReason");
  const failedToolUpdates = transcript.filter(
    (entry) =>
      entry.type === "tool_call_update" &&
      getValueAtPath(entry.payload, "update.status") === "failed",
  ).length;

  if (permissionRequestObserved && stopReason === "cancelled") {
    families.add("permission_request_cancelled");
  }

  if (permissionRequestObserved && failedToolUpdates > 0) {
    families.add("permission_request_end_turn");
  }

  if (
    !permissionRequestObserved &&
    failedToolUpdates > 0 &&
    (stopReason === "end_turn" || stopReason === undefined) &&
    typeof currentModeId === "string" &&
    currentModeId.length > 0
  ) {
    families.add("mode_denied");
  }

  return [...families];
}

function resolveToolKindForEntry(
  transcript: TranscriptEntry[],
  entry: TranscriptEntry,
): unknown {
  const inlineKind = getValueAtPath(entry.payload, "update.kind");
  if (inlineKind !== undefined) {
    return inlineKind;
  }

  const toolCallId = getValueAtPath(entry.payload, "update.toolCallId");
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return undefined;
  }

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const candidate = transcript[index];
    if (candidate.type !== "tool_call") {
      continue;
    }

    if (getValueAtPath(candidate.payload, "update.toolCallId") !== toolCallId) {
      continue;
    }

    return getValueAtPath(candidate.payload, "update.kind");
  }

  return undefined;
}

function evaluateAssertion(
  transcript: TranscriptEntry[],
  summaryPatch: HarnessRunResult["summaryPatch"],
  assertion: HarnessCase["assertions"][number],
): boolean {
  switch (assertion.type) {
    case "transcript-has-method":
      return transcript.some((entry) => entry.method === assertion.method);
    case "transcript-has-event":
      return transcript.some((entry) => entry.type === assertion.eventType);
    case "transcript-has-tool-kind":
      return transcript.some(
        (entry) => (entry.type === "tool_call" || entry.type === "tool_call_update") &&
          resolveToolKindForEntry(transcript, entry) === assertion.kind,
      );
    case "transcript-has-tool-update":
      return transcript.some((entry) => {
        if (entry.type !== "tool_call_update") {
          return false;
        }
        const kind = resolveToolKindForEntry(transcript, entry);
        const status = getValueAtPath(entry.payload, "update.status");
        return kind === assertion.kind &&
          (assertion.status === undefined || status === assertion.status);
      });
    case "summary-status":
      return getValueAtPath(summaryPatch, assertion.path) === assertion.equals;
    case "transcript-method-response-has": {
      const responseEntry = transcript.find(
        (entry) => entry.method === assertion.method && entry.direction === "inbound" && entry.payload,
      );
      if (!responseEntry) {
        return false;
      }

      const value = getValueAtPath(responseEntry.payload, assertion.path);
      if (assertion.equals !== undefined) {
        return value === assertion.equals;
      }
      return assertion.notEmpty ? value != null && value !== "" : value !== undefined;
    }
    case "transcript-event-count": {
      const count = transcript.filter((entry) => entry.type === assertion.eventType).length;
      const minOk = assertion.min === undefined || count >= assertion.min;
      const maxOk = assertion.max === undefined || count <= assertion.max;
      return minOk && maxOk;
    }
    case "transcript-event-field": {
      const matchingEntries = transcript.filter((entry) => entry.type === assertion.eventType);
      return matchingEntries.some((entry) => {
        const value = getValueAtPath(entry.payload, assertion.path);
        if (assertion.equals !== undefined) return value === assertion.equals;
        if (assertion.notEmpty) return value != null && value !== "";
        return value !== undefined;
      });
    }
    case "transcript-order": {
      const firstIdx = transcript.findIndex(
        (entry) => entry.method === assertion.first || entry.type === assertion.first,
      );
      const thenIdx = transcript.findIndex(
        (entry) => entry.method === assertion.then || entry.type === assertion.then,
      );
      return firstIdx !== -1 && thenIdx !== -1 && firstIdx < thenIdx;
    }
    case "any-of":
      return assertion.assertions.some((nested) => evaluateAssertion(transcript, summaryPatch, nested));
    default: {
      const exhaustiveCheck: never = assertion;
      throw new Error(`Unsupported assertion: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

export async function runHarnessCase(options: RunHarnessCaseOptions): Promise<HarnessRunResult> {
  const transcript: TranscriptEntry[] = [];

  const emitRuntimeEvent = (event: HarnessRuntimeEvent): void => {
    transcript.push({
      timestamp: nowIso(),
      kind: "runtime",
      direction: "internal",
      type: event.type,
      payload: event,
    });
  };

  const emitWireEntry = (
    entry: Omit<TranscriptEntry, "timestamp" | "kind"> & { kind?: TranscriptEntry["kind"] },
  ): void => {
    transcript.push({
      timestamp: nowIso(),
      kind: entry.kind ?? "wire",
      direction: entry.direction,
      type: entry.type,
      method: entry.method,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      payload: entry.payload,
    });
  };

  emitRuntimeEvent({
    type: "run-started",
    caseId: options.testCase.id,
    agentType: options.agent.type,
  });

  const execution = await options.executor({
    agent: options.agent,
    testCase: options.testCase,
    emitRuntimeEvent,
    emitWireEntry,
  });

  const assertionNotes: string[] = [];

  const result: HarnessRunResult = {
    status: execution.status,
    caseId: options.testCase.id,
    agentType: options.agent.type,
    transcript,
    summaryPatch: execution.summaryPatch,
    notes: execution.notes ?? [],
  };

  const permissionRequestObserved = transcript.some(
    (entry) => entry.method === "session/request_permission" && entry.direction === "inbound",
  );
  const permissionFamilies = derivePermissionFamilies(
    transcript,
    execution.summaryPatch.discovery?.mode?.currentModeId,
  );
  if (permissionFamilies.length > 0 || permissionRequestObserved) {
    result.summaryPatch = {
      ...result.summaryPatch,
      discovery: {
        ...result.summaryPatch.discovery,
        permission: {
          deniedFamilies: permissionFamilies,
          requestObserved: permissionRequestObserved,
        },
      },
    };
  }
  if (options.testCase.kind === "scenario" && permissionFamilies.length > 0) {
    result.summaryPatch = {
      ...result.summaryPatch,
      scenarioResults: {
        ...result.summaryPatch.scenarioResults,
        [options.testCase.id]: {
          level: options.testCase.level ?? "P1",
          notes: [
            ...(result.summaryPatch.scenarioResults?.[options.testCase.id]?.notes ?? []),
            `Observed permission families: ${permissionFamilies.join(", ")}`,
          ],
          protocolDependencies: options.testCase.protocolDependencies,
          status:
            result.summaryPatch.scenarioResults?.[options.testCase.id]?.status ?? "PASS",
        },
      },
    };
  }

  await mkdir(options.outputDir, { recursive: true });

  const classification = options.testCase.classification?.[options.agent.type];

  for (const assertion of options.testCase.assertions) {
    const passed = evaluateAssertion(transcript, result.summaryPatch, assertion);

    if (passed) {
      emitRuntimeEvent({
        type: "assertion-passed",
        caseId: options.testCase.id,
        agentType: options.agent.type,
        details: { assertionType: assertion.type },
      });
    } else {
      emitRuntimeEvent({
        type: "assertion-failed",
        caseId: options.testCase.id,
        agentType: options.agent.type,
        details: { assertionType: assertion.type, assertion },
      });
      assertionNotes.push(`Assertion failed: ${JSON.stringify(assertion)}`);
    }
  }

  if (assertionNotes.length > 0) {
    result.status = defaultFailureStatus(classification, "assertion");
    result.notes.push(...assertionNotes);
  }

  if (result.status !== "passed") {
    const missingCoverageStatus = mapRunStatusToCoverageStatus(result.status);
    const missingProtocolCoverage = Object.fromEntries(
      options.testCase.protocolDependencies
        .filter((dependency) => result.summaryPatch.protocolCoverage?.[dependency] === undefined)
        .map((dependency) => [
          dependency,
          {
            status: missingCoverageStatus,
            advertised: true,
            caseId: options.testCase.id,
            notes: result.notes,
          },
        ]),
    );

    if (Object.keys(missingProtocolCoverage).length > 0) {
      result.summaryPatch = {
        ...result.summaryPatch,
        protocolCoverage: {
          ...result.summaryPatch.protocolCoverage,
          ...missingProtocolCoverage,
        },
      };
    }
  }

  emitRuntimeEvent({
    type: "run-completed",
    caseId: options.testCase.id,
    agentType: options.agent.type,
    details: { status: result.status },
  });

  await writeTranscript(join(options.outputDir, `${options.testCase.id}.jsonl`), transcript);

  return result;
}

export function buildCaseOutputDir(baseDir: string, agentType: string): string {
  return join(baseDir, agentType);
}
