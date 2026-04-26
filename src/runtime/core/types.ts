import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./constants.js";
import type {
  AcpError,
  AcpTurnCancelledError,
  AcpTurnCoalescedError,
  AcpTurnWithdrawnError,
} from "./errors.js";

type ValueOf<T> = T[keyof T];

export const AcpRuntimeObservabilityCaptureContent = {
  Full: "full",
  None: "none",
  Summary: "summary",
} as const;

export const AcpRuntimeObservabilityRedactionKind = {
  AssistantOutput: "assistant_output",
  AssistantThought: "assistant_thought",
  DiffNewText: "diff_new_text",
  DiffOldText: "diff_old_text",
  Plan: "plan",
  Prompt: "prompt",
  ProtocolMessage: "protocol_message",
  TerminalOutput: "terminal_output",
  ToolRawInput: "tool_raw_input",
  ToolRawOutput: "tool_raw_output",
} as const;

export const AcpRuntimeMcpTransportType = {
  Http: "http",
  Sse: "sse",
  Stdio: "stdio",
} as const;

export const AcpRuntimeContentPartType = {
  Audio: "audio",
  File: "file",
  Image: "image",
  Json: "json",
  Resource: "resource",
  Text: "text",
} as const;

export const AcpRuntimePromptMessageRole = {
  Assistant: "assistant",
  Developer: "developer",
  System: "system",
  Tool: "tool",
  User: "user",
} as const;

export const AcpRuntimePlanPriority = {
  High: "high",
  Low: "low",
  Medium: "medium",
} as const;

export const AcpRuntimePlanStatus = {
  Completed: "completed",
  InProgress: "in_progress",
  Pending: "pending",
} as const;

export const AcpRuntimeOperationKind = {
  DocumentEdit: "document_edit",
  ExecuteCommand: "execute_command",
  McpCall: "mcp_call",
  NetworkRequest: "network_request",
  ReadFile: "read_file",
  Unknown: "unknown",
  WriteFile: "write_file",
} as const;

export const AcpRuntimeOperationPhase = {
  AwaitingPermission: "awaiting_permission",
  Cancelled: "cancelled",
  Completed: "completed",
  Failed: "failed",
  Proposed: "proposed",
  Running: "running",
} as const;

export const AcpRuntimeOperationTargetType = {
  Command: "command",
  Endpoint: "endpoint",
  McpTool: "mcp_tool",
  Path: "path",
  Unknown: "unknown",
} as const;

export const AcpRuntimeOperationFailureReason = {
  Cancelled: "cancelled",
  Failed: "failed",
  PermissionDenied: "permission_denied",
  Timeout: "timeout",
} as const;

export const AcpRuntimeOperationPermissionFamily = {
  ModeDenied: "mode_denied",
  PermissionRequestCancelled: "permission_request_cancelled",
  PermissionRequestEndTurn: "permission_request_end_turn",
} as const;

export const AcpRuntimePermissionKind = {
  Document: "document",
  Filesystem: "filesystem",
  Mcp: "mcp",
  Network: "network",
  Terminal: "terminal",
  Unknown: "unknown",
} as const;

export const AcpRuntimePermissionScope = {
  Once: "once",
  Session: "session",
} as const;

export const AcpRuntimePermissionDecisionValue = {
  Allow: "allow",
  Deny: "deny",
} as const;

export const AcpRuntimePermissionResolution = {
  Allowed: "allowed",
  Denied: "denied",
} as const;

export const AcpRuntimePermissionRequestPhase = {
  Allowed: "allowed",
  Denied: "denied",
  Pending: "pending",
} as const;

export const AcpRuntimeAuthenticationMethodType = {
  Agent: "agent",
  EnvVar: "env_var",
  Terminal: "terminal",
} as const;

export const AcpRuntimeAgentConfigOptionType = {
  Boolean: "boolean",
  Number: "number",
  Select: "select",
  String: "string",
} as const;

export const AcpRuntimeThreadEntryKind = {
  AssistantMessage: "assistant_message",
  AssistantThought: "assistant_thought",
  Plan: "plan",
  ToolCall: "tool_call",
  UserMessage: "user_message",
} as const;

export const AcpRuntimeThreadEntryStatus = {
  Completed: "completed",
  Failed: "failed",
  InProgress: "in_progress",
  Pending: "pending",
  Streaming: "streaming",
} as const;

export const AcpRuntimeThreadToolContentKind = {
  Content: "content",
  Diff: "diff",
  Terminal: "terminal",
} as const;

export const AcpRuntimeChangeType = {
  Update: "update",
  Write: "write",
} as const;

export const AcpRuntimeTerminalStatus = {
  Completed: "completed",
  Running: "running",
  Unknown: "unknown",
} as const;

export const AcpRuntimeSessionListSource = {
  All: "all",
  Local: "local",
  Remote: "remote",
} as const;

