import type { HarnessSummary, TranscriptEntry } from "./types.js";

type SanitizeContext = {
  sessionIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  terminalIds: Map<string, string>;
  modelIds: Map<string, string>;
  modeIds: Map<string, string>;
  fileNames: Map<string, string>;
  titles: Map<string, string>;
};

function createContext(): SanitizeContext {
  return {
    sessionIds: new Map(),
    toolCallIds: new Map(),
    terminalIds: new Map(),
    modelIds: new Map(),
    modeIds: new Map(),
    fileNames: new Map(),
    titles: new Map(),
  };
}

function mapStableId(map: Map<string, string>, value: string, prefix: string): string {
  const existing = map.get(value);
  if (existing) {
    return existing;
  }

  const next = `${prefix}_${map.size + 1}`;
  map.set(value, next);
  return next;
}

function sanitizeStringValue(value: string, context: SanitizeContext): string {
  let sanitized = value;

  sanitized = sanitized.replace(/<content>[\s\S]*?<\/content>/g, "<content>[REDACTED_CONTENT]</content>");
  sanitized = sanitized.replace(/<path>[\s\S]*?<\/path>/g, "<path><REDACTED_PATH></path>");
  sanitized = sanitized.replace(/\[Project README:[^\]]+\][\s\S]*$/g, "[Project README: <REDACTED_PATH>]\n[REDACTED_CONTENT]");

  sanitized = sanitized.replace(/\/Users\/dev\/acp-runtime/g, "<WORKSPACE_ROOT>");
  sanitized = sanitized.replace(/\/Users\/dev/g, "<HOME>");

  sanitized = sanitized.replace(/\bses_[A-Za-z0-9_]+\b/g, (match) =>
    mapStableId(context.sessionIds, match, "SESSION"));
  sanitized = sanitized.replace(/\bcall_[A-Za-z0-9_]+\b/g, (match) =>
    mapStableId(context.toolCallIds, match, "TOOL_CALL"));
  sanitized = sanitized.replace(/\bterm_[A-Za-z0-9_]+\b/g, (match) =>
    mapStableId(context.terminalIds, match, "TERMINAL"));

  return sanitized;
}

function sanitizePathValue(value: string, context: SanitizeContext): string {
  const sanitized = sanitizeStringValue(value, context);
  if (!sanitized.includes("/")) {
    return mapStableId(context.fileNames, sanitized, "FILE");
  }

  return sanitized.replace(/(^|\/)([^/]+)/g, (match, prefix, leaf) => {
    if (leaf === "<WORKSPACE_ROOT>" || leaf === "<HOME>") {
      return match;
    }

    return `${prefix}${mapStableId(context.fileNames, leaf, "FILE")}`;
  });
}

function sanitizeTitleValue(value: string, context: SanitizeContext): string {
  return mapStableId(context.titles, value, "TITLE");
}

function sanitizeArray(value: unknown[], context: SanitizeContext, parentKey?: string): unknown[] {
  if (parentKey === "availableCommands") {
    return value.map((_, index) => ({
      name: `<REDACTED_COMMAND_${index + 1}>`,
      description: "<REDACTED_DESCRIPTION>",
    }));
  }

  if (parentKey === "availableModels") {
    return value.map((_, index) => ({
      modelId: `<REDACTED_MODEL_${index + 1}>`,
      name: "<REDACTED_MODEL_NAME>",
    }));
  }

  if (
    parentKey === "available" &&
    value.every((item) =>
      item &&
      typeof item === "object" &&
      "name" in (item as Record<string, unknown>) &&
      "description" in (item as Record<string, unknown>))
  ) {
    return value.map((_, index) => ({
      name: `<REDACTED_ITEM_${index + 1}>`,
      description: "<REDACTED_DESCRIPTION>",
      inputHint: "<REDACTED_INPUT_HINT>",
    }));
  }

  if (
    parentKey === "todos" &&
    value.every((item) =>
      item &&
      typeof item === "object" &&
      "content" in (item as Record<string, unknown>) &&
      "status" in (item as Record<string, unknown>) &&
      "priority" in (item as Record<string, unknown>))
  ) {
    return value.map((item, index) => {
      const todo = item as Record<string, unknown>;
      return {
        content: `<REDACTED_TODO_${index + 1}>`,
        status: todo.status,
        priority: todo.priority,
      };
    });
  }

  return value.map((item) => sanitizeUnknown(item, context));
}

