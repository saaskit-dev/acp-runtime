import type {
  AgentCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  ListSessionsResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import {
  AcpRuntimeAgentConfigOptionType,
  AcpRuntimeContentPartType,
  AcpRuntimeMcpTransportType,
  AcpRuntimeOperationKind,
  AcpRuntimeOperationPhase,
  AcpRuntimePermissionDecisionValue,
  AcpRuntimePermissionScope,
  AcpRuntimePromptMessageRole,
  AcpRuntimeThreadEntryKind,
  AcpRuntimeThreadEntryStatus,
  AcpRuntimeThreadToolContentKind,
  AcpRuntimeTurnEventType,
  type AcpRuntimeAgentConfigOption,
  type AcpRuntimeHistoryEntry,
  type AcpRuntimeMcpServer,
  type AcpRuntimeOperation,
  type AcpRuntimeOutputPart,
  type AcpRuntimePermissionDecision,
  type AcpRuntimePermissionRequest,
  type AcpRuntimePrompt,
  type AcpRuntimePromptPart,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeSessionReference,
  type AcpRuntimeThreadEntry,
  type AcpRuntimeThreadToolContent,
  type AcpRuntimeTurnCompletion,
  type AcpRuntimeTurnEvent,
  type AcpRuntimeUsage,
} from "../../core/types.js";

const REMOTE_AGENT_INFO = {
  name: "acp-runtime-remote",
  title: "ACP Runtime Remote",
  version: "0.1.1",
} as const;

const REMOTE_AGENT_CAPABILITIES = {
  loadSession: true,
  mcpCapabilities: {
    http: true,
    sse: true,
  },
  promptCapabilities: {
    audio: true,
    embeddedContext: true,
    image: true,
  },
  sessionCapabilities: {
    additionalDirectories: {},
    close: {},
    list: {},
    resume: {},
  },
} as const satisfies AgentCapabilities;

export function createRemoteInitializeResponse(
  request: InitializeRequest,
  input: {
    agentCapabilities?: AgentCapabilities;
    agentInfo?: InitializeResponse["agentInfo"];
  } = {},
): InitializeResponse {
  return {
    agentCapabilities: input.agentCapabilities ?? REMOTE_AGENT_CAPABILITIES,
    agentInfo: input.agentInfo ?? REMOTE_AGENT_INFO,
    protocolVersion:
      request.protocolVersion === PROTOCOL_VERSION
        ? request.protocolVersion
        : PROTOCOL_VERSION,
  };
}

export function mapAcpPromptToRuntimePrompt(
  prompt: readonly ContentBlock[],
): AcpRuntimePrompt {
  return prompt.map((block): AcpRuntimePromptPart => {
    switch (block.type) {
      case "text":
        return { text: block.text, type: AcpRuntimeContentPartType.Text };
      case "image":
        return {
          mediaType: block.mimeType,
          type: AcpRuntimeContentPartType.Image,
          uri: block.uri ?? `data:${block.mimeType};base64,${block.data}`,
        };
      case "audio":
        return {
          data: block.data,
          mediaType: block.mimeType,
          type: AcpRuntimeContentPartType.Audio,
        };
      case "resource_link":
        return {
          mediaType: block.mimeType ?? undefined,
          title: block.title ?? block.name,
          type:
            block.mimeType?.startsWith("image/")
              ? AcpRuntimeContentPartType.Image
              : AcpRuntimeContentPartType.File,
          uri: block.uri,
        };
      case "resource":
        return {
          mediaType: block.resource.mimeType ?? undefined,
          text: "text" in block.resource ? block.resource.text : undefined,
          type: AcpRuntimeContentPartType.Resource,
          uri: block.resource.uri,
          value: "blob" in block.resource ? block.resource.blob : undefined,
        };
      default:
        return assertNever(block);
    }
  });
}

export function mapAcpMcpServersToRuntime(
  servers: readonly McpServer[],
): readonly AcpRuntimeMcpServer[] {
  return servers.map((server): AcpRuntimeMcpServer => {
    if ("command" in server) {
      return {
        name: server.name,
        transport: {
          args: server.args,
          command: server.command,
          env: Object.fromEntries(
            server.env.map((entry) => [entry.name, entry.value]),
          ),
          type: AcpRuntimeMcpTransportType.Stdio,
        },
      };
    }

    return {
      headers: Object.fromEntries(
        server.headers.map((entry) => [entry.name, entry.value]),
      ),
      name: server.name,
      transport: {
        type:
          server.type === "http"
            ? AcpRuntimeMcpTransportType.Http
            : AcpRuntimeMcpTransportType.Sse,
        url: server.url,
      },
    };
  });
}

export function mapRuntimeSessionToAcpResponse(
  metadata: AcpRuntimeSessionMetadata,
): Pick<NewSessionResponse, "configOptions" | "modes" | "sessionId"> {
  return {
    configOptions: mapRuntimeConfigOptionsToAcp(metadata.agentConfigOptions),
    modes: mapRuntimeModesToAcp(metadata),
    sessionId: metadata.id,
  };
}

export function mapRuntimeSessionListToAcp(
  input: {
    nextCursor?: string;
    sessions: readonly AcpRuntimeSessionReference[];
  },
): ListSessionsResponse {
  return {
    nextCursor: input.nextCursor,
    sessions: input.sessions.map((session) => ({
      cwd: session.cwd,
      sessionId: session.id,
      title: session.title ?? null,
      updatedAt: session.updatedAt ?? null,
    })),
  };
}

export function mapRuntimeConfigOptionsToAcp(
  options: readonly AcpRuntimeAgentConfigOption[] | undefined,
): SessionConfigOption[] | undefined {
  if (!options?.length) {
    return undefined;
  }

  return options.map((option): SessionConfigOption => {
    if (
      option.type === AcpRuntimeAgentConfigOptionType.Boolean &&
      typeof option.value === "boolean"
    ) {
      return {
        category: option.category,
        currentValue: option.value,
        description: option.description,
        id: option.id,
        name: option.name,
        type: "boolean",
      };
    }

    return {
      category: option.category,
      currentValue: String(option.value),
      description: option.description,
      id: option.id,
      name: option.name,
      options: mapRuntimeConfigChoicesToAcp(option),
      type: "select",
    };
  });
}

export function mapRuntimeModesToAcp(
  metadata: AcpRuntimeSessionMetadata,
): SessionModeState | undefined {
  if (!metadata.agentModes?.length || !metadata.currentModeId) {
    return undefined;
  }

  return {
    availableModes: metadata.agentModes.map((mode) => ({
      description: mode.description,
      id: mode.id,
      name: mode.name,
    })),
    currentModeId: metadata.currentModeId,
  };
}

export function mapRuntimeTurnCompletionToAcp(
  completion: AcpRuntimeTurnCompletion,
  input: { userMessageId?: string | null | undefined } = {},
): PromptResponse {
  return {
    stopReason: "end_turn",
    usage: mapRuntimeUsageToAcp(completion),
    userMessageId: input.userMessageId ?? undefined,
  };
}

export function mapAcpPromptToUserMessageNotifications(
  sessionId: string,
  prompt: readonly ContentBlock[],
  messageId: string,
): SessionNotification[] {
  return prompt.map((content) => ({
    sessionId,
    update: {
      content,
      messageId,
      sessionUpdate: "user_message_chunk",
    },
  }));
}

export function mapRuntimeTurnEventToAcpNotifications(
  sessionId: string,
  event: AcpRuntimeTurnEvent,
): SessionNotification[] {
  const updates = mapRuntimeTurnEventToAcpUpdates(event);
  return updates.map((update) => ({
    sessionId,
    update,
  }));
}

export function mapRuntimeHistoryEntryToAcpNotifications(
  sessionId: string,
  entry: AcpRuntimeHistoryEntry,
): SessionNotification[] {
  if (entry.type === AcpRuntimePromptMessageRole.User) {
    return [
      {
        sessionId,
        update: {
          content: { text: entry.text, type: "text" },
          sessionUpdate: "user_message_chunk",
        },
      },
    ];
  }
  return mapRuntimeTurnEventToAcpNotifications(sessionId, entry);
}

export function mapRuntimeThreadEntryToAcpNotifications(
  sessionId: string,
  entry: AcpRuntimeThreadEntry,
): SessionNotification[] {
  switch (entry.kind) {
    case AcpRuntimeThreadEntryKind.UserMessage:
      return [
        {
          sessionId,
          update: {
            content: { text: entry.text, type: "text" },
            sessionUpdate: "user_message_chunk",
          },
        },
      ];
    case AcpRuntimeThreadEntryKind.AssistantMessage:
      return [
        {
          sessionId,
          update: {
            content: { text: entry.text, type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        },
      ];
    case AcpRuntimeThreadEntryKind.AssistantThought:
      return [
        {
          sessionId,
          update: {
            content: { text: entry.text, type: "text" },
            sessionUpdate: "agent_thought_chunk",
          },
        },
      ];
    case AcpRuntimeThreadEntryKind.Plan:
      return [
        {
          sessionId,
          update: {
            entries: entry.plan.map((item) => ({
              content: item.content,
              priority: item.priority,
              status: item.status,
            })),
            sessionUpdate: "plan",
          },
        },
      ];
    case AcpRuntimeThreadEntryKind.ToolCall:
      return [
        {
          sessionId,
          update: {
            content: mapThreadToolContent(entry.content),
            kind: mapThreadToolKind(entry.toolKind),
            locations: entry.locations?.map((location) => ({
              line: location.line,
              path: location.path,
            })),
            rawInput: entry.rawInput,
            rawOutput: entry.rawOutput,
            sessionUpdate: "tool_call",
            status: mapThreadStatusToToolStatus(entry.status),
            title: entry.title,
            toolCallId: entry.toolCallId,
          },
        },
      ];
    default:
      return assertNever(entry);
  }
}

export function mapRemotePermissionRequestToAcp(
  sessionId: string,
  request: AcpRuntimePermissionRequest,
): RequestPermissionRequest {
  return {
    options: [
      {
        kind: "allow_once",
        name: "Allow once",
        optionId: "allow_once",
      },
      ...(request.scopeOptions.includes(AcpRuntimePermissionScope.Session)
        ? [
            {
              kind: "allow_always" as const,
              name: "Allow for this session",
              optionId: "allow_always",
            },
          ]
        : []),
      {
        kind: "reject_once",
        name: "Reject",
        optionId: "reject_once",
      },
    ],
    sessionId,
    toolCall: {
      kind: mapRuntimeOperationKindToToolKind(request.kind),
      status: "pending",
      title: request.title,
      toolCallId: request.operationId,
    },
  };
}

export function mapAcpPermissionOutcomeToRuntimeDecision(
  outcome: import("@agentclientprotocol/sdk").RequestPermissionOutcome,
): AcpRuntimePermissionDecision {
  if (outcome.outcome === "cancelled") {
    return { decision: AcpRuntimePermissionDecisionValue.Deny };
  }

  if (outcome.optionId === "allow_always") {
    return {
      decision: AcpRuntimePermissionDecisionValue.Allow,
      scope: AcpRuntimePermissionScope.Session,
    };
  }

  if (outcome.optionId === "allow_once") {
    return {
      decision: AcpRuntimePermissionDecisionValue.Allow,
      scope: AcpRuntimePermissionScope.Once,
    };
  }

  return { decision: AcpRuntimePermissionDecisionValue.Deny };
}

function mapRuntimeTurnEventToAcpUpdates(
  event: AcpRuntimeTurnEvent,
): SessionUpdate[] {
  switch (event.type) {
    case AcpRuntimeTurnEventType.Text:
      return [
        {
          content: { text: event.text, type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      ];
    case AcpRuntimeTurnEventType.Thinking:
      return [
        {
          content: { text: event.text, type: "text" },
          sessionUpdate: "agent_thought_chunk",
        },
      ];
    case AcpRuntimeTurnEventType.PlanUpdated:
      return [
        {
          entries: event.plan.map((entry) => ({
            content: entry.content,
            priority: entry.priority,
            status: entry.status,
          })),
          sessionUpdate: "plan",
        },
      ];
    case AcpRuntimeTurnEventType.MetadataUpdated:
      return mapMetadataUpdates(event.metadata);
    case AcpRuntimeTurnEventType.UsageUpdated:
      return mapUsageUpdate(event.usage);
    case AcpRuntimeTurnEventType.OperationStarted:
      return [
        {
          ...mapOperationToAcpToolCall(event.operation),
          sessionUpdate: "tool_call",
        },
      ];
    case AcpRuntimeTurnEventType.OperationUpdated:
    case AcpRuntimeTurnEventType.OperationCompleted:
    case AcpRuntimeTurnEventType.OperationFailed:
      return [
        {
          ...mapOperationToAcpToolCallUpdate(event.operation),
          sessionUpdate: "tool_call_update",
        },
      ];
    case AcpRuntimeTurnEventType.Cancelled:
    case AcpRuntimeTurnEventType.Coalesced:
    case AcpRuntimeTurnEventType.Completed:
    case AcpRuntimeTurnEventType.Failed:
    case AcpRuntimeTurnEventType.PermissionRequested:
    case AcpRuntimeTurnEventType.PermissionResolved:
    case AcpRuntimeTurnEventType.Queued:
    case AcpRuntimeTurnEventType.Started:
    case AcpRuntimeTurnEventType.Withdrawn:
      return [];
    default:
      return assertNever(event);
  }
}

function mapMetadataUpdates(
  metadata: AcpRuntimeSessionMetadata,
): SessionUpdate[] {
  const updates: SessionUpdate[] = [];
  if (metadata.title !== undefined) {
    updates.push({
      sessionUpdate: "session_info_update",
      title: metadata.title,
    });
  }
  if (metadata.currentModeId !== undefined) {
    updates.push({
      currentModeId: metadata.currentModeId,
      sessionUpdate: "current_mode_update",
    });
  }
  const configOptions = mapRuntimeConfigOptionsToAcp(metadata.agentConfigOptions);
  if (configOptions) {
    updates.push({
      configOptions,
      sessionUpdate: "config_option_update",
    });
  }
  return updates;
}

function mapUsageUpdate(usage: AcpRuntimeUsage): SessionUpdate[] {
  if (
    usage.contextUsedTokens === undefined ||
    usage.contextWindowTokens === undefined
  ) {
    return [];
  }

  return [
    {
      sessionUpdate: "usage_update",
      size: usage.contextWindowTokens,
      used: usage.contextUsedTokens,
    },
  ];
}

function mapRuntimeUsageToAcp(
  completion: AcpRuntimeTurnCompletion,
): Usage | undefined {
  const usage = completion.output.find(
    (part): part is Extract<AcpRuntimeOutputPart, { type: "json" }> =>
      part.type === AcpRuntimeContentPartType.Json &&
      isRecord(part.value) &&
      part.value["usage"] !== undefined,
  );
  const value = usage?.value;
  if (!isRecord(value) || !isRecord(value["usage"])) {
    return undefined;
  }

  const candidate = value["usage"];
  const inputTokens = candidate["inputTokens"];
  const outputTokens = candidate["outputTokens"];
  const totalTokens = candidate["totalTokens"];
  if (
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }

  return {
    cachedReadTokens: optionalNumber(candidate["cachedReadTokens"]),
    cachedWriteTokens: optionalNumber(candidate["cachedWriteTokens"]),
    inputTokens,
    outputTokens,
    thoughtTokens: optionalNumber(candidate["thoughtTokens"]),
    totalTokens,
  };
}

function mapOperationToAcpToolCall(operation: AcpRuntimeOperation) {
  return {
    content: mapOperationContent(operation),
    kind: mapRuntimeOperationKindToToolKind(operation.kind),
    locations: mapOperationLocations(operation),
    rawInput: operation.target,
    status: mapOperationPhaseToToolStatus(operation.phase),
    title: operation.title,
    toolCallId: operation.id,
  };
}

function mapOperationToAcpToolCallUpdate(operation: AcpRuntimeOperation) {
  return {
    content: mapOperationContent(operation),
    kind: mapRuntimeOperationKindToToolKind(operation.kind),
    locations: mapOperationLocations(operation),
    rawInput: operation.target,
    status: mapOperationPhaseToToolStatus(operation.phase),
    title: operation.title,
    toolCallId: operation.id,
  };
}

function mapOperationContent(
  operation: AcpRuntimeOperation,
): ToolCallContent[] | undefined {
  if (!operation.result?.outputText) {
    return undefined;
  }
  return [
    {
      content: {
        text: operation.result.outputText,
        type: "text",
      },
      type: "content",
    },
  ];
}

function mapOperationLocations(
  operation: AcpRuntimeOperation,
): ToolCallLocation[] | undefined {
  if (operation.target?.type !== "path") {
    return undefined;
  }
  return [{ path: operation.target.value }];
}

function mapRuntimeOperationKindToToolKind(
  kind: AcpRuntimeOperation["kind"] | AcpRuntimePermissionRequest["kind"],
): ToolKind {
  switch (kind) {
    case AcpRuntimeOperationKind.ReadFile:
    case "filesystem":
      return "read";
    case AcpRuntimeOperationKind.DocumentEdit:
    case AcpRuntimeOperationKind.WriteFile:
    case "document":
      return "edit";
    case AcpRuntimeOperationKind.ExecuteCommand:
    case "terminal":
      return "execute";
    case AcpRuntimeOperationKind.NetworkRequest:
    case "network":
      return "fetch";
    case AcpRuntimeOperationKind.McpCall:
    case "mcp":
      return "other";
    case AcpRuntimeOperationKind.Unknown:
    case "unknown":
      return "other";
    default:
      return "other";
  }
}

function mapOperationPhaseToToolStatus(
  phase: AcpRuntimeOperation["phase"],
): ToolCallStatus {
  switch (phase) {
    case AcpRuntimeOperationPhase.Completed:
      return "completed";
    case AcpRuntimeOperationPhase.Failed:
    case AcpRuntimeOperationPhase.Cancelled:
      return "failed";
    case AcpRuntimeOperationPhase.AwaitingPermission:
    case AcpRuntimeOperationPhase.Running:
      return "in_progress";
    case AcpRuntimeOperationPhase.Proposed:
      return "pending";
    default:
      return "pending";
  }
}

function mapThreadStatusToToolStatus(
  status: string,
): ToolCallStatus {
  switch (status) {
    case AcpRuntimeThreadEntryStatus.Completed:
      return "completed";
    case AcpRuntimeThreadEntryStatus.Failed:
      return "failed";
    case AcpRuntimeThreadEntryStatus.InProgress:
    case AcpRuntimeThreadEntryStatus.Streaming:
      return "in_progress";
    case AcpRuntimeThreadEntryStatus.Pending:
      return "pending";
    default:
      return "pending";
  }
}

function mapThreadToolKind(kind: string | undefined): ToolKind {
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
    case "think":
    case "fetch":
    case "other":
      return kind;
    default:
      return "other";
  }
}

function mapThreadToolContent(
  content: readonly AcpRuntimeThreadToolContent[],
): ToolCallContent[] | undefined {
  if (content.length === 0) {
    return undefined;
  }

  return content.map((item): ToolCallContent => {
    switch (item.kind) {
      case AcpRuntimeThreadToolContentKind.Content:
        return {
          content: item.part
            ? mapRuntimeOutputPartToAcpContent(item.part)
            : { text: item.text ?? item.label ?? "", type: "text" },
          type: "content",
        };
      case AcpRuntimeThreadToolContentKind.Diff:
        return {
          newText: item.newText,
          oldText: item.oldText,
          path: item.path,
          type: "diff",
        };
      case AcpRuntimeThreadToolContentKind.Terminal:
        return {
          terminalId: item.terminalId,
          type: "terminal",
        };
      default:
        return assertNever(item);
    }
  });
}

function mapRuntimeOutputPartToAcpContent(
  part: AcpRuntimeOutputPart,
): ContentBlock {
  switch (part.type) {
    case AcpRuntimeContentPartType.Text:
      return { text: part.text, type: "text" };
    case AcpRuntimeContentPartType.Image:
      return {
        mimeType: part.mediaType ?? "image/*",
        name: part.alt ?? part.uri,
        title: part.alt,
        type: "resource_link",
        uri: part.uri,
      };
    case AcpRuntimeContentPartType.Audio:
      return {
        data: part.data,
        mimeType: part.mediaType,
        type: "audio",
      };
    case AcpRuntimeContentPartType.File:
      return {
        mimeType: part.mediaType,
        name: part.title ?? part.uri,
        title: part.title,
        type: "resource_link",
        uri: part.uri,
      };
    case AcpRuntimeContentPartType.Resource:
      return {
        resource: {
          mimeType: part.mediaType,
          text:
            part.text ??
            (part.value === undefined
              ? ""
              : JSON.stringify(part.value, null, 2)),
          uri: part.uri,
        },
        type: "resource",
      };
    case AcpRuntimeContentPartType.Json:
      return { text: JSON.stringify(part.value, null, 2), type: "text" };
    default:
      return assertNever(part);
  }
}

function mapRuntimeConfigChoicesToAcp(option: AcpRuntimeAgentConfigOption) {
  if (!option.options?.length) {
    return [
      {
        description: String(option.value),
        name: String(option.value),
        value: String(option.value),
      },
    ];
  }

  return option.options.map((choice) => ({
    description: choice.description ?? String(choice.value),
    name: choice.name,
    value: String(choice.value),
  }));
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled remote ACP mapping value: ${JSON.stringify(value)}`);
}