export const AcpRuntimeSessionReferenceSource = {
  Both: "both",
  Local: "local",
  Remote: "remote",
} as const;

export const AcpRuntimeStoredSessionUpdateType = {
  Refresh: "refresh",
  SessionDeleted: "session_deleted",
  SessionSaved: "session_saved",
} as const;

export const AcpRuntimeReadModelUpdateType = {
  DiffUpdated: "diff_updated",
  TerminalUpdated: "terminal_updated",
  ThreadEntryAdded: "thread_entry_added",
  ThreadEntryUpdated: "thread_entry_updated",
} as const;

export const AcpRuntimeProjectionUpdateType = {
  MetadataUpdated: "metadata_projection_updated",
  OperationUpdated: "operation_projection_updated",
  PermissionUpdated: "permission_projection_updated",
  UsageUpdated: "usage_projection_updated",
} as const;

export const AcpRuntimeOperationProjectionLifecycle = {
  Completed: "completed",
  Failed: "failed",
  Started: "started",
  Updated: "updated",
} as const;

export const AcpRuntimePermissionProjectionLifecycle = {
  Requested: "requested",
  Resolved: "resolved",
} as const;

export const AcpRuntimeSessionStatus = {
  Closed: "closed",
  Ready: "ready",
  Running: "running",
} as const;

export const AcpRuntimeQueueDelivery = {
  Coalesce: "coalesce",
  Sequential: "sequential",
} as const;

export const AcpRuntimeQueuedTurnStatus = {
  Queued: "queued",
  Ready: "ready",
} as const;

export const AcpRuntimeTurnEventType = {
  Cancelled: "cancelled",
  Coalesced: "coalesced",
  Completed: "completed",
  Failed: "failed",
  MetadataUpdated: "metadata_updated",
  OperationCompleted: "operation_completed",
  OperationFailed: "operation_failed",
  OperationStarted: "operation_started",
  OperationUpdated: "operation_updated",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PlanUpdated: "plan_updated",
  Queued: "queued",
  Started: "started",
  Text: "text",
  Thinking: "thinking",
  UsageUpdated: "usage_updated",
  Withdrawn: "withdrawn",
} as const;

export type AcpRuntimeAgent = {
  args?: string[];
  command: string;
  env?: Record<string, string | undefined>;
  type?: string;
};

export type AcpRuntimeAgentInput = AcpRuntimeAgent | string;

export type AcpRuntimeAgentResolver = (
  agentId: string,
) => Promise<AcpRuntimeAgent>;

export type AcpRuntimeObservabilityCaptureContent = ValueOf<
  typeof AcpRuntimeObservabilityCaptureContent
>;

export type AcpRuntimeObservabilityRedactionKind = ValueOf<
  typeof AcpRuntimeObservabilityRedactionKind
>;

export type AcpRuntimeObservabilityRedactionContext = {
  kind: AcpRuntimeObservabilityRedactionKind;
  operationId?: string;
  path?: string;
  sessionId?: string;
  terminalId?: string;
  toolCallId?: string;
  turnId?: string;
};

export type AcpRuntimeObservabilityOptions = {
  captureContent?: AcpRuntimeObservabilityCaptureContent;
  redact?: (
    value: unknown,
    context: AcpRuntimeObservabilityRedactionContext,
  ) => unknown;
};

export type AcpRuntimeMcpTransportType = ValueOf<
  typeof AcpRuntimeMcpTransportType
>;

export type AcpRuntimeMcpServer =
  | {
      headers?: Record<string, string>;
      name: string;
      transport: {
        type:
          | typeof AcpRuntimeMcpTransportType.Http
          | typeof AcpRuntimeMcpTransportType.Sse;
        url: string;
      };
    }
  | {
      name: string;
      transport: {
        args?: string[];
        command: string;
        cwd?: string;
        env?: Record<string, string | undefined>;
        type: typeof AcpRuntimeMcpTransportType.Stdio;
      };
    };

export type AcpRuntimeContentPartType = ValueOf<
  typeof AcpRuntimeContentPartType
>;

export type AcpRuntimeContentPart =
  | {
      text: string;
      type: typeof AcpRuntimeContentPartType.Text;
    }
  | {
      mediaType?: string;
      title?: string;
      type: typeof AcpRuntimeContentPartType.File;
      uri: string;
    }
  | {
      alt?: string;
      mediaType?: string;
      type: typeof AcpRuntimeContentPartType.Image;
      uri: string;
    }
  | {
      data: string;
      mediaType: string;
      title?: string;
      type: typeof AcpRuntimeContentPartType.Audio;
    }
  | {
      mediaType?: string;
      text?: string;
      title?: string;
      type: typeof AcpRuntimeContentPartType.Resource;
      uri: string;
      value?: unknown;
    }
  | {
      type: typeof AcpRuntimeContentPartType.Json;
      value: unknown;
    };