function sanitizeObject(
  value: Record<string, unknown>,
  context: SanitizeContext,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (key === "sessionId" && typeof entry === "string") {
      result[key] = mapStableId(context.sessionIds, entry, "SESSION");
      continue;
    }

    if (key === "toolCallId" && typeof entry === "string") {
      result[key] = mapStableId(context.toolCallIds, entry, "TOOL_CALL");
      continue;
    }

    if (key === "terminalId" && typeof entry === "string") {
      result[key] = mapStableId(context.terminalIds, entry, "TERMINAL");
      continue;
    }

    if ((key === "modelId" || key === "currentModelId") && typeof entry === "string") {
      result[key] = mapStableId(context.modelIds, entry, "MODEL");
      continue;
    }

    if ((key === "modeId" || key === "currentModeId") && typeof entry === "string") {
      result[key] = mapStableId(context.modeIds, entry, "MODE");
      continue;
    }

    if (key === "cwd" && typeof entry === "string") {
      result[key] = sanitizePathValue(entry, context);
      continue;
    }

    if (key === "filePath" && typeof entry === "string") {
      result[key] = sanitizePathValue(entry, context);
      continue;
    }

    if (key === "path" && typeof entry === "string") {
      result[key] = sanitizePathValue(entry, context);
      continue;
    }

    if (key === "title" && typeof entry === "string") {
      result[key] = sanitizeTitleValue(entry, context);
      continue;
    }

    if (key === "command" && typeof entry === "string") {
      result[key] = "<REDACTED_COMMAND>";
      continue;
    }

    if (key === "description" && typeof entry === "string") {
      const hasDiscoverySibling = "id" in value || "modelId" in value || "protocolVersion" in value;
      result[key] = hasDiscoverySibling ? entry : "<REDACTED_DESCRIPTION>";
      continue;
    }

    if (key === "prompt") {
      result[key] = "<REDACTED_PROMPT>";
      continue;
    }

    if (key === "output" && typeof entry === "string") {
      result[key] = "<REDACTED_OUTPUT>";
      continue;
    }

    if (key === "preview" && typeof entry === "string") {
      result[key] = "<REDACTED_PREVIEW>";
      continue;
    }

    if (key === "content" && typeof entry === "string") {
      result[key] = "<REDACTED_CONTENT_TEXT>";
      continue;
    }

    if (key === "text" && typeof entry === "string") {
      result[key] = "<REDACTED_TEXT>";
      continue;
    }

    if (Array.isArray(entry)) {
      result[key] = sanitizeArray(entry, context, key);
      continue;
    }

    result[key] = sanitizeUnknown(entry, context);
  }

  return result;
}

function sanitizeUnknown(value: unknown, context: SanitizeContext): unknown {
  if (typeof value === "string") {
    return sanitizeStringValue(value, context);
  }

  if (Array.isArray(value)) {
    return sanitizeArray(value, context);
  }

  if (value && typeof value === "object") {
    return sanitizeObject(value as Record<string, unknown>, context);
  }

  return value;
}

export function sanitizeTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const context = createContext();
  return entries.map((entry) => sanitizeUnknown(entry, context) as TranscriptEntry);
}

export function sanitizeHarnessSummary(summary: HarnessSummary): HarnessSummary {
  const context = createContext();
  return sanitizeUnknown(summary, context) as HarnessSummary;
}

export function sanitizeNotes(notes: string[]): string[] {
  const context = createContext();
  return notes.map((note) => sanitizeStringValue(note, context));
}
