import type {
  ContentBlock,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from "@agentclientprotocol/sdk";

import {
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpTurnCancelledError,
  AcpTurnTimeoutError,
} from "../errors.js";
import type {
  AcpRuntimeDiagnostics,
  AcpRuntimeOperation,
  AcpRuntimeOperationKind,
  AcpRuntimeOperationPhase,
  AcpRuntimeOutputPart,
  AcpRuntimePermissionDecision,
  AcpRuntimePermissionRequest,
  AcpRuntimePlanItem,
  AcpRuntimeSessionMetadata,
  AcpRuntimeTurnCompletedEvent,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnFailedEvent,
  AcpRuntimeUsage,
} from "../types.js";
import type { AcpAgentProfile } from "./profiles/index.js";
import {
  nextOperationId,
  nextPermissionRequestId,
  type AcpRuntimeTurnState,
} from "./turn-state.js";
import { extractRuntimeConfig } from "./capability-mapper.js";

export type AcpMappedPermissionRequest = {
  operation: AcpRuntimeOperation;
  request: AcpRuntimePermissionRequest;
};

export function mapSessionUpdateToRuntimeEvents(input: {
  diagnostics: AcpRuntimeDiagnostics;
  metadata: AcpRuntimeSessionMetadata;
  notification: SessionNotification;
  profile: AcpAgentProfile;
  turn: AcpRuntimeTurnState;
}): AcpRuntimeTurnEvent[] {
  const update = input.notification.update;
  switch (update.sessionUpdate) {
    case "agent_thought_chunk":
      return [
        {
          text: extractText(update),
          turnId: input.turn.turnId,
          type: "thinking",
        },
      ];
    case "agent_message_chunk": {
      const text = extractText(update);
      input.turn.outputTextChunks.push(text);
      input.turn.output.push(...mapContentChunkToOutput(update.content));
      return [
        {
          text,
          turnId: input.turn.turnId,
          type: "text",
        },
      ];
    }
    case "plan":
      return [
        {
          plan: update.entries.map(
            (entry, index): AcpRuntimePlanItem => ({
              content: entry.content,
              id: `plan-${index + 1}`,
              priority: entry.priority,
              status: entry.status,
            }),
          ),
          turnId: input.turn.turnId,
          type: "plan_updated",
        },
      ];
    case "available_commands_update":
      input.metadata.availableCommands = update.availableCommands.map(
        (command) => ({
          description: command.description,
          name: command.name,
        }),
      );
      return [
        {
          metadata: cloneMetadata(input.metadata),
          turnId: input.turn.turnId,
          type: "metadata_updated",
        },
      ];
    case "current_mode_update":
      input.metadata.currentModeId = update.currentModeId;
      return [
        {
          metadata: cloneMetadata(input.metadata),
          turnId: input.turn.turnId,
          type: "metadata_updated",
        },
      ];
    case "config_option_update":
      input.metadata.config = extractRuntimeConfig(update.configOptions);
      return [
        {
          metadata: cloneMetadata(input.metadata),
          turnId: input.turn.turnId,
          type: "metadata_updated",
        },
      ];
    case "session_info_update":
      if (update.title !== undefined) {
        input.metadata.title = update.title ?? undefined;
      }
      return [
        {
          metadata: cloneMetadata(input.metadata),
          turnId: input.turn.turnId,
          type: "metadata_updated",
        },
      ];
    case "usage_update": {
      const usage = mapUsageUpdate(update);
      input.diagnostics.lastUsage = usage;
      return [
        {
          turnId: input.turn.turnId,
          type: "usage_updated",
          usage,
        },
      ];
    }
    case "tool_call":
      return [
        {
          operation: upsertOperationFromToolCall({
            profile: input.profile,
            locations: update.locations,
            rawInput: update.rawInput,
            kind: update.kind,
            status: update.status,
            title: update.title,
            toolCallId: update.toolCallId,
            turn: input.turn,
          }),
          turnId: input.turn.turnId,
          type: "operation_started",
        },
      ];
    case "tool_call_update":
      return mapToolCallUpdateToRuntimeEvents(update, input.turn);
    case "user_message_chunk":
      return [];
    default:
      return assertNever(update);
  }
}

export function mapPermissionRequest(input: {
  params: RequestPermissionRequest;
  profile: AcpAgentProfile;
  turn: AcpRuntimeTurnState;
}): AcpMappedPermissionRequest {
  const operation = upsertOperationFromToolCall({
    profile: input.profile,
    locations: input.params.toolCall.locations ?? undefined,
    rawInput: input.params.toolCall.rawInput,
    kind: input.params.toolCall.kind ?? undefined,
    status: input.params.toolCall.status ?? "pending",
    title: input.params.toolCall.title ?? "Permission request",
    toolCallId: input.params.toolCall.toolCallId,
    turn: input.turn,
  });

  operation.phase = "awaiting_permission";
  operation.updatedAt = new Date().toISOString();

  const request: AcpRuntimePermissionRequest = {
    id: nextPermissionRequestId(input.turn),
    kind: permissionKindFromOperation(operation.kind),
    operationId: operation.id,
    phase: "pending",
    scopeOptions: mapPermissionScopes(input.params.options),
    title: input.params.toolCall.title ?? "Permission request",
    turnId: input.turn.turnId,
  };
  input.turn.permissionRequests.set(request.id, request);

  return {
    operation: cloneOperation(operation),
    request,
  };
}

export function mapPermissionDecisionToAcp(
  options: PermissionOption[],
  decision: AcpRuntimePermissionDecision,
): {
  outcome: { outcome: "cancelled" } | { optionId: string; outcome: "selected" };
} {
  if (decision.decision === "deny") {
    const reject =
      options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind === "reject_always");
    return reject
      ? {
          outcome: {
            optionId: reject.optionId,
            outcome: "selected",
          },
        }
      : { outcome: { outcome: "cancelled" } };
  }

  if (decision.scope === "session") {
    const allowAlways =
      options.find((option) => option.kind === "allow_always") ??
      options.find((option) => option.kind === "allow_once");
    return allowAlways
      ? {
          outcome: {
            optionId: allowAlways.optionId,
            outcome: "selected",
          },
        }
      : { outcome: { outcome: "cancelled" } };
  }

  const allowOnce =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always");
  return allowOnce
    ? {
        outcome: {
          optionId: allowOnce.optionId,
          outcome: "selected",
        },
      }
    : { outcome: { outcome: "cancelled" } };
}

