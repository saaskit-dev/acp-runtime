import type {
  ContentBlock,
  SessionConfigOption,
  SessionConfigSelectOptions,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

type JsonRecord = Record<string, unknown>;

const TOOL_KINDS = new Set<string>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const TOOL_STATUSES = new Set<string>([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

const PLAN_PRIORITIES = new Set<string>(["high", "medium", "low"]);
const PLAN_STATUSES = new Set<string>([
  "pending",
  "in_progress",
  "completed",
]);

export function normalizeSessionNotification(
  params: SessionNotification,
): SessionNotification | undefined {
  if (!isRecord(params) || typeof params.sessionId !== "string") {
    return undefined;
  }

  const update = normalizeSessionUpdate(params.update);
  if (!update) {
    return undefined;
  }

  return {
    ...params,
    sessionId: params.sessionId,
    update,
  };
}

function normalizeSessionUpdate(update: unknown): SessionUpdate | undefined {
  if (!isRecord(update) || typeof update.sessionUpdate !== "string") {
    return undefined;
  }

  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const content = normalizeContentBlock(update.content);
      return content
        ? ({ ...update, content } as SessionUpdate)
        : undefined;
    }
    case "plan":
      return {
        ...update,
        entries: normalizePlanEntries(update.entries),
        sessionUpdate: "plan",
      } as SessionUpdate;
    case "available_commands_update":
      return {
        ...update,
        availableCommands: normalizeAvailableCommands(update.availableCommands),
        sessionUpdate: "available_commands_update",
      } as SessionUpdate;
    case "current_mode_update":
      return typeof update.currentModeId === "string"
        ? ({
            ...update,
            currentModeId: update.currentModeId,
            sessionUpdate: "current_mode_update",
          } as SessionUpdate)
        : undefined;
    case "config_option_update":
      return {
        ...update,
        configOptions: normalizeConfigOptions(update.configOptions),
        sessionUpdate: "config_option_update",
      } as SessionUpdate;
    case "session_info_update":
      return normalizeSessionInfoUpdate(update);
    case "usage_update":
      return normalizeUsageUpdate(update);
    case "tool_call":
      return normalizeToolCall(update);
    case "tool_call_update":
      return normalizeToolCallUpdate(update);
    default:
      return undefined;
  }
}

function normalizeContentBlock(value: unknown): ContentBlock | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string"
        ? ({ ...value, text: value.text, type: "text" } as ContentBlock)
        : undefined;
    case "image":
      return typeof value.data === "string" && typeof value.mimeType === "string"
        ? ({
            ...value,
            data: value.data,
            mimeType: value.mimeType,
            type: "image",
            uri: optionalStringOrNull(value.uri),
          } as ContentBlock)
        : undefined;
    case "audio":
      return typeof value.data === "string" && typeof value.mimeType === "string"
        ? ({
            ...value,
            data: value.data,
            mimeType: value.mimeType,
            type: "audio",
          } as ContentBlock)
        : undefined;
    case "resource_link":
      return typeof value.uri === "string"
        ? ({
            ...value,
            mimeType: optionalStringOrNull(value.mimeType),
            name: typeof value.name === "string" ? value.name : value.uri,
            title: optionalStringOrNull(value.title),
            type: "resource_link",
            uri: value.uri,
          } as ContentBlock)
        : undefined;
    case "resource": {
      const resource = normalizeEmbeddedResource(value.resource);
      return resource
        ? ({ ...value, resource, type: "resource" } as ContentBlock)
        : undefined;
    }
    default:
      return undefined;
  }
}

function normalizeEmbeddedResource(value: unknown): unknown | undefined {
  if (!isRecord(value) || typeof value.uri !== "string") {
    return undefined;
  }

  if (typeof value.text === "string") {
    return {
      ...value,
      mimeType: optionalStringOrNull(value.mimeType),
      text: value.text,
      uri: value.uri,
    };
  }

  if (typeof value.blob === "string") {
    return {
      ...value,
      blob: value.blob,
      mimeType: optionalStringOrNull(value.mimeType),
      uri: value.uri,
    };
  }

  return undefined;
}