export type AcpRuntimePromptPart = AcpRuntimeContentPart;

export type AcpRuntimePromptMessageRole = ValueOf<
  typeof AcpRuntimePromptMessageRole
>;

export type AcpRuntimePromptMessage = {
  content: string | readonly AcpRuntimePromptPart[];
  role: AcpRuntimePromptMessageRole;
};

export type AcpRuntimePrompt =
  | string
  | readonly AcpRuntimePromptPart[]
  | readonly AcpRuntimePromptMessage[];

export type AcpRuntimePlanPriority = ValueOf<
  typeof AcpRuntimePlanPriority
>;

export type AcpRuntimePlanStatus = ValueOf<typeof AcpRuntimePlanStatus>;

export type AcpRuntimePlanItem = {
  content: string;
  id?: string;
  priority: AcpRuntimePlanPriority;
  status: AcpRuntimePlanStatus;
};

export type AcpRuntimeOperationKind = ValueOf<
  typeof AcpRuntimeOperationKind
>;

export type AcpRuntimeOperationPhase = ValueOf<
  typeof AcpRuntimeOperationPhase
>;

export type AcpRuntimeOperationTargetType = ValueOf<
  typeof AcpRuntimeOperationTargetType
>;

export type AcpRuntimeOperationTarget = {
  type: AcpRuntimeOperationTargetType;
  value: string;
};

export type AcpRuntimeOperationProgress = {
  completed?: number;
  summary?: string;
  total?: number;
  unit?: "bytes" | "items" | "steps";
};

export type AcpRuntimeOperationResult = {
  output?: readonly AcpRuntimeOutputPart[];
  outputText?: string;
  summary?: string;
};

export type AcpRuntimeOperationFailureReason = ValueOf<
  typeof AcpRuntimeOperationFailureReason
>;

export type AcpRuntimeOperationPermissionFamily = ValueOf<
  typeof AcpRuntimeOperationPermissionFamily
>;

export type AcpRuntimeOperationPermission = {
  decision?: AcpRuntimePermissionResolution;
  family?: AcpRuntimeOperationPermissionFamily;
  requestId?: string;
  requested: boolean;
};

export type AcpRuntimeOperation = {
  completedAt?: string;
  failureReason?: AcpRuntimeOperationFailureReason;
  id: string;
  kind: AcpRuntimeOperationKind;
  phase: AcpRuntimeOperationPhase;
  permission?: AcpRuntimeOperationPermission;
  progress?: AcpRuntimeOperationProgress;
  result?: AcpRuntimeOperationResult;
  startedAt?: string;
  summary?: string;
  target?: AcpRuntimeOperationTarget;
  title: string;
  turnId: string;
  updatedAt?: string;
};

export type AcpRuntimePermissionKind = ValueOf<
  typeof AcpRuntimePermissionKind
>;

export type AcpRuntimePermissionScope = ValueOf<
  typeof AcpRuntimePermissionScope
>;

export type AcpRuntimePermissionResolution = ValueOf<
  typeof AcpRuntimePermissionResolution
>;

export type AcpRuntimePermissionDecisionValue = ValueOf<
  typeof AcpRuntimePermissionDecisionValue
>;

export type AcpRuntimePermissionRequestPhase = ValueOf<
  typeof AcpRuntimePermissionRequestPhase
>;

export type AcpRuntimePermissionRequest = {
  id: string;
  kind: AcpRuntimePermissionKind;
  operationId: string;
  phase: AcpRuntimePermissionRequestPhase;
  reason?: string;
  scopeOptions: readonly AcpRuntimePermissionScope[];
  title: string;
  turnId: string;
};

export type AcpRuntimePermissionDecision =
  | {
      decision: typeof AcpRuntimePermissionDecisionValue.Allow;
      scope?: AcpRuntimePermissionScope;
    }
  | {
      decision: typeof AcpRuntimePermissionDecisionValue.Deny;
    };

export type AcpRuntimePermissionHandler = (
  request: AcpRuntimePermissionRequest,
) => Promise<AcpRuntimePermissionDecision> | AcpRuntimePermissionDecision;

export type AcpRuntimeAuthenticationMethodMeta = Readonly<
  Record<string, unknown>
>;

export type AcpRuntimeAuthenticationMethodBase = {
  description?: string;
  id: string;
  meta?: AcpRuntimeAuthenticationMethodMeta;
  title: string;
};

export type AcpRuntimeAuthenticationMethodType = ValueOf<
  typeof AcpRuntimeAuthenticationMethodType
>;

export type AcpRuntimeAuthenticationEnvVar = {
  label?: string;
  name: string;
  optional?: boolean;
  secret?: boolean;
};

export type AcpRuntimeAgentAuthenticationMethod =
  AcpRuntimeAuthenticationMethodBase & {
    type: typeof AcpRuntimeAuthenticationMethodType.Agent;
  };