export function finalizePromptResponse(input: {
  response: PromptResponse;
  turn: AcpRuntimeTurnState;
}): AcpRuntimeTurnCompletedEvent | AcpRuntimeTurnFailedEvent {
  if (input.turn.deniedOperationIds.size > 0) {
    return {
      error: new AcpPermissionDeniedError("Permission denied."),
      turnId: input.turn.turnId,
      type: "failed",
    };
  }

  if (input.turn.timedOut) {
    return {
      error: new AcpTurnTimeoutError("Turn timed out."),
      turnId: input.turn.turnId,
      type: "failed",
    };
  }

  if (input.response.stopReason === "cancelled") {
    return {
      error: new AcpTurnCancelledError("Turn cancelled."),
      turnId: input.turn.turnId,
      type: "failed",
    };
  }

  return {
    output: [...input.turn.output],
    outputText: input.turn.outputTextChunks.join(""),
    turnId: input.turn.turnId,
    type: "completed",
  };
}

export function createProtocolFailure(
  turnId: string,
  message: string,
): AcpRuntimeTurnFailedEvent {
  return {
    error: new AcpProtocolError(message),
    turnId,
    type: "failed",
  };
}

export function mapUsage(
  value: Usage | null | undefined,
): AcpRuntimeUsage | undefined {
  if (!value) {
    return undefined;
  }

  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
  };
}

function mapToolCallUpdateToRuntimeEvents(
  update: ToolCallUpdate & { sessionUpdate: "tool_call_update" },
  turn: AcpRuntimeTurnState,
): AcpRuntimeTurnEvent[] {
  const operationId = turn.vendorToolCallToOperationId.get(update.toolCallId);
  if (!operationId) {
    return [];
  }

  const existing = turn.operations.get(operationId);
  if (!existing) {
    return [];
  }

  if (update.title !== undefined && update.title !== null) {
    existing.title = update.title;
  }
  if (update.status !== undefined && update.status !== null) {
    existing.phase = mapOperationPhase(update.status);
  }
  if (update.content !== undefined && update.content !== null) {
    existing.result = {
      output: mapToolCallContentToOutput(update.content),
      outputText: collectToolCallContentText(update.content),
    };
  }
  existing.updatedAt = new Date().toISOString();

  if (existing.phase === "completed") {
    return [
      {
        operation: cloneOperation(existing),
        turnId: turn.turnId,
        type: "operation_completed",
      },
    ];
  }

  if (existing.phase === "failed") {
    return [
      {
        error: new AcpProtocolError(existing.title),
        operation: cloneOperation(existing),
        turnId: turn.turnId,
        type: "operation_failed",
      },
    ];
  }

  return [
    {
      operation: cloneOperation(existing),
      turnId: turn.turnId,
      type: "operation_updated",
    },
  ];
}

function upsertOperationFromToolCall(input: {
  profile: AcpAgentProfile;
  kind: ToolKind | null | undefined;
  locations: ToolCallLocation[] | null | undefined;
  rawInput: unknown;
  status: string | null | undefined;
  title: string;
  toolCallId: string;
  turn: AcpRuntimeTurnState;
}): AcpRuntimeOperation {
  const existingId = input.turn.vendorToolCallToOperationId.get(
    input.toolCallId,
  );
  if (existingId) {
    const existing = input.turn.operations.get(existingId);
    if (existing) {
      if (input.status) {
        existing.phase = mapOperationPhase(input.status);
      }
      existing.updatedAt = new Date().toISOString();
      existing.target = input.profile.inferOperationTarget({
        kind: input.kind,
        locations: input.locations,
        rawInput: input.rawInput,
      });
      return cloneOperation(existing);
    }
  }

  const operation: AcpRuntimeOperation = {
    id: nextOperationId(input.turn),
    kind: input.profile.mapOperationKind(input.kind),
    phase: mapOperationPhase(input.status ?? "pending"),
    startedAt: new Date().toISOString(),
    target: input.profile.inferOperationTarget({
      kind: input.kind,
      locations: input.locations,
      rawInput: input.rawInput,
    }),
    title: input.title,
    turnId: input.turn.turnId,
    updatedAt: new Date().toISOString(),
  };
  input.turn.vendorToolCallToOperationId.set(input.toolCallId, operation.id);
  input.turn.operations.set(operation.id, operation);
  return cloneOperation(operation);
}

