import type {
  CoverageStatus,
  HarnessAssertion,
  HarnessAgentFilter,
  HarnessCase,
  HarnessCaseKind,
  HarnessCaseLevel,
  HarnessScenarioCategory,
  HarnessFailureStatus,
  HarnessStep,
  HarnessDiscoverySummary,
  HarnessSummary,
  ProtocolCoverageResult,
  ScenarioResult,
  TranscriptDirection,
  TranscriptEntry,
  TranscriptEntryKind,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHarnessAgentFilter(value: unknown): value is HarnessAgentFilter {
  return isPlainObject(value) &&
    (value.include === undefined || isStringArray(value.include)) &&
    (value.exclude === undefined || isStringArray(value.exclude));
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return value === "PASS" ||
    value === "FAIL" ||
    value === "N/A" ||
    value === "MISSING" ||
    value === "MISMATCH" ||
    value === "NOT_OBSERVED";
}

function isHarnessCaseKind(value: unknown): value is HarnessCaseKind {
  return value === "protocol" || value === "interaction" || value === "scenario";
}

function isHarnessCaseLevel(value: unknown): value is HarnessCaseLevel {
  return value === "P0" || value === "P1" || value === "P2";
}

function isHarnessScenarioCategory(value: unknown): value is HarnessScenarioCategory {
  return value === "main-flow" || value === "host-authority";
}

function isHarnessFailureStatus(value: unknown): value is HarnessFailureStatus {
  return value === "failed" ||
    value === "not-applicable" ||
    value === "not-observed" ||
    value === "mismatch";
}

function isTranscriptEntryKind(value: unknown): value is TranscriptEntryKind {
  return value === "wire" || value === "runtime";
}

function isTranscriptDirection(value: unknown): value is TranscriptDirection {
  return value === "inbound" || value === "outbound" || value === "internal";
}

function isHarnessStep(value: unknown): value is HarnessStep {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.skipIf !== undefined && typeof value.skipIf !== "string") {
    return false;
  }

  if (value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs < 0)) {
    return false;
  }

  switch (value.type) {
    case "initialize":
    case "session-new":
    case "session-list":
    case "close-session":
      return true;
    case "authenticate":
      return value.authMethod === undefined || typeof value.authMethod === "string";
    case "session-load":
    case "session-resume":
    case "session-fork":
      return typeof value.sessionRef === "string";
    case "session-prompt":
      return typeof value.prompt === "string" &&
        (value.defaultPrompt === undefined || typeof value.defaultPrompt === "string") &&
        (value.turnRef === undefined || typeof value.turnRef === "string");
    case "session-cancel":
      return typeof value.turnRef === "string";
    case "set-mode":
      return typeof value.modeId === "string";
    case "set-config-option":
      return typeof value.key === "string";
    case "permission-decision":
      return (value.decision === "allow" || value.decision === "deny") &&
        (value.requestRef === undefined || typeof value.requestRef === "string");
    case "terminal-output":
    case "terminal-wait-for-exit":
    case "terminal-kill":
    case "terminal-release":
      return typeof value.terminalRef === "string";
    case "wait-for-event":
      return typeof value.eventType === "string";
    default:
      return false;
  }
}