export type AcpRuntimeEnvVarAuthenticationMethod =
  AcpRuntimeAuthenticationMethodBase & {
    link?: string;
    type: typeof AcpRuntimeAuthenticationMethodType.EnvVar;
    vars: readonly AcpRuntimeAuthenticationEnvVar[];
  };

export type AcpRuntimeTerminalAuthenticationMethod =
  AcpRuntimeAuthenticationMethodBase & {
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    type: typeof AcpRuntimeAuthenticationMethodType.Terminal;
  };

export type AcpRuntimeAuthenticationMethod =
  | AcpRuntimeAgentAuthenticationMethod
  | AcpRuntimeEnvVarAuthenticationMethod
  | AcpRuntimeTerminalAuthenticationMethod;

export type AcpRuntimeTerminalAuthenticationRequest = {
  args: readonly string[];
  command: string;
  env?: Readonly<Record<string, string>>;
  label: string;
  methodId: string;
};

export type AcpRuntimeAgentInfo = {
  name: string;
  title?: string;
  vendor?: string;
  version?: string;
};

export type AcpRuntimeAgentCapabilities = {
  authentication?: boolean;
  load?: boolean;
  mcp?: boolean;
  prompt?: boolean;
  resume?: boolean;
  sessionList?: boolean;
  terminal?: boolean;
};

export type AcpRuntimeClientCapabilities = {
  authentication?: boolean;
  filesystem?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  mcp?: boolean;
  terminal?: boolean;
};

export type AcpRuntimeCapabilities = {
  agent: AcpRuntimeAgentCapabilities;
  agentInfo?: AcpRuntimeAgentInfo;
  authMethods?: readonly AcpRuntimeAuthenticationMethod[];
  client: AcpRuntimeClientCapabilities;
};

export type AcpRuntimeAuthenticationHandler = (request: {
  agent: AcpRuntimeAgent;
  methods: readonly AcpRuntimeAuthenticationMethod[];
}) =>
  | Promise<{ methodId: string } | { cancel: true }>
  | { cancel: true }
  | { methodId: string };

export type AcpRuntimeFilesystemHandler = {
  readTextFile(path: string): Promise<string>;
  writeTextFile(input: { content: string; path: string }): Promise<void>;
};

