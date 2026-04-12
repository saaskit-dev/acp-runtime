import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./constants.js";
import type { AcpError } from "./errors.js";

export type AcpRuntimeAgent = {
  args?: string[];
  command: string;
  env?: Record<string, string | undefined>;
  type?: string;
};

export type AcpRuntimeMcpServer =
  | {
      headers?: Record<string, string>;
      name: string;
      transport: {
        type: "http" | "sse";
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
        type: "stdio";
      };
    };

export type AcpRuntimeContentPart =
  | {
      text: string;
      type: "text";
    }
  | {
      mediaType?: string;
      title?: string;
      type: "file";
      uri: string;
    }
  | {
      alt?: string;
      mediaType?: string;
      type: "image";
      uri: string;
    }
  | {
      data: string;
      mediaType: string;
      title?: string;
      type: "audio";
    }
  | {
      mediaType?: string;
      text?: string;
      title?: string;
      type: "resource";
      uri: string;
      value?: unknown;
    }
  | {
      type: "json";
      value: unknown;
    };

export type AcpRuntimePromptPart = AcpRuntimeContentPart;

export type AcpRuntimePromptMessage = {
  content: string | readonly AcpRuntimePromptPart[];
  role: "assistant" | "developer" | "system" | "tool" | "user";
};

export type AcpRuntimePrompt =
  | string
  | readonly AcpRuntimePromptPart[]
  | readonly AcpRuntimePromptMessage[];

export type AcpRuntimePlanItem = {
  content: string;
  id?: string;
  priority: "high" | "low" | "medium";
  status: "completed" | "in_progress" | "pending";
};

export type AcpRuntimeOperationKind =
  | "document_edit"
  | "execute_command"
  | "mcp_call"
  | "network_request"
  | "read_file"
  | "unknown"
  | "write_file";

export type AcpRuntimeOperationPhase =
  | "awaiting_permission"
  | "cancelled"
  | "completed"
  | "failed"
  | "proposed"
  | "running";

export type AcpRuntimeOperationTarget = {
  type: "command" | "endpoint" | "mcp_tool" | "path" | "unknown";
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

export type AcpRuntimeOperationFailureReason =
  | "cancelled"
  | "failed"
  | "permission_denied"
  | "timeout";

export type AcpRuntimeOperation = {
  completedAt?: string;
  failureReason?: AcpRuntimeOperationFailureReason;
  id: string;
  kind: AcpRuntimeOperationKind;
  phase: AcpRuntimeOperationPhase;
  progress?: AcpRuntimeOperationProgress;
  result?: AcpRuntimeOperationResult;
  startedAt?: string;
  summary?: string;
  target?: AcpRuntimeOperationTarget;
  title: string;
  turnId: string;
  updatedAt?: string;
};

export type AcpRuntimePermissionKind =
  | "document"
  | "filesystem"
  | "mcp"
  | "network"
  | "terminal"
  | "unknown";

export type AcpRuntimePermissionScope = "once" | "session";

export type AcpRuntimePermissionRequest = {
  id: string;
  kind: AcpRuntimePermissionKind;
  operationId: string;
  phase: "allowed" | "denied" | "pending";
  reason?: string;
  scopeOptions: readonly AcpRuntimePermissionScope[];
  title: string;
  turnId: string;
};

export type AcpRuntimePermissionDecision =
  | {
      decision: "allow";
      scope?: AcpRuntimePermissionScope;
    }
  | {
      decision: "deny";
    };

export type AcpRuntimePermissionHandler = (
  request: AcpRuntimePermissionRequest,
) => Promise<AcpRuntimePermissionDecision> | AcpRuntimePermissionDecision;

export type AcpRuntimeAuthenticationMethod = {
  description?: string;
  id: string;
  title: string;
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
  type: "boolean" | "number" | "select" | "string";
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
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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

export type AcpRuntimeSessionStatus = "closed" | "ready" | "running";

export type AcpRuntimeCreateOptions = {
  agent: AcpRuntimeAgent;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  mcpServers?: readonly AcpRuntimeMcpServer[];
};

export type AcpRuntimeListAgentSessionsOptions = {
  agent: AcpRuntimeAgent;
  cursor?: string;
  cwd: string;
  handlers?: AcpRuntimeAuthorityHandlers;
};

export type AcpRuntimeOptions = {
  registry?: import("./session-registry.js").AcpRuntimeSessionRegistry;
};

export type AcpRuntimeLoadOptions = AcpRuntimeCreateOptions & {
  sessionId: string;
};

export type AcpRuntimeResumeOptions = {
  handlers?: AcpRuntimeAuthorityHandlers;
  snapshot: AcpRuntimeSnapshot;
};

export type AcpRuntimeStreamOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AcpRuntimeOutputPart = AcpRuntimeContentPart;

export type AcpRuntimeTurnOutput = readonly AcpRuntimeOutputPart[];

export type AcpRuntimeTurnCompletion = {
  output: AcpRuntimeTurnOutput;
  outputText: string;
  turnId: string;
};

export type AcpRuntimeTurnQueuedEvent = {
  position: number;
  turnId: string;
  type: "queued";
};

export type AcpRuntimeTurnStartedEvent = {
  turnId: string;
  type: "started";
};

export type AcpRuntimeTurnThinkingEvent = {
  text: string;
  turnId: string;
  type: "thinking";
};

export type AcpRuntimeTurnTextEvent = {
  text: string;
  turnId: string;
  type: "text";
};

export type AcpRuntimeTurnPlanUpdatedEvent = {
  plan: readonly AcpRuntimePlanItem[];
  turnId: string;
  type: "plan_updated";
};

export type AcpRuntimeSessionMetadataUpdatedEvent = {
  metadata: AcpRuntimeSessionMetadata;
  turnId: string;
  type: "metadata_updated";
};

export type AcpRuntimeUsageUpdatedEvent = {
  turnId: string;
  type: "usage_updated";
  usage: AcpRuntimeUsage;
};

export type AcpRuntimeOperationStartedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: "operation_started";
};

export type AcpRuntimeOperationUpdatedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: "operation_updated";
};

export type AcpRuntimePermissionRequestedEvent = {
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
  turnId: string;
  type: "permission_requested";
};

export type AcpRuntimePermissionResolvedEvent = {
  decision: "allowed" | "denied";
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
  turnId: string;
  type: "permission_resolved";
};

export type AcpRuntimeOperationCompletedEvent = {
  operation: AcpRuntimeOperation;
  turnId: string;
  type: "operation_completed";
};

export type AcpRuntimeOperationFailedEvent = {
  error: AcpError;
  operation: AcpRuntimeOperation;
  turnId: string;
  type: "operation_failed";
};

export type AcpRuntimeTurnCompletedEvent = {
  output: AcpRuntimeTurnOutput;
  outputText: string;
  turnId: string;
  type: "completed";
};

export type AcpRuntimeTurnFailedEvent = {
  error: AcpError;
  turnId: string;
  type: "failed";
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
  | AcpRuntimeTurnFailedEvent;

export type AcpRuntimeTurnHandlers = {
  onEvent?: (event: AcpRuntimeTurnEvent) => Promise<void> | void;
};