function extractText(
  update: Extract<
    SessionUpdate,
    { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" }
  >,
): string {
  return update.content.type === "text" ? update.content.text : "";
}

function mapContentChunkToOutput(
  content: ContentBlock,
): AcpRuntimeOutputPart[] {
  switch (content.type) {
    case "text":
      return [{ text: content.text, type: "text" }];
    case "image":
      return [
        {
          mediaType: content.mimeType,
          type: "image",
          uri: content.uri ?? `data:${content.mimeType};base64,${content.data}`,
        },
      ];
    case "resource_link":
      return [
        {
          mediaType: content.mimeType ?? undefined,
          title: content.title ?? content.name,
          type: "file",
          uri: content.uri,
        },
      ];
    case "resource":
      return [
        {
          title: "resource",
          type: "file",
          uri: content.resource.uri,
        },
      ];
    case "audio":
      return [
        {
          mediaType: content.mimeType,
          title: "audio",
          type: "file",
          uri: `data:${content.mimeType};base64,${content.data}`,
        },
      ];
    default:
      return assertNever(content);
  }
}

function mapToolCallContentToOutput(
  content: ToolCallContent[],
): AcpRuntimeOutputPart[] {
  const parts: AcpRuntimeOutputPart[] = [];
  for (const item of content) {
    switch (item.type) {
      case "content":
        parts.push(...mapContentChunkToOutput(item.content));
        break;
      case "diff":
        parts.push({
          type: "json",
          value: {
            newText: item.newText,
            oldText: item.oldText,
            path: item.path,
          },
        });
        break;
      case "terminal":
        parts.push({
          type: "json",
          value: {
            terminalId: item.terminalId,
          },
        });
        break;
      default:
        assertNever(item);
    }
  }
  return parts;
}

function collectToolCallContentText(
  content: ToolCallContent[],
): string | undefined {
  const lines = content.flatMap((item) => {
    switch (item.type) {
      case "content":
        return item.content.type === "text" ? [item.content.text] : [];
      case "diff":
        return [`Diff for ${item.path}`];
      case "terminal":
        return [`Terminal ${item.terminalId}`];
      default:
        return assertNever(item);
    }
  });

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function mapOperationPhase(status: string): AcpRuntimeOperationPhase {
  switch (status) {
    case "pending":
      return "proposed";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "proposed";
  }
}

function permissionKindFromOperation(
  operationKind: AcpRuntimeOperationKind,
): AcpRuntimePermissionRequest["kind"] {
  switch (operationKind) {
    case "execute_command":
      return "terminal";
    case "network_request":
      return "network";
    case "read_file":
    case "write_file":
    case "document_edit":
      return "filesystem";
    case "mcp_call":
      return "mcp";
    default:
      return "unknown";
  }
}

function mapPermissionScopes(
  options: PermissionOption[],
): readonly ("once" | "session")[] {
  const scopes = new Set<"once" | "session">();
  for (const option of options) {
    if (option.kind.endsWith("always")) {
      scopes.add("session");
    } else {
      scopes.add("once");
    }
  }

  return Array.from(scopes);
}

function mapUsageUpdate(
  usage: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>,
): AcpRuntimeUsage {
  return {
    costUsd: usage.cost?.currency === "USD" ? usage.cost.amount : undefined,
    totalTokens: usage.used,
  };
}

function cloneMetadata(
  metadata: AcpRuntimeSessionMetadata,
): AcpRuntimeSessionMetadata {
  return {
    ...metadata,
    agentConfigOptions: metadata.agentConfigOptions
      ? metadata.agentConfigOptions.map((option) => ({
          ...option,
          options: option.options ? [...option.options] : undefined,
        }))
      : undefined,
    agentModes: metadata.agentModes ? [...metadata.agentModes] : undefined,
    availableCommands: metadata.availableCommands
      ? [...metadata.availableCommands]
      : undefined,
    config: metadata.config ? { ...metadata.config } : undefined,
  };
}

function cloneOperation(operation: AcpRuntimeOperation): AcpRuntimeOperation {
  return {
    ...operation,
    progress: operation.progress ? { ...operation.progress } : undefined,
    result: operation.result
      ? {
          ...operation.result,
          output: operation.result.output
            ? [...operation.result.output]
            : undefined,
        }
      : undefined,
    target: operation.target ? { ...operation.target } : undefined,
  };
}

function assertNever(value: never): never {
  throw new Error(
    `Unhandled ACP session update value: ${JSON.stringify(value)}`,
  );
}