function normalizePlanEntries(value: unknown): Array<{
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}> {
  return arrayValue(value).flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.content !== "string" ||
      !PLAN_PRIORITIES.has(String(entry.priority)) ||
      !PLAN_STATUSES.has(String(entry.status))
    ) {
      return [];
    }

    return [
      {
        ...entry,
        content: entry.content,
        priority: entry.priority as "high" | "medium" | "low",
        status: entry.status as "pending" | "in_progress" | "completed",
      },
    ];
  });
}

function normalizeAvailableCommands(value: unknown): Array<{
  description: string;
  name: string;
}> {
  return arrayValue(value).flatMap((command) => {
    if (
      !isRecord(command) ||
      typeof command.name !== "string" ||
      typeof command.description !== "string"
    ) {
      return [];
    }

    return [{ ...command, description: command.description, name: command.name }];
  });
}

function normalizeConfigOptions(value: unknown): SessionConfigOption[] {
  return arrayValue(value).flatMap((option) => {
    const normalized = normalizeConfigOption(option);
    return normalized ? [normalized] : [];
  });
}

function normalizeConfigOption(value: unknown): SessionConfigOption | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string"
  ) {
    return undefined;
  }

  if (value.type === "boolean") {
    return typeof value.currentValue === "boolean"
      ? ({
          ...value,
          currentValue: value.currentValue,
          id: value.id,
          name: value.name,
          type: "boolean",
        } as SessionConfigOption)
      : undefined;
  }

  if (value.type === "select") {
    return typeof value.currentValue === "string"
      ? ({
          ...value,
          currentValue: value.currentValue,
          id: value.id,
          name: value.name,
          options: normalizeConfigSelectOptions(value.options),
          type: "select",
        } as SessionConfigOption)
      : undefined;
  }

  return undefined;
}

function normalizeConfigSelectOptions(value: unknown): SessionConfigSelectOptions {
  const options: unknown[] = [];
  for (const entry of arrayValue(value)) {
    if (!isRecord(entry)) {
      continue;
    }

    if (typeof entry.value === "string" && typeof entry.name === "string") {
      options.push({
        ...entry,
        description: optionalStringOrNull(entry.description),
        name: entry.name,
        value: entry.value,
      });
      continue;
    }

    if (typeof entry.group === "string" && typeof entry.name === "string") {
      options.push({
        ...entry,
        group: entry.group,
        name: entry.name,
        options: arrayValue(entry.options).flatMap((choice) => {
          if (
            !isRecord(choice) ||
            typeof choice.value !== "string" ||
            typeof choice.name !== "string"
          ) {
            return [];
          }

          return [
            {
              ...choice,
              description: optionalStringOrNull(choice.description),
              name: choice.name,
              value: choice.value,
            },
          ];
        }),
      });
    }
  }
  return options as SessionConfigSelectOptions;
}

function normalizeSessionInfoUpdate(update: JsonRecord): SessionUpdate {
  const normalized: JsonRecord = {
    ...update,
    sessionUpdate: "session_info_update",
  };

  if (hasOwn(update, "title")) {
    if (typeof update.title === "string" || update.title === null) {
      normalized.title = update.title;
    } else {
      delete normalized.title;
    }
  }

  if (hasOwn(update, "updatedAt")) {
    if (typeof update.updatedAt === "string" || update.updatedAt === null) {
      normalized.updatedAt = update.updatedAt;
    } else {
      delete normalized.updatedAt;
    }
  }

  return normalized as SessionUpdate;
}

function normalizeUsageUpdate(update: JsonRecord): SessionUpdate {
  const cost = isRecord(update.cost)
    ? typeof update.cost.currency === "string" &&
      typeof update.cost.amount === "number" &&
      Number.isFinite(update.cost.amount)
      ? update.cost
      : undefined
    : update.cost === null
      ? null
      : undefined;

  return {
    ...update,
    cost,
    sessionUpdate: "usage_update",
    size: finiteNumber(update.size) ?? 0,
    used: finiteNumber(update.used) ?? 0,
  } as SessionUpdate;
}

function normalizeToolCall(update: JsonRecord): SessionUpdate | undefined {
  if (typeof update.toolCallId !== "string") {
    return undefined;
  }

  const title =
    typeof update.title === "string" && update.title.trim() !== ""
      ? update.title
      : deriveToolTitle(update);

  return {
    ...update,
    content: normalizeOptionalToolCallContent(update.content) ?? [],
    kind: normalizeToolKind(update.kind) ?? "other",
    locations: normalizeOptionalToolCallLocations(update.locations) ?? [],
    sessionUpdate: "tool_call",
    status: normalizeToolStatus(update.status) ?? "pending",
    title,
    toolCallId: update.toolCallId,
  } as SessionUpdate;
}