export type AcpRuntimeTerminalStartRequest = {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type AcpRuntimeTerminalHandler = {
  kill(terminalId: string): Promise<void>;
  output(terminalId: string): Promise<{
    exitCode: number | null;
    output: string;
    truncated: boolean;
  }>;
  release(terminalId: string): Promise<void>;
  start(
    request: AcpRuntimeTerminalStartRequest,
  ): Promise<{ terminalId: string }>;
  wait(terminalId: string): Promise<{ exitCode: number }>;
};

export type AcpRuntimeAuthorityHandlers = {
  authentication?: AcpRuntimeAuthenticationHandler;
  filesystem?: AcpRuntimeFilesystemHandler;
  permission?: AcpRuntimePermissionHandler;
  terminal?: AcpRuntimeTerminalHandler;
};

export type AcpRuntimeReasoningLevel = "high" | "low" | "medium";

export type AcpRuntimeAvailableCommand = {
  description?: string;
  name: string;
};

export type AcpRuntimeConfigValue = boolean | number | string;

export type AcpRuntimeAgentConfigOptionType = ValueOf<
  typeof AcpRuntimeAgentConfigOptionType
>;

export type AcpRuntimeAgentMode = {
  description?: string;
  id: string;
  name: string;
};

export type AcpRuntimeAgentConfigOptionChoice = {
  description?: string;
  name: string;
  value: AcpRuntimeConfigValue;
};

export type AcpRuntimeAgentConfigOption = {
  category?: string;
  description?: string;
  id: string;
  name: string;
  options?: readonly AcpRuntimeAgentConfigOptionChoice[];
  type: AcpRuntimeAgentConfigOptionType;
  value: AcpRuntimeConfigValue;
};

export type AcpRuntimeSessionMetadata = {
  availableCommands?: readonly AcpRuntimeAvailableCommand[];
  agentConfigOptions?: readonly AcpRuntimeAgentConfigOption[];
  agentModes?: readonly AcpRuntimeAgentMode[];
  config?: Readonly<Record<string, AcpRuntimeConfigValue>>;
  currentModeId?: string;
  id: string;
  title?: string;
};

export type AcpRuntimeUsage = {
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type AcpRuntimeHistoryEntry =
  | {
      text: string;
      type: typeof AcpRuntimePromptMessageRole.User;
    }
  | AcpRuntimeTurnEvent;

export type AcpRuntimeThreadEntryKind = ValueOf<
  typeof AcpRuntimeThreadEntryKind
>;

export type AcpRuntimeThreadEntryStatus = ValueOf<
  typeof AcpRuntimeThreadEntryStatus
>;

export type AcpRuntimeThreadEntry =
  | {
      id: string;
      kind: typeof AcpRuntimeThreadEntryKind.AssistantMessage;
      output?: readonly AcpRuntimeOutputPart[];
      status:
        | typeof AcpRuntimeThreadEntryStatus.Completed
        | typeof AcpRuntimeThreadEntryStatus.Failed
        | typeof AcpRuntimeThreadEntryStatus.Streaming;
      text: string;
      turnId: string;
    }
  | {
      id: string;
      kind: typeof AcpRuntimeThreadEntryKind.AssistantThought;
      status:
        | typeof AcpRuntimeThreadEntryStatus.Completed
        | typeof AcpRuntimeThreadEntryStatus.Failed
        | typeof AcpRuntimeThreadEntryStatus.Streaming;
      text: string;
      turnId: string;
    }
  | {
      id: string;
      kind: typeof AcpRuntimeThreadEntryKind.Plan;
      plan: readonly AcpRuntimePlanItem[];
      turnId: string;
    }
  | {
      content: readonly AcpRuntimeThreadToolContent[];
      id: string;
      kind: typeof AcpRuntimeThreadEntryKind.ToolCall;
      locations?: readonly AcpRuntimeThreadToolLocation[];
      rawInput?: unknown;
      rawOutput?: unknown;
      status:
        | typeof AcpRuntimeThreadEntryStatus.Completed
        | typeof AcpRuntimeThreadEntryStatus.Failed
        | typeof AcpRuntimeThreadEntryStatus.InProgress
        | typeof AcpRuntimeThreadEntryStatus.Pending;
      title: string;
      toolCallId: string;
      toolKind?: string;
      turnId: string;
    }
  | {
      id: string;
      kind: typeof AcpRuntimeThreadEntryKind.UserMessage;
      text: string;
      turnId?: string;
    };

export type AcpRuntimeToolCallSnapshot = Extract<
  AcpRuntimeThreadEntry,
  { kind: typeof AcpRuntimeThreadEntryKind.ToolCall }
>;

export type AcpRuntimeThreadToolLocation = {
  line?: number;
  path: string;
};

export type AcpRuntimeChangeType = ValueOf<typeof AcpRuntimeChangeType>;

export type AcpRuntimeDiffSnapshot = {
  changeType: AcpRuntimeChangeType;
  createdAt: string;
  newLineCount: number;
  newText: string;
  oldLineCount?: number;
  oldText?: string;
  path: string;
  revision: number;
  toolCallId?: string;
  updatedAt: string;
};

export type AcpRuntimeTerminalStatus = ValueOf<
  typeof AcpRuntimeTerminalStatus
>;

export type AcpRuntimeTerminalSnapshot = {
  completedAt?: string;
  command?: string;
  createdAt: string;
  cwd?: string;
  exitCode?: number | null;
  outputLength?: number;
  outputLineCount?: number;
  output?: string;
  releasedAt?: string;
  revision: number;
  status: AcpRuntimeTerminalStatus;
  stopRequestedAt?: string;
  terminalId: string;
  toolCallId?: string;
  truncated?: boolean;
  updatedAt: string;
};

export type AcpRuntimeThreadToolContentKind = ValueOf<
  typeof AcpRuntimeThreadToolContentKind
>;

export type AcpRuntimeThreadToolContent =
  | {
      changeType: AcpRuntimeChangeType;
      id: string;
      kind: typeof AcpRuntimeThreadToolContentKind.Diff;
      newText: string;
      oldText?: string;
      path: string;
    }
  | {
      id: string;
      kind: typeof AcpRuntimeThreadToolContentKind.Content;
      label?: string;
      part?: AcpRuntimeOutputPart;
      text?: string;
    }
  | {
      command?: string;
      cwd?: string;
      exitCode?: number | null;
      id: string;
      kind: typeof AcpRuntimeThreadToolContentKind.Terminal;
      output?: string;
      status: AcpRuntimeTerminalStatus;
      truncated?: boolean;
      terminalId: string;
    };

export type AcpRuntimeDiagnostics = {
  lastError?: {
    code: string;
    message: string;
  };
  lastUsage?: AcpRuntimeUsage;
};

export type AcpRuntimeSessionReference = {
  agentType?: string;
  cwd: string;
  id: string;
  source?: AcpRuntimeSessionReferenceSource;
  title?: string;
  updatedAt?: string;
};

export type AcpRuntimeSessionList = {
  nextCursor?: string;
  sessions: readonly AcpRuntimeSessionReference[];
};

export type AcpRuntimeRegistryListOptions = {
  agentType?: string;
  cursor?: string;
  cwd?: string;
  limit?: number;
};

export type AcpRuntimeSessionReferenceSource = ValueOf<
  typeof AcpRuntimeSessionReferenceSource
>;

export type AcpRuntimeStoredSessionUpdateType = ValueOf<
  typeof AcpRuntimeStoredSessionUpdateType
>;

export type AcpRuntimeStoredSessionDeletedUpdate = {
  sessionId: string;
  type: typeof AcpRuntimeStoredSessionUpdateType.SessionDeleted;
};

export type AcpRuntimeStoredSessionRefreshUpdate = {
  type: typeof AcpRuntimeStoredSessionUpdateType.Refresh;
};

export type AcpRuntimeStoredSessionSavedUpdate = {
  session: AcpRuntimeSessionReference;
  type: typeof AcpRuntimeStoredSessionUpdateType.SessionSaved;
};

export type AcpRuntimeStoredSessionListUpdate =
  | AcpRuntimeStoredSessionDeletedUpdate
  | AcpRuntimeStoredSessionRefreshUpdate
  | AcpRuntimeStoredSessionSavedUpdate;

export type AcpRuntimeStoredSessionWatcher = (
  update: AcpRuntimeStoredSessionListUpdate,
) => void;

export type AcpRuntimeReadModelUpdateType = ValueOf<
  typeof AcpRuntimeReadModelUpdateType
>;

export type AcpRuntimeThreadEntryAddedUpdate = {
  entry: AcpRuntimeThreadEntry;
  type: typeof AcpRuntimeReadModelUpdateType.ThreadEntryAdded;
};

export type AcpRuntimeThreadEntryUpdatedUpdate = {
  entry: AcpRuntimeThreadEntry;
  type: typeof AcpRuntimeReadModelUpdateType.ThreadEntryUpdated;
};

export type AcpRuntimeTerminalUpdatedUpdate = {
  terminal: AcpRuntimeTerminalSnapshot;
  type: typeof AcpRuntimeReadModelUpdateType.TerminalUpdated;
};

export type AcpRuntimeDiffUpdatedUpdate = {
  diff: AcpRuntimeDiffSnapshot;
  type: typeof AcpRuntimeReadModelUpdateType.DiffUpdated;
};

export type AcpRuntimeReadModelUpdate =
  | AcpRuntimeDiffUpdatedUpdate
  | AcpRuntimeTerminalUpdatedUpdate
  | AcpRuntimeThreadEntryAddedUpdate
  | AcpRuntimeThreadEntryUpdatedUpdate;

export type AcpRuntimeReadModelWatcher = (
  update: AcpRuntimeReadModelUpdate,
) => void;

export type AcpRuntimeDiffWatcher = (diff: AcpRuntimeDiffSnapshot) => void;

export type AcpRuntimeTerminalWatcher = (
  terminal: AcpRuntimeTerminalSnapshot,
) => void;

export type AcpRuntimeToolObjectUpdate =
  | AcpRuntimeDiffUpdatedUpdate
  | AcpRuntimeTerminalUpdatedUpdate;

export type AcpRuntimeToolObjectWatcher = (
  update: AcpRuntimeToolObjectUpdate,
) => void;

export type AcpRuntimeToolCallBundle = {
  diffs: readonly AcpRuntimeDiffSnapshot[];
  terminals: readonly AcpRuntimeTerminalSnapshot[];
  toolCall: AcpRuntimeToolCallSnapshot;
};

export type AcpRuntimeToolCallWatcher = (
  bundle: AcpRuntimeToolCallBundle,
) => void;

export type AcpRuntimeOperationBundle = {
  operation: AcpRuntimeOperation;
  permissionRequests: readonly AcpRuntimePermissionRequest[];
};

export type AcpRuntimeOperationWatcher = (
  operation: AcpRuntimeOperation,
) => void;

export type AcpRuntimeOperationBundleWatcher = (
  bundle: AcpRuntimeOperationBundle,
) => void;

export type AcpRuntimePermissionRequestWatcher = (
  request: AcpRuntimePermissionRequest,
) => void;

export type AcpRuntimeProjectionUpdateType = ValueOf<
  typeof AcpRuntimeProjectionUpdateType
>;

export type AcpRuntimeOperationProjectionLifecycle = ValueOf<
  typeof AcpRuntimeOperationProjectionLifecycle
>;

export type AcpRuntimePermissionProjectionLifecycle = ValueOf<
  typeof AcpRuntimePermissionProjectionLifecycle
>;

export type AcpRuntimeOperationProjectionUpdate = {
  errorMessage?: string;
  lifecycle: AcpRuntimeOperationProjectionLifecycle;
  operation: AcpRuntimeOperation;
  turnId: string;
  type: typeof AcpRuntimeProjectionUpdateType.OperationUpdated;
};

export type AcpRuntimePermissionProjectionUpdate = {
  decision?: AcpRuntimePermissionResolution;
  lifecycle: AcpRuntimePermissionProjectionLifecycle;
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
  turnId: string;
  type: typeof AcpRuntimeProjectionUpdateType.PermissionUpdated;
};

export type AcpRuntimeMetadataProjectionUpdate = {
  metadata: AcpRuntimeSessionMetadata;
  turnId: string;
  type: typeof AcpRuntimeProjectionUpdateType.MetadataUpdated;
};

export type AcpRuntimeUsageProjectionUpdate = {
  turnId: string;
  type: typeof AcpRuntimeProjectionUpdateType.UsageUpdated;
  usage: AcpRuntimeUsage;
};

export type AcpRuntimeProjectionUpdate =
  | AcpRuntimeMetadataProjectionUpdate
  | AcpRuntimeOperationProjectionUpdate
  | AcpRuntimePermissionProjectionUpdate
  | AcpRuntimeUsageProjectionUpdate;

export type AcpRuntimeProjectionWatcher = (
  update: AcpRuntimeProjectionUpdate,
) => void;

export type AcpRuntimeStateUpdate =
  | AcpRuntimeProjectionUpdate
  | AcpRuntimeReadModelUpdate;

export type AcpRuntimeStateWatcher = (
  update: AcpRuntimeStateUpdate,
) => void;

export type AcpRuntimeSnapshot = {
  agent: AcpRuntimeAgent;
  config?: Readonly<Record<string, AcpRuntimeConfigValue>>;
  currentModeId?: string;
  cwd: string;
  mcpServers?: readonly AcpRuntimeMcpServer[];
  session: {
    id: string;
  };
  version: typeof ACP_RUNTIME_SNAPSHOT_VERSION;
};

export type AcpRuntimeSessionStatus = ValueOf<typeof AcpRuntimeSessionStatus>;

export type AcpRuntimeQueueDelivery = ValueOf<typeof AcpRuntimeQueueDelivery>;

export type AcpRuntimeQueuePolicy = {
  delivery: AcpRuntimeQueueDelivery;
};

export type AcpRuntimeQueuePolicyInput = Partial<AcpRuntimeQueuePolicy>;

export type AcpRuntimeSystemPrompt = string;

export type AcpRuntimeInitialConfigValue =
  | AcpRuntimeConfigValue
  | {
      aliases?: readonly AcpRuntimeConfigValue[];
      required?: boolean;
      value: AcpRuntimeConfigValue;
    };

export type AcpRuntimeInitialConfig = {
  mode?: string | { aliases?: readonly string[]; required?: boolean; value: string };
  model?: AcpRuntimeInitialConfigValue;
  effort?: AcpRuntimeInitialConfigValue;
  strict?: boolean;
};

export type AcpRuntimeInitialConfigReportItem = {
  appliedValue?: AcpRuntimeConfigValue;
  key: string;
  optionId?: string;
  reason?: string;
  requestedValue: AcpRuntimeConfigValue;
  status: "applied" | "already-set" | "failed" | "skipped";
};

export type AcpRuntimeInitialConfigReport = {
  items: readonly AcpRuntimeInitialConfigReportItem[];
  ok: boolean;
};

export type AcpRuntimeCreateOptions = {
  agent: AcpRuntimeAgent;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  initialConfig?: AcpRuntimeInitialConfig;
  mcpServers?: readonly AcpRuntimeMcpServer[];
  queue?: AcpRuntimeQueuePolicyInput;
  systemPrompt?: AcpRuntimeSystemPrompt;
};

export type AcpRuntimeStartSessionOptions = {
  agent: AcpRuntimeAgentInput;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  initialConfig?: AcpRuntimeInitialConfig;
  mcpServers?: readonly AcpRuntimeMcpServer[];
  queue?: AcpRuntimeQueuePolicyInput;
  systemPrompt?: AcpRuntimeSystemPrompt;
};

export type AcpRuntimeListAgentSessionsOptions = {
  agent: AcpRuntimeAgent;
  cursor?: string;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
};

export type AcpRuntimeSessionListSource = ValueOf<
  typeof AcpRuntimeSessionListSource
>;

export type AcpRuntimeListSessionsOptions = {
  agent?: AcpRuntimeAgentInput;
  cursor?: string;
  cwd?: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  limit?: number;
  source?: AcpRuntimeSessionListSource;
};

export type AcpRuntimeStateOptions = {
  enabled?: boolean;
  sessionRegistryPath?: string;
};

export type AcpRuntimeOptions = {
  agentResolver?: AcpRuntimeAgentResolver;
  observability?: AcpRuntimeObservabilityOptions;
  state?: AcpRuntimeStateOptions | false;
};

export type AcpRuntimeLoadOptions = Omit<
  AcpRuntimeCreateOptions,
  "systemPrompt"
> & {
  sessionId: string;
};

export type AcpRuntimeLoadSessionOptions = {
  agent?: AcpRuntimeAgentInput;
  cwd?: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  initialConfig?: AcpRuntimeInitialConfig;
  mcpServers?: readonly AcpRuntimeMcpServer[];
  queue?: AcpRuntimeQueuePolicyInput;
  sessionId: string;
};

export type AcpRuntimeResumeOptions = {
  handlers?: AcpRuntimeAuthorityHandlers;
  initialConfig?: AcpRuntimeInitialConfig;
  queue?: AcpRuntimeQueuePolicyInput;
  snapshot: AcpRuntimeSnapshot;
};

export type AcpRuntimeResumeSessionOptions = AcpRuntimeLoadSessionOptions;

export type AcpRuntimeStreamOptions = {
  timeoutMs?: number;
};

export type AcpRuntimeTurnHandle = {
  readonly completion: Promise<AcpRuntimeTurnCompletion>;
  readonly events: AsyncIterable<AcpRuntimeTurnEvent>;
  readonly turnId: string;
};

export type AcpRuntimeQueuedTurnStatus = ValueOf<
  typeof AcpRuntimeQueuedTurnStatus
>;

export type AcpRuntimeQueuedTurn = {
  position: number;
  prompt: AcpRuntimePrompt;
  queuedAt: string;
  status: AcpRuntimeQueuedTurnStatus;
  turnId: string;
};

export type AcpRuntimeOutputPart = AcpRuntimeContentPart;

export type AcpRuntimeTurnOutput = readonly AcpRuntimeOutputPart[];

export type AcpRuntimeTurnCompletion = {
  output: AcpRuntimeTurnOutput;
  outputText: string;
  turnId: string;
};

export type AcpRuntimeTurnEventType = ValueOf<typeof AcpRuntimeTurnEventType>;

export type AcpRuntimeTurnQueuedEvent = {
  position: number;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Queued;
};

export type AcpRuntimeTurnStartedEvent = {
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Started;
};

export type AcpRuntimeTurnThinkingEvent = {
  text: string;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Thinking;
};

export type AcpRuntimeTurnTextEvent = {
  text: string;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Text;
};

export type AcpRuntimeTurnPlanUpdatedEvent = {
  plan: readonly AcpRuntimePlanItem[];
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.PlanUpdated;
};

export type AcpRuntimeSessionMetadataUpdatedEvent = {
  metadata: AcpRuntimeSessionMetadata;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.MetadataUpdated;
};

export type AcpRuntimeUsageUpdatedEvent = {
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.UsageUpdated;
  usage: AcpRuntimeUsage;
};

export type AcpRuntimeOperationStartedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.OperationStarted;
};

export type AcpRuntimeOperationUpdatedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.OperationUpdated;
};