function isHarnessProbeProfile(value: unknown): boolean {
  return isPlainObject(value) &&
    (value.modeId === undefined || typeof value.modeId === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string");
}

function isHarnessAssertion(value: unknown): value is HarnessAssertion {
  if (!isPlainObject(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "transcript-has-method":
      return typeof value.method === "string";
    case "transcript-has-event":
      return typeof value.eventType === "string";
    case "transcript-has-tool-kind":
      return typeof value.kind === "string";
    case "transcript-has-tool-update":
      return typeof value.kind === "string" &&
        (value.status === undefined || typeof value.status === "string");
    case "summary-status":
      return typeof value.path === "string" && isCoverageStatus(value.equals);
    case "transcript-method-response-has":
      return typeof value.method === "string" &&
        typeof value.path === "string" &&
        (value.notEmpty === undefined || typeof value.notEmpty === "boolean");
    case "transcript-event-count":
      return typeof value.eventType === "string" &&
        (value.min === undefined || typeof value.min === "number") &&
        (value.max === undefined || typeof value.max === "number");
    case "transcript-event-field":
      return typeof value.eventType === "string" &&
        typeof value.path === "string" &&
        (value.notEmpty === undefined || typeof value.notEmpty === "boolean");
    case "transcript-order":
      return typeof value.first === "string" && typeof value.then === "string";
    case "any-of":
      return Array.isArray(value.assertions) &&
        value.assertions.length > 0 &&
        value.assertions.every(isHarnessAssertion);
    default:
      return false;
  }
}

function isProtocolCoverageResult(value: unknown): value is ProtocolCoverageResult {
  return isPlainObject(value) &&
    isCoverageStatus(value.status) &&
    typeof value.advertised === "boolean" &&
    typeof value.caseId === "string" &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === "string");
}

function isScenarioResult(value: unknown): value is ScenarioResult {
  return isPlainObject(value) &&
    isCoverageStatus(value.status) &&
    isHarnessCaseLevel(value.level) &&
    isStringArray(value.protocolDependencies) &&
    Array.isArray(value.notes) &&
    value.notes.every((note) => typeof note === "string");
}

function isHarnessDiscoverySummary(value: unknown): value is HarnessDiscoverySummary {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.initialize !== undefined) {
    if (!isPlainObject(value.initialize)) {
      return false;
    }

    if (value.initialize.protocolVersion !== undefined &&
      typeof value.initialize.protocolVersion !== "string" &&
      typeof value.initialize.protocolVersion !== "number") {
      return false;
    }

    if (value.initialize.agentInfo !== undefined) {
      if (!isPlainObject(value.initialize.agentInfo)) {
        return false;
      }

      if (value.initialize.agentInfo.name !== undefined && typeof value.initialize.agentInfo.name !== "string") {
        return false;
      }

      if (value.initialize.agentInfo.version !== undefined &&
        typeof value.initialize.agentInfo.version !== "string") {
        return false;
      }
    }

    if (value.initialize.capabilities !== undefined && !isPlainObject(value.initialize.capabilities)) {
      return false;
    }

    if (value.initialize.authMethods !== undefined) {
      if (!Array.isArray(value.initialize.authMethods)) {
        return false;
      }

      for (const item of value.initialize.authMethods) {
        if (!isPlainObject(item)) {
          return false;
        }

        if (item.id !== undefined && typeof item.id !== "string") {
          return false;
        }

        if (item.name !== undefined && typeof item.name !== "string") {
          return false;
        }

        if (item.description !== undefined && typeof item.description !== "string") {
          return false;
        }
      }
    }
  }

  if (value.session !== undefined) {
    if (!isPlainObject(value.session)) {
      return false;
    }

    if (value.session.id !== undefined && typeof value.session.id !== "string") {
      return false;
    }

    if (value.session.listed !== undefined) {
      if (!Array.isArray(value.session.listed)) {
        return false;
      }

      for (const item of value.session.listed) {
        if (!isPlainObject(item) ||
          typeof item.id !== "string" ||
          (item.cwd !== undefined && typeof item.cwd !== "string") ||
          (item.title !== undefined && typeof item.title !== "string")) {
          return false;
        }
      }
    }
  }

  if (value.auth !== undefined) {
    if (!isPlainObject(value.auth)) {
      return false;
    }

    if (value.auth.authenticated !== undefined && typeof value.auth.authenticated !== "boolean") {
      return false;
    }

    if (value.auth.methodId !== undefined && typeof value.auth.methodId !== "string") {
      return false;
    }
  }

  if (value.plan !== undefined) {
    if (!isPlainObject(value.plan)) {
      return false;
    }

    if (value.plan.entries !== undefined) {
      if (!Array.isArray(value.plan.entries)) {
        return false;
      }

      for (const item of value.plan.entries) {
        if (!isPlainObject(item) ||
          typeof item.content !== "string" ||
          (item.priority !== "high" && item.priority !== "medium" && item.priority !== "low") ||
          (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed")) {
          return false;
        }
      }
    }
  }

  if (value.commands !== undefined) {
    if (!isPlainObject(value.commands)) {
      return false;
    }

    if (value.commands.available !== undefined) {
      if (!Array.isArray(value.commands.available)) {
        return false;
      }

      for (const item of value.commands.available) {
        if (!isPlainObject(item) ||
          typeof item.name !== "string" ||
          typeof item.description !== "string" ||
          (item.inputHint !== undefined && typeof item.inputHint !== "string")) {
          return false;
        }
      }
    }
  }

  if (value.mode !== undefined) {
    if (!isPlainObject(value.mode)) {
      return false;
    }

    if (value.mode.currentModeId !== undefined && typeof value.mode.currentModeId !== "string") {
      return false;
    }

    if (value.mode.availableModes !== undefined) {
      if (!Array.isArray(value.mode.availableModes)) {
        return false;
      }

      for (const item of value.mode.availableModes) {
        if (!isPlainObject(item) ||
          typeof item.id !== "string" ||
          (item.name !== undefined && typeof item.name !== "string") ||
          (item.description !== undefined && typeof item.description !== "string")) {
          return false;
        }
      }
    }
  }

  if (value.permission !== undefined) {
    if (!isPlainObject(value.permission)) {
      return false;
    }

    if (value.permission.deniedFamilies !== undefined) {
      if (!Array.isArray(value.permission.deniedFamilies)) {
        return false;
      }

      for (const item of value.permission.deniedFamilies) {
        if (
          item !== "mode_denied" &&
          item !== "permission_request_cancelled" &&
          item !== "permission_request_end_turn"
        ) {
          return false;
        }
      }
    }

    if (
      value.permission.requestObserved !== undefined &&
      typeof value.permission.requestObserved !== "boolean"
    ) {
      return false;
    }
  }

  return true;
}

export function isHarnessCase(value: unknown): value is HarnessCase {
  return isPlainObject(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    isHarnessCaseKind(value.kind) &&
    typeof value.title === "string" &&
    (value.scenarioCategory === undefined || isHarnessScenarioCategory(value.scenarioCategory)) &&
    (value.agents === undefined || isHarnessAgentFilter(value.agents)) &&
    (value.level === undefined || isHarnessCaseLevel(value.level)) &&
    isStringArray(value.protocolDependencies) &&
    (value.capabilities === undefined || isStringArray(value.capabilities)) &&
    (value.retries === undefined ||
      (isPlainObject(value.retries) &&
        typeof value.retries.count === "number" &&
        Number.isInteger(value.retries.count) &&
        value.retries.count >= 0 &&
        Array.isArray(value.retries.onStatuses) &&
        value.retries.onStatuses.every(isHarnessFailureStatus))) &&
    (value.classification === undefined ||
      (isPlainObject(value.classification) &&
        Object.values(value.classification).every((entry) =>
          isPlainObject(entry) &&
          (entry.assertionFailureStatus === undefined || isHarnessFailureStatus(entry.assertionFailureStatus)) &&
          (entry.timeoutStatus === undefined || isHarnessFailureStatus(entry.timeoutStatus)) &&
          (entry.executionErrorStatus === undefined || isHarnessFailureStatus(entry.executionErrorStatus))
        ))) &&
    (value.probes === undefined ||
      (isPlainObject(value.probes) &&
        Object.values(value.probes).every((entry) => isHarnessProbeProfile(entry)))) &&
    Array.isArray(value.steps) &&
    value.steps.every(isHarnessStep) &&
    Array.isArray(value.assertions) &&
    value.assertions.every(isHarnessAssertion);
}

export function parseHarnessCase(value: unknown): HarnessCase {
  if (!isHarnessCase(value)) {
    throw new Error("Invalid harness case");
  }

  return value;
}

export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return isPlainObject(value) &&
    typeof value.timestamp === "string" &&
    isTranscriptEntryKind(value.kind) &&
    isTranscriptDirection(value.direction) &&
    typeof value.type === "string" &&
    (value.method === undefined || typeof value.method === "string") &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.turnId === undefined || typeof value.turnId === "string");
}

export function parseTranscriptEntry(value: unknown): TranscriptEntry {
  if (!isTranscriptEntry(value)) {
    throw new Error("Invalid transcript entry");
  }

  return value;
}

export function isHarnessSummary(value: unknown): value is HarnessSummary {
  if (!isPlainObject(value) || typeof value.agent !== "string" || typeof value.timestamp !== "string") {
    return false;
  }

  if (value.protocolCoverage !== undefined) {
    if (!isPlainObject(value.protocolCoverage)) {
      return false;
    }

    for (const item of Object.values(value.protocolCoverage)) {
      if (!isProtocolCoverageResult(item)) {
        return false;
      }
    }
  }

  if (value.scenarioResults !== undefined) {
    if (!isPlainObject(value.scenarioResults)) {
      return false;
    }

    for (const item of Object.values(value.scenarioResults)) {
      if (!isScenarioResult(item)) {
        return false;
      }
    }
  }

  if (value.discovery !== undefined && !isHarnessDiscoverySummary(value.discovery)) {
    return false;
  }

  return true;
}

export function parseHarnessSummary(value: unknown): HarnessSummary {
  if (!isHarnessSummary(value)) {
    throw new Error("Invalid harness summary");
  }

  return value;
}