function normalizeToolCallUpdate(update: JsonRecord): SessionUpdate | undefined {
  if (typeof update.toolCallId !== "string") {
    return undefined;
  }

  const normalized: JsonRecord = {
    ...update,
    sessionUpdate: "tool_call_update",
    toolCallId: update.toolCallId,
  };

  if (hasOwn(update, "content")) {
    const content = normalizeOptionalToolCallContent(update.content);
    if (content === undefined) {
      delete normalized.content;
    } else {
      normalized.content = content;
    }
  }

  if (hasOwn(update, "locations")) {
    const locations = normalizeOptionalToolCallLocations(update.locations);
    if (locations === undefined) {
      delete normalized.locations;
    } else {
      normalized.locations = locations;
    }
  }

  if (hasOwn(update, "kind")) {
    const kind = normalizeToolKind(update.kind);
    if (kind === undefined) {
      delete normalized.kind;
    } else {
      normalized.kind = kind;
    }
  }

  if (hasOwn(update, "status")) {
    const status = normalizeToolStatus(update.status);
    if (status === undefined) {
      delete normalized.status;
    } else {
      normalized.status = status;
    }
  }

  if (hasOwn(update, "title")) {
    if (typeof update.title === "string" || update.title === null) {
      normalized.title = update.title;
    } else {
      delete normalized.title;
    }
  }

  return normalized as SessionUpdate;
}

function normalizeOptionalToolCallContent(
  value: unknown,
): ToolCallContent[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined || !Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    const normalized = normalizeToolCallContent(entry);
    return normalized ? [normalized] : [];
  });
}

function normalizeToolCallContent(value: unknown): ToolCallContent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "content": {
      const content = normalizeContentBlock(value.content);
      return content
        ? ({ ...value, content, type: "content" } as ToolCallContent)
        : undefined;
    }
    case "diff":
      return typeof value.path === "string" && typeof value.newText === "string"
        ? ({
            ...value,
            newText: value.newText,
            oldText: optionalStringOrNull(value.oldText),
            path: value.path,
            type: "diff",
          } as ToolCallContent)
        : undefined;
    case "terminal":
      return typeof value.terminalId === "string"
        ? ({
            ...value,
            terminalId: value.terminalId,
            type: "terminal",
          } as ToolCallContent)
        : undefined;
    default:
      return undefined;
  }
}

function normalizeOptionalToolCallLocations(
  value: unknown,
): ToolCallLocation[] | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined || !Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      return [];
    }

    const line = finiteNumber(entry.line);
    return [
      {
        ...entry,
        line: line === undefined ? optionalNumberOrNull(entry.line) : line,
        path: entry.path,
      },
    ];
  });
}

function normalizeToolKind(value: unknown): ToolKind | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (TOOL_KINDS.has(value) ? value : "other") as ToolKind;
}

function normalizeToolStatus(value: unknown): ToolCallStatus | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "string" && TOOL_STATUSES.has(value)
    ? (value as ToolCallStatus)
    : undefined;
}

function deriveToolTitle(update: JsonRecord): string {
  const rawInput = update.rawInput;
  if (isRecord(rawInput)) {
    const named =
      readNonEmptyString(rawInput.name) ??
      readNonEmptyString(rawInput.toolName) ??
      readNonEmptyString(rawInput.tool) ??
      readNonEmptyString(rawInput.action);
    if (named) {
      return named;
    }

    const command = readNonEmptyString(rawInput.command);
    if (command) {
      const args = Array.isArray(rawInput.args)
        ? rawInput.args.filter((entry): entry is string => typeof entry === "string")
        : [];
      return args.length > 0 ? `${command} ${args.join(" ")}` : command;
    }
  }

  const rawOutputName =
    isRecord(update.rawOutput) &&
    (readNonEmptyString(update.rawOutput.name) ??
      readNonEmptyString(update.rawOutput.toolName));
  if (rawOutputName) {
    return rawOutputName;
  }

  return `Tool call ${update.toolCallId}`;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function optionalNumberOrNull(value: unknown): number | null | undefined {
  return typeof value === "number" || value === null ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