export type AcpRuntimePermissionRequestedEvent = {
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.PermissionRequested;
};

export type AcpRuntimePermissionResolvedEvent = {
  decision: AcpRuntimePermissionResolution;
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.PermissionResolved;
};

export type AcpRuntimeOperationCompletedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.OperationCompleted;
};

export type AcpRuntimeOperationFailedEvent = {
  error: AcpError;
  operation: AcpRuntimeOperation;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.OperationFailed;
};

export type AcpRuntimeTurnCompletedEvent = {
  output: AcpRuntimeTurnOutput;
  outputText: string;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Completed;
};

export type AcpRuntimeTurnCancelledEvent = {
  error: AcpTurnCancelledError;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Cancelled;
};

export type AcpRuntimeTurnCoalescedEvent = {
  error: AcpTurnCoalescedError;
  intoTurnId: string;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Coalesced;
};

export type AcpRuntimeTurnWithdrawnEvent = {
  error: AcpTurnWithdrawnError;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Withdrawn;
};

export type AcpRuntimeTurnFailedEvent = {
  error: AcpError;
  turnId: string;
  type: typeof AcpRuntimeTurnEventType.Failed;
};

export type AcpRuntimeTurnEvent =
  | AcpRuntimeTurnQueuedEvent
  | AcpRuntimeTurnStartedEvent
  | AcpRuntimeTurnThinkingEvent
  | AcpRuntimeTurnTextEvent
  | AcpRuntimeTurnPlanUpdatedEvent
  | AcpRuntimeSessionMetadataUpdatedEvent
  | AcpRuntimeUsageUpdatedEvent
  | AcpRuntimeOperationStartedEvent
  | AcpRuntimeOperationUpdatedEvent
  | AcpRuntimePermissionRequestedEvent
  | AcpRuntimePermissionResolvedEvent
  | AcpRuntimeOperationCompletedEvent
  | AcpRuntimeOperationFailedEvent
  | AcpRuntimeTurnCompletedEvent
  | AcpRuntimeTurnCancelledEvent
  | AcpRuntimeTurnCoalescedEvent
  | AcpRuntimeTurnWithdrawnEvent
  | AcpRuntimeTurnFailedEvent;

export type AcpRuntimeTurnHandlers = {
  onEvent?: (event: AcpRuntimeTurnEvent) => Promise<void> | void;
};
