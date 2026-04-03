import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  HarnessAgentDefinition,
  HarnessCase,
  HarnessClassification,
  HarnessDiscoverySummary,
  HarnessFailureStatus,
  HarnessRunResult,
  HarnessRuntimeEvent,
  HarnessSummary,
  TranscriptEntry,
} from "./types.js";
import { buildHarnessOutputPaths, writeNotes, writeSummary, writeTranscript } from "./transcript-writer.js";

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

function mergeDiscoverySummary(
  base: HarnessDiscoverySummary | undefined,
  patch: HarnessDiscoverySummary | undefined,
): HarnessDiscoverySummary | undefined {
  if (!base && !patch) {
    return undefined;
  }

  return {
    ...base,
    ...patch,
    initialize: {
      ...base?.initialize,
      ...patch?.initialize,
    },
    session: {
      ...base?.session,
      ...patch?.session,
    },
    auth: {
      ...base?.auth,
      ...patch?.auth,
    },
    plan: {
      ...base?.plan,
      ...patch?.plan,
    },
    commands: {
      ...base?.commands,
      ...patch?.commands,
    },
    mode: {
      ...base?.mode,
      ...patch?.mode,
      availableModes: patch?.mode?.availableModes ?? base?.mode?.availableModes,
    },
  };
}

function deriveDiscoveryFromTranscript(transcript: TranscriptEntry[]): HarnessDiscoverySummary | undefined {
  let discovery: HarnessDiscoverySummary | undefined;

  for (const entry of transcript) {
    if (entry.kind !== "wire" || entry.direction !== "inbound") {
      continue;
    }

    if (entry.method === "initialize" && entry.payload && typeof entry.payload === "object") {
      const payload = entry.payload as Record<string, any>;
      discovery = mergeDiscoverySummary(discovery, {
        initialize: {
          protocolVersion: payload.protocolVersion as number | string | undefined,
          agentInfo: payload.agentInfo
            ? {
                name: payload.agentInfo.name as string | undefined,
                version: payload.agentInfo.version as string | undefined,
              }
            : undefined,
          capabilities: payload.agentCapabilities as Record<string, unknown> | undefined,
          authMethods: Array.isArray(payload.authMethods)
            ? payload.authMethods.map((item: any) => ({
                id: item?.id as string | undefined,
                name: item?.name as string | undefined,
                description: (item?.description ?? undefined) as string | undefined,
              }))
            : undefined,
        },
      });
      continue;
    }

    if (entry.method === "authenticate" && entry.payload && typeof entry.payload === "object") {
      const outbound = transcript.find((candidate) =>
        candidate.kind === "wire" &&
        candidate.direction === "outbound" &&
        candidate.method === "authenticate" &&
        typeof candidate.payload === "object");
      const payload = outbound?.payload as Record<string, any> | undefined;
      discovery = mergeDiscoverySummary(discovery, {
        auth: {
          authenticated: true,
          methodId: payload?.methodId as string | undefined,
        },
      });
      continue;
    }

    if (entry.method === "session/new" && entry.payload && typeof entry.payload === "object") {
      const payload = entry.payload as Record<string, any>;
        discovery = mergeDiscoverySummary(discovery, {
          session: {
            id: payload.sessionId as string | undefined,
          },
          mode: {
            currentModeId: payload.modes?.currentModeId as string | undefined,
            availableModes: Array.isArray(payload.modes?.availableModes)
              ? payload.modes.availableModes.map((item: any) => ({
                  id: item.id as string,
                  name: item.name as string | undefined,
                  description: item.description as string | undefined,
                }))
              : undefined,
          },
        });
        continue;
      }

    if (entry.method === "session/update" && entry.payload && typeof entry.payload === "object") {
      const payload = entry.payload as Record<string, any>;
      const update = payload.update as Record<string, any> | undefined;
      if (!update) {
        continue;
      }

      const updateType = update.sessionUpdate as string | undefined;

      if (updateType === "plan" && Array.isArray(update.entries)) {
        discovery = mergeDiscoverySummary(discovery, {
          plan: {
            entries: update.entries.map((item: any) => ({
              content: item.content as string,
              priority: item.priority as "high" | "medium" | "low",
              status: item.status as "pending" | "in_progress" | "completed",
            })),
          },
        });
        continue;
      }

      if (updateType === "available_commands_update" && Array.isArray(update.availableCommands)) {
        discovery = mergeDiscoverySummary(discovery, {
          commands: {
            available: update.availableCommands.map((item: any) => ({
              name: item.name as string,
              description: item.description as string,
              inputHint: item.input?.hint as string | undefined,
            })),
          },
        });
        continue;
      }

      if (updateType === "current_mode_update") {
        discovery = mergeDiscoverySummary(discovery, {
          mode: {
            currentModeId: update.currentModeId as string | undefined,
          },
        });
      }
    }
  }

  return discovery;
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
    agentId: options.agent.id,
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
    agentId: options.agent.id,
    transcript,
    summaryPatch: execution.summaryPatch,
    notes: execution.notes ?? [],
  };

  await mkdir(options.outputDir, { recursive: true });
  const paths = buildHarnessOutputPaths(options.outputDir);
  const summary: HarnessSummary = {
    agent: options.agent.id,
    timestamp: nowIso(),
    ...execution.summaryPatch,
    discovery: mergeDiscoverySummary(
      execution.summaryPatch.discovery,
      deriveDiscoveryFromTranscript(transcript),
    ),
  };

  const classification = options.testCase.classification;

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
        passed = getValueAtPath(summary, assertion.path) === assertion.equals;
        break;
      case "transcript-method-response-has": {
        const responseEntry = transcript.find(
          (entry) => entry.method === assertion.method && entry.direction === "inbound" && entry.payload,
        );
        if (responseEntry) {
          const value = getValueAtPath(responseEntry.payload, assertion.path);
          passed = assertion.notEmpty ? value != null && value !== "" : value !== undefined;
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
        agentId: options.agent.id,
        details: { assertionType: assertion.type },
      });
    } else {
      emitRuntimeEvent({
        type: "assertion-failed",
        caseId: options.testCase.id,
        agentId: options.agent.id,
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
    agentId: options.agent.id,
    details: { status: result.status },
  });

  await writeTranscript(paths.transcriptPath, transcript);
  const finalSummary: HarnessSummary = {
    ...summary,
    ...result.summaryPatch,
    protocolCoverage: {
      ...summary.protocolCoverage,
      ...result.summaryPatch.protocolCoverage,
    },
  };

  await writeSummary(paths.summaryPath, finalSummary);
  await writeNotes(paths.notesPath, result.notes);

  return result;
}

export function buildCaseOutputDir(baseDir: string, agentId: string, caseId: string, runId: string): string {
  return join(baseDir, agentId, caseId, runId);
}
