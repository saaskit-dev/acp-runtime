export type HarnessCaseKind = "protocol" | "interaction" | "scenario";

export type HarnessCaseLevel = "P0" | "P1" | "P2";

export type TranscriptDirection = "inbound" | "outbound" | "internal";

export type TranscriptEntryKind = "wire" | "runtime";

export type CoverageStatus = "PASS" | "FAIL" | "N/A" | "MISSING" | "MISMATCH" | "NOT_OBSERVED";

export type HarnessFailureStatus = "failed" | "not-applicable" | "not-observed" | "mismatch";

export type HarnessProbeProfile = {
  modeId?: string;
  prompt?: string;
};

/**
 * `skipIf` — optional condition to skip a step at runtime.
 *
 * Supported expressions (evaluated against capabilities discovered during initialize):
 *   "!capabilities.setMode"       — skip if setMode is not supported
 *   "!capabilities.sessionLoad"   — skip if sessionLoad is not supported
 *   "!capabilities.sessionResume" — skip if sessionResume is not supported
 *   "!modes"                      — skip if no modes were discovered
 *   "!authMethods"                — skip if no auth methods were returned
 *
 * When a step is skipped, it emits a "step-skipped" runtime event and does not
 * count as a failure. The case continues with the next step.
 */
type StepSkipCondition = string;

type StepCommon = {
  skipIf?: StepSkipCondition;
  /** Per-step timeout in ms. Overrides the global STEP_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type HarnessStep =
  | ({ type: "initialize" } & StepCommon)
  | ({ type: "authenticate"; authMethod?: string } & StepCommon)
  | ({ type: "session-new" } & StepCommon)
  | ({ type: "session-load"; sessionRef: string } & StepCommon)
  | ({ type: "session-resume"; sessionRef: string } & StepCommon)
  | ({ type: "session-fork"; sessionRef: string } & StepCommon)
  | ({ type: "session-list" } & StepCommon)
  | ({ type: "session-prompt"; prompt: string; defaultPrompt?: string; turnRef?: string } & StepCommon)
  | ({ type: "session-cancel"; turnRef: string } & StepCommon)
  | ({ type: "set-mode"; modeId: string } & StepCommon)
  | ({ type: "set-config-option"; key: string; value: unknown } & StepCommon)
  | ({ type: "permission-decision"; decision: "allow" | "deny"; requestRef?: string } & StepCommon)
  | ({ type: "terminal-output"; terminalRef: string } & StepCommon)
  | ({ type: "terminal-wait-for-exit"; terminalRef: string } & StepCommon)
  | ({ type: "terminal-kill"; terminalRef: string } & StepCommon)
  | ({ type: "terminal-release"; terminalRef: string } & StepCommon)
  | ({ type: "wait-for-event"; eventType: string } & StepCommon)
  | ({ type: "close-session" } & StepCommon);

export type HarnessAssertion =
  | { type: "transcript-has-method"; method: string }
  | { type: "transcript-has-event"; eventType: string }
  | { type: "summary-status"; path: string; equals: CoverageStatus }
  /** Check that a method's response contains a specific field (dot-path). */
  | { type: "transcript-method-response-has"; method: string; path: string; notEmpty?: boolean }
  /** Check that an event type appears at least `min` times (default 1). */
  | { type: "transcript-event-count"; eventType: string; min?: number; max?: number }
  /** Check that a specific field value exists in any event of the given type. */
  | { type: "transcript-event-field"; eventType: string; path: string; equals?: unknown; notEmpty?: boolean }
  /** Check that method A appears before method B in the transcript. */
  | { type: "transcript-order"; first: string; then: string };

export type HarnessCase = {
  version: 1;
  id: string;
  kind: HarnessCaseKind;
  title: string;
  description: string;
  level?: HarnessCaseLevel;
  protocolDependencies: string[];
  capabilities?: string[];
  retries?: {
    count: number;
    onStatuses: HarnessFailureStatus[];
  };
  classification?: Record<string, HarnessClassification>;
  probes?: Record<string, HarnessProbeProfile>;
  steps: HarnessStep[];
  assertions: HarnessAssertion[];
};

export type HarnessClassification = {
  assertionFailureStatus?: HarnessFailureStatus;
  timeoutStatus?: HarnessFailureStatus;
  executionErrorStatus?: HarnessFailureStatus;
};

export type HarnessAgentDefinition = {
  id: string;
  displayName: string;
};

export type HarnessRunStatus = "passed" | HarnessFailureStatus;

export type HarnessRuntimeEvent = {
  type:
    | "run-started"
    | "run-completed"
    | "step-started"
    | "step-completed"
    | "step-skipped"
    | "assertion-passed"
    | "assertion-failed";
  caseId: string;
  agentId: string;
  stepType?: string;
  details?: Record<string, unknown>;
};

export type TranscriptEntry = {
  timestamp: string;
  kind: TranscriptEntryKind;
  direction: TranscriptDirection;
  type: string;
  method?: string;
  sessionId?: string;
  turnId?: string;
  payload?: unknown;
};

export type ProtocolCoverageResult = {
  status: CoverageStatus;
  advertised: boolean;
  caseId: string;
  notes: string[];
};

export type ScenarioResult = {
  status: CoverageStatus;
  level: HarnessCaseLevel;
  protocolDependencies: string[];
  notes: string[];
};

export type HarnessDiscoverySummary = {
  initialize?: {
    protocolVersion?: number | string;
    agentInfo?: {
      name?: string;
      version?: string;
    };
    capabilities?: Record<string, unknown>;
    authMethods?: Array<{
      id?: string;
      name?: string;
      description?: string;
    }>;
  };
  session?: {
    id?: string;
    listed?: Array<{
      id: string;
      cwd?: string;
      title?: string;
    }>;
  };
  auth?: {
    authenticated?: boolean;
    methodId?: string;
  };
  plan?: {
    entries?: Array<{
      content: string;
      priority: "high" | "medium" | "low";
      status: "pending" | "in_progress" | "completed";
    }>;
  };
  commands?: {
    available?: Array<{
      name: string;
      description: string;
      inputHint?: string;
    }>;
  };
  mode?: {
    currentModeId?: string;
    availableModes?: Array<{
      id: string;
      name?: string;
      description?: string;
    }>;
  };
};

export type HarnessSummary = {
  agent: string;
  timestamp: string;
  protocolCoverage?: Record<string, ProtocolCoverageResult>;
  scenarioResults?: Record<string, ScenarioResult>;
  discovery?: HarnessDiscoverySummary;
};

export type HarnessRunResult = {
  status: HarnessRunStatus;
  caseId: string;
  agentId: string;
  transcript: TranscriptEntry[];
  summaryPatch: Partial<HarnessSummary>;
  notes: string[];
};
