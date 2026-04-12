import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  HarnessAgentDefinition,
  HarnessCase,
  HarnessClassification,
  HarnessFailureStatus,
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

  await mkdir(options.outputDir, { recursive: true });

  const classification = options.testCase.classification?.[options.agent.type];

  for (const assertion of options.testCase.assertions) {
    let passed = false;

    switch (assertion.type) {
      case "transcript-has-method":
        passed = transcript.some((entry) => entry.method === assertion.method);
        break;
      case "transcript-has-event":
        passed = transcript.some((entry) => entry.type === assertion.eventType);
        break;
      case "summary-status":
        passed = getValueAtPath(result.summaryPatch, assertion.path) === assertion.equals;
        break;
      case "transcript-method-response-has": {
        const responseEntry = transcript.find(
          (entry) => entry.method === assertion.method && entry.direction === "inbound" && entry.payload,
        );
        if (responseEntry) {
          const value = getValueAtPath(responseEntry.payload, assertion.path);
          if (assertion.equals !== undefined) {
            passed = value === assertion.equals;
          } else {
            passed = assertion.notEmpty ? value != null && value !== "" : value !== undefined;
          }
        }
        break;
      }
      case "transcript-event-count": {
        const count = transcript.filter((entry) => entry.type === assertion.eventType).length;
        const minOk = assertion.min === undefined || count >= assertion.min;
        const maxOk = assertion.max === undefined || count <= assertion.max;
        passed = minOk && maxOk;
        break;
      }
      case "transcript-event-field": {
        const matchingEntries = transcript.filter((entry) => entry.type === assertion.eventType);
        passed = matchingEntries.some((entry) => {
          const value = getValueAtPath(entry.payload, assertion.path);
          if (assertion.equals !== undefined) return value === assertion.equals;
          if (assertion.notEmpty) return value != null && value !== "";
          return value !== undefined;
        });
        break;
      }
      case "transcript-order": {
        const firstIdx = transcript.findIndex(
          (entry) => entry.method === assertion.first || entry.type === assertion.first,
        );
        const thenIdx = transcript.findIndex(
          (entry) => entry.method === assertion.then || entry.type === assertion.then,
        );
        passed = firstIdx !== -1 && thenIdx !== -1 && firstIdx < thenIdx;
        break;
      }
      default: {
        const exhaustiveCheck: never = assertion;
        throw new Error(`Unsupported assertion: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }

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
