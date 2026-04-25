import type {
  AcpRuntimeDiffSnapshot,
  AcpRuntimeDiffWatcher,
  AcpRuntimeHistoryEntry,
  AcpRuntimeMetadataProjectionUpdate,
  AcpRuntimeOperation,
  AcpRuntimeOperationBundle,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimePermissionRequest,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimeProjectionUpdate,
  AcpRuntimeProjectionWatcher,
  AcpRuntimeOutputPart,
  AcpRuntimePlanItem,
  AcpRuntimePrompt,
  AcpRuntimePromptMessage,
  AcpRuntimePromptPart,
  AcpRuntimeReadModelUpdate,
  AcpRuntimeReadModelWatcher,
  AcpRuntimeSessionMetadata,
  AcpRuntimeTerminalSnapshot,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeThreadEntry,
  AcpRuntimeToolCallBundle,
  AcpRuntimeToolCallSnapshot,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeThreadToolContent,
  AcpRuntimeToolObjectWatcher,
  AcpRuntimeUsage,
} from "./types.js";

type AssistantEntry = Extract<
  AcpRuntimeThreadEntry,
  { kind: "assistant_message" }
>;
type ThoughtEntry = Extract<
  AcpRuntimeThreadEntry,
  { kind: "assistant_thought" }
>;

export class AcpRuntimeSessionTimeline {
  private readonly entriesValue: AcpRuntimeThreadEntry[] = [];
  private readonly timelineValue: AcpRuntimeHistoryEntry[] = [];
  private readonly projectionWatchers = new Set<AcpRuntimeProjectionWatcher>();
  private readonly watchers = new Set<AcpRuntimeReadModelWatcher>();
  private readonly assistantEntries = new Map<string, AssistantEntry>();
  private readonly thoughtEntries = new Map<string, ThoughtEntry>();
  private historyReplayDrained = false;
  private historyReplayLength = 0;
  private nextId = 1;
  private readonly planEntries = new Map<
    string,
    Extract<AcpRuntimeThreadEntry, { kind: "plan" }>
  >();
  private readonly operationSnapshots = new Map<string, AcpRuntimeOperation>();
  private readonly permissionRequestSnapshots = new Map<
    string,
    AcpRuntimePermissionRequest
  >();
  private readonly terminalSnapshots = new Map<string, AcpRuntimeTerminalSnapshot>();
  private readonly toolCallEntries = new Map<
    string,
    Extract<AcpRuntimeThreadEntry, { kind: "tool_call" }>
  >();
  private readonly diffSnapshots = new Map<string, AcpRuntimeDiffSnapshot>();
  private latestMetadataValue: AcpRuntimeSessionMetadata | undefined;
  private latestUsageValue: AcpRuntimeUsage | undefined;

  get entries(): readonly AcpRuntimeThreadEntry[] {
    return this.entriesValue;
  }

  diffPaths(): readonly string[] {
    return [...this.diffSnapshots.keys()];
  }

  diff(path: string): AcpRuntimeDiffSnapshot | undefined {
    return this.diffSnapshots.get(path);
  }

  get diffs(): readonly AcpRuntimeDiffSnapshot[] {
    return [...this.diffSnapshots.values()];
  }

  toolCallIds(): readonly string[] {
    return [...this.toolCallEntries.keys()];
  }

  toolCalls(): readonly AcpRuntimeToolCallSnapshot[] {
    return [...this.toolCallEntries.values()];
  }

  toolCallDiffs(toolCallId: string): readonly AcpRuntimeDiffSnapshot[] {
    return this.diffs.filter((diff) => diff.toolCallId === toolCallId);
  }

  terminalIds(): readonly string[] {
    return [...this.terminalSnapshots.keys()];
  }

  terminal(terminalId: string): AcpRuntimeTerminalSnapshot | undefined {
    return this.terminalSnapshots.get(terminalId);
  }

  get terminals(): readonly AcpRuntimeTerminalSnapshot[] {
    return [...this.terminalSnapshots.values()];
  }

  toolCallTerminals(
    toolCallId: string,
  ): readonly AcpRuntimeTerminalSnapshot[] {
    return this.terminals.filter(
      (terminal) => terminal.toolCallId === toolCallId,
    );
  }

  toolCallBundle(toolCallId: string): AcpRuntimeToolCallBundle | undefined {
    const toolCall = this.getToolCall(toolCallId);
    if (!toolCall) {
      return undefined;
    }
    return {
      diffs: this.toolCallDiffs(toolCallId),
      terminals: this.toolCallTerminals(toolCallId),
      toolCall,
    };
  }

  toolCallBundles(): readonly AcpRuntimeToolCallBundle[] {
    return this.toolCallIds()
      .map((toolCallId) => this.toolCallBundle(toolCallId))
      .filter((bundle): bundle is AcpRuntimeToolCallBundle => Boolean(bundle));
  }

  watch(watcher: AcpRuntimeReadModelWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  watchProjection(watcher: AcpRuntimeProjectionWatcher): () => void {
    this.projectionWatchers.add(watcher);
    return () => {
      this.projectionWatchers.delete(watcher);
    };
  }

  watchDiff(path: string, watcher: AcpRuntimeDiffWatcher): () => void {
    return this.watch((update) => {
      if (update.type === "diff_updated" && update.diff.path === path) {
        watcher(update.diff);
      }
    });
  }

  watchTerminal(
    terminalId: string,
    watcher: AcpRuntimeTerminalWatcher,
  ): () => void {
    return this.watch((update) => {
      if (
        update.type === "terminal_updated" &&
        update.terminal.terminalId === terminalId
      ) {
        watcher(update.terminal);
      }
    });
  }

  watchToolCallObjects(
    toolCallId: string,
    watcher: AcpRuntimeToolObjectWatcher,
  ): () => void {
    return this.watch((update) => {
      if (
        update.type === "diff_updated" &&
        update.diff.toolCallId === toolCallId
      ) {
        watcher(update);
      } else if (
        update.type === "terminal_updated" &&
        update.terminal.toolCallId === toolCallId
      ) {
        watcher(update);
      }
    });
  }

  watchToolCall(
    toolCallId: string,
    watcher: AcpRuntimeToolCallWatcher,
  ): () => void {
    return this.watch((update) => {
      const bundle = this.toolCallBundle(toolCallId);
      if (!bundle) {
        return;
      }
      if (
        (update.type === "thread_entry_added" ||
          update.type === "thread_entry_updated") &&
        update.entry.kind === "tool_call" &&
        update.entry.toolCallId === toolCallId
      ) {
        watcher(bundle);
        return;
      }
      if (
        update.type === "diff_updated" &&
        update.diff.toolCallId === toolCallId
      ) {
        watcher(bundle);
        return;
      }
      if (
        update.type === "terminal_updated" &&
        update.terminal.toolCallId === toolCallId
      ) {
        watcher(bundle);
      }
    });
  }

  getToolCall(
    toolCallId: string,
  ): AcpRuntimeToolCallSnapshot | undefined {
    return this.toolCallEntries.get(toolCallId);
  }

  operationIds(): readonly string[] {
    return [...this.operationSnapshots.keys()];
  }

  operation(operationId: string): AcpRuntimeOperation | undefined {
    return this.operationSnapshots.get(operationId);
  }

  get operations(): readonly AcpRuntimeOperation[] {
    return [...this.operationSnapshots.values()];
  }

  operationPermissionRequests(
    operationId: string,
  ): readonly AcpRuntimePermissionRequest[] {
    return this.permissionRequests.filter(
      (request) => request.operationId === operationId,
    );
  }

  operationBundle(operationId: string): AcpRuntimeOperationBundle | undefined {
    const operation = this.operation(operationId);
    if (!operation) {
      return undefined;
    }
    return {
      operation,
      permissionRequests: this.operationPermissionRequests(operationId),
    };
  }

  operationBundles(): readonly AcpRuntimeOperationBundle[] {
    return this.operationIds()
      .map((operationId) => this.operationBundle(operationId))
      .filter(
        (bundle): bundle is AcpRuntimeOperationBundle => Boolean(bundle),
      );
  }

  permissionRequestIds(): readonly string[] {
    return [...this.permissionRequestSnapshots.keys()];
  }

  permissionRequest(
    requestId: string,
  ): AcpRuntimePermissionRequest | undefined {
    return this.permissionRequestSnapshots.get(requestId);
  }

  get permissionRequests(): readonly AcpRuntimePermissionRequest[] {
    return [...this.permissionRequestSnapshots.values()];
  }

  get projectionMetadata(): AcpRuntimeSessionMetadata | undefined {
    return this.latestMetadataValue;
  }

  get projectionUsage(): AcpRuntimeUsage | undefined {
    return this.latestUsageValue;
  }

  watchOperation(
    operationId: string,
    watcher: AcpRuntimeOperationWatcher,
  ): () => void {
    return this.watchProjection((update) => {
      if (
        update.type === "operation_projection_updated" &&
        update.operation.id === operationId
      ) {
        watcher(update.operation);
      }
    });
  }

  watchPermissionRequest(
    requestId: string,
    watcher: AcpRuntimePermissionRequestWatcher,
  ): () => void {
    return this.watchProjection((update) => {
      if (
        update.type === "permission_projection_updated" &&
        update.request.id === requestId
      ) {
        watcher(update.request);
      }
    });
  }

  watchOperationBundle(
    operationId: string,
    watcher: AcpRuntimeOperationBundleWatcher,
  ): () => void {
    return this.watchProjection((update) => {
      const bundle = this.operationBundle(operationId);
      if (!bundle) {
        return;
      }
      if (
        update.type === "operation_projection_updated" &&
        update.operation.id === operationId
      ) {
        watcher(bundle);
        return;
      }
      if (
        update.type === "permission_projection_updated" &&
        update.request.operationId === operationId
      ) {
        watcher(bundle);
      }
    });
  }

  upsertTerminalSnapshot(input: {
    command?: string;
    completedAt?: string;
    cwd?: string;
    exitCode?: number | null;
    output?: string;
    releasedAt?: string;
    status?: AcpRuntimeTerminalSnapshot["status"];
    stopRequestedAt?: string;
    terminalId: string;
    toolCallId?: string;
    truncated?: boolean;
  }): AcpRuntimeTerminalSnapshot {
    const previous = this.terminalSnapshots.get(input.terminalId);
    const now = new Date().toISOString();
    const output = input.output ?? previous?.output;
    const status = input.status ?? previous?.status ?? "unknown";
    const snapshot = {
      command: input.command ?? previous?.command,
      completedAt:
        input.completedAt ??
        (status === "completed" ? previous?.completedAt ?? now : previous?.completedAt),
      createdAt: previous?.createdAt ?? now,
      cwd: input.cwd ?? previous?.cwd,
      exitCode:
        input.exitCode !== undefined ? input.exitCode : previous?.exitCode,
      output,
      outputLength: output !== undefined ? output.length : undefined,
      outputLineCount: output !== undefined ? countLines(output) : undefined,
      releasedAt: input.releasedAt ?? previous?.releasedAt,
      revision: (previous?.revision ?? 0) + 1,
      status,
      stopRequestedAt: input.stopRequestedAt ?? previous?.stopRequestedAt,
      terminalId: input.terminalId,
      toolCallId: input.toolCallId ?? previous?.toolCallId,
      truncated: input.truncated ?? previous?.truncated,
      updatedAt: now,
    } satisfies AcpRuntimeTerminalSnapshot;
    this.terminalSnapshots.set(input.terminalId, snapshot);
    this.emit({
      terminal: { ...snapshot },
      type: "terminal_updated",
    });
    return snapshot;
  }

  appendHistoryUser(text: string): void {
    this.appendTimelineEntry({ text, type: "user" });
    const entry = {
      id: this.nextEntryId("user"),
      kind: "user_message",
      text,
    } satisfies Extract<AcpRuntimeThreadEntry, { kind: "user_message" }>;
    this.entriesValue.push(entry);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  appendPrompt(prompt: AcpRuntimePrompt, turnId: string): void {
    const text = promptToThreadText(prompt);
    if (!text) {
      return;
    }
    const entry = {
      id: this.nextEntryId("user"),
      kind: "user_message",
      text,
      turnId,
    } satisfies Extract<AcpRuntimeThreadEntry, { kind: "user_message" }>;
    this.entriesValue.push(entry);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  appendTimelineEntry(entry: AcpRuntimeHistoryEntry): void {
    this.timelineValue.push(entry);
    if (entry.type !== "user") {
      this.applyProjectionEvent(entry);
    }
  }

  appendTimelineEntries(entries: readonly AcpRuntimeHistoryEntry[]): void {
    for (const entry of entries) {
      this.appendTimelineEntry(entry);
    }
  }

  upsertToolCall(input: {
    content?: readonly AcpRuntimeThreadToolContent[];
    locations?: Extract<AcpRuntimeThreadEntry, { kind: "tool_call" }>["locations"];
    rawInput?: unknown;
    rawOutput?: unknown;
    status?: Extract<
      AcpRuntimeThreadEntry,
      { kind: "tool_call" }
    >["status"];
    title?: string;
    toolCallId: string;
    toolKind?: string;
    turnId: string;
  }): void {
    const existing = this.toolCallEntries.get(input.toolCallId);
    if (existing) {
      existing.status = input.status ?? existing.status;
      existing.title = input.title ?? existing.title;
      existing.toolKind = input.toolKind ?? existing.toolKind;
      existing.locations = input.locations ?? existing.locations;
      existing.rawInput = input.rawInput ?? existing.rawInput;
      existing.rawOutput = input.rawOutput ?? existing.rawOutput;
      if (input.content) {
        existing.content = mergeToolContent(existing.content, input.content);
        this.syncDerivedSnapshots(existing.toolCallId, existing.content);
      }
      this.emit({
        entry: cloneThreadEntry(existing),
        type: "thread_entry_updated",
      });
      return;
    }

    const entry: Extract<AcpRuntimeThreadEntry, { kind: "tool_call" }> = {
      content: input.content ?? [],
      id: this.nextEntryId("tool-call"),
      kind: "tool_call",
      locations: input.locations,
      rawInput: input.rawInput,
      rawOutput: input.rawOutput,
      status: input.status ?? "pending",
      title: input.title ?? "Tool call",
      toolCallId: input.toolCallId,
      toolKind: input.toolKind,
      turnId: input.turnId,
    };
    this.toolCallEntries.set(input.toolCallId, entry);
    this.entriesValue.push(entry);
    this.syncDerivedSnapshots(entry.toolCallId, entry.content);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  drainHistoryEntries(): readonly AcpRuntimeHistoryEntry[] {
    if (this.historyReplayDrained || this.historyReplayLength === 0) {
      return [];
    }
    this.historyReplayDrained = true;
    return this.timelineValue.slice(0, this.historyReplayLength);
  }

  sealHistoryReplay(): void {
    if (this.historyReplayLength > 0) {
      return;
    }
    this.historyReplayLength = this.timelineValue.length;
  }

  appendAssistantText(
    turnId: string,
    textChunk: string,
    output?: readonly AcpRuntimeOutputPart[],
  ): void {
    this.upsertAssistant(turnId, textChunk, output, "streaming");
  }

  appendThoughtText(turnId: string, textChunk: string): void {
    this.upsertThought(turnId, textChunk, "streaming");
  }

  updatePlan(turnId: string, plan: readonly AcpRuntimePlanItem[]): void {
    this.upsertPlan(turnId, plan);
  }

  completeTurn(
    turnId: string,
    output: readonly AcpRuntimeOutputPart[] | undefined,
    status: "completed" | "failed",
  ): void {
    const assistant = this.assistantEntries.get(turnId);
    if (assistant) {
      assistant.status = status;
      if (output) {
        assistant.output = output;
      }
    }
    const thought = this.thoughtEntries.get(turnId);
    if (thought) {
      thought.status = status;
    }
  }

  private nextEntryId(prefix: string): string {
    const id = `${prefix}-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private emit(update: AcpRuntimeReadModelUpdate): void {
    for (const watcher of this.watchers) {
      watcher(update);
    }
  }

  private emitProjection(update: AcpRuntimeProjectionUpdate): void {
    for (const watcher of this.projectionWatchers) {
      watcher(update);
    }
  }

  private applyProjectionEvent(event: Exclude<AcpRuntimeHistoryEntry, { type: "user" }>): void {
    switch (event.type) {
      case "operation_started":
      case "operation_updated":
      case "operation_completed":
      case "operation_failed": {
        const operation = cloneOperation(event.operation);
        this.operationSnapshots.set(operation.id, operation);
        this.emitProjection({
          errorMessage:
            event.type === "operation_failed" ? event.error.message : undefined,
          lifecycle:
            event.type === "operation_started"
              ? "started"
              : event.type === "operation_updated"
                ? "updated"
                : event.type === "operation_completed"
                  ? "completed"
                  : "failed",
          operation,
          turnId: event.turnId,
          type: "operation_projection_updated",
        });
        return;
      }
      case "permission_requested":
      case "permission_resolved": {
        const request = clonePermissionRequest(event.request);
        this.permissionRequestSnapshots.set(request.id, request);
        const operation = cloneOperation(event.operation);
        this.operationSnapshots.set(operation.id, operation);
        this.emitProjection({
          decision:
            event.type === "permission_resolved" ? event.decision : undefined,
          lifecycle:
            event.type === "permission_requested" ? "requested" : "resolved",
          operation,
          request,
          turnId: event.turnId,
          type: "permission_projection_updated",
        });
        return;
      }
      case "metadata_updated": {
        const metadata = cloneMetadata(event.metadata);
        this.latestMetadataValue = metadata;
        this.emitProjection({
          metadata,
          turnId: event.turnId,
          type: "metadata_projection_updated",
        } satisfies AcpRuntimeMetadataProjectionUpdate);
        return;
      }
      case "usage_updated": {
        const usage = { ...event.usage };
        this.latestUsageValue = usage;
        this.emitProjection({
          turnId: event.turnId,
          type: "usage_projection_updated",
          usage,
        });
        return;
      }
      default:
        return;
    }
  }

  private upsertAssistant(
    turnId: string,
    textChunk: string,
    output: readonly AcpRuntimeOutputPart[] | undefined,
    status: AssistantEntry["status"],
  ): void {
    const existing = this.assistantEntries.get(turnId);
    if (existing) {
      existing.text += textChunk;
      existing.status = status;
      if (output) {
        existing.output = output;
      }
      this.emit({
        entry: cloneThreadEntry(existing),
        type: "thread_entry_updated",
      });
      return;
    }
    const entry: AssistantEntry = {
      id: this.nextEntryId("assistant"),
      kind: "assistant_message",
      output,
      status,
      text: textChunk,
      turnId,
    };
    this.assistantEntries.set(turnId, entry);
    this.entriesValue.push(entry);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  private upsertPlan(turnId: string, plan: readonly AcpRuntimePlanItem[]): void {
    const existing = this.planEntries.get(turnId);
    if (existing) {
      existing.plan = plan;
      this.emit({
        entry: cloneThreadEntry(existing),
        type: "thread_entry_updated",
      });
      return;
    }
    const entry: Extract<AcpRuntimeThreadEntry, { kind: "plan" }> = {
      id: this.nextEntryId("plan"),
      kind: "plan",
      plan,
      turnId,
    };
    this.planEntries.set(turnId, entry);
    this.entriesValue.push(entry);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  private upsertThought(
    turnId: string,
    textChunk: string,
    status: ThoughtEntry["status"],
  ): void {
    const existing = this.thoughtEntries.get(turnId);
    if (existing) {
      existing.text += textChunk;
      existing.status = status;
      this.emit({
        entry: cloneThreadEntry(existing),
        type: "thread_entry_updated",
      });
      return;
    }
    const entry: ThoughtEntry = {
      id: this.nextEntryId("thought"),
      kind: "assistant_thought",
      status,
      text: textChunk,
      turnId,
    };
    this.thoughtEntries.set(turnId, entry);
    this.entriesValue.push(entry);
    this.emit({
      entry: cloneThreadEntry(entry),
      type: "thread_entry_added",
    });
  }

  private syncDerivedSnapshots(
    toolCallId: string,
    content: readonly AcpRuntimeThreadToolContent[],
  ): void {
    for (const item of content) {
      if (item.kind === "terminal") {
        this.upsertTerminalSnapshot({
          command: item.command,
          cwd: item.cwd,
          exitCode: item.exitCode,
          output: item.output,
          status: item.status,
          terminalId: item.terminalId,
          toolCallId,
          truncated: item.truncated,
        });
        continue;
      }

      if (item.kind === "diff") {
        const previous = this.diffSnapshots.get(item.path);
        const now = new Date().toISOString();
        const snapshot = {
          changeType: item.changeType,
          createdAt: previous?.createdAt ?? now,
          newLineCount: countLines(item.newText),
          newText: item.newText,
          oldLineCount:
            item.oldText !== undefined ? countLines(item.oldText) : undefined,
          oldText: item.oldText,
          path: item.path,
          revision: (previous?.revision ?? 0) + 1,
          toolCallId,
          updatedAt: now,
        } satisfies AcpRuntimeDiffSnapshot;
        this.diffSnapshots.set(item.path, snapshot);
        this.emit({
          diff: { ...snapshot },
          type: "diff_updated",
        });
      }
    }
  }
}

function cloneThreadEntry(entry: AcpRuntimeThreadEntry): AcpRuntimeThreadEntry {
  switch (entry.kind) {
    case "assistant_message":
      return {
        ...entry,
        output: entry.output ? [...entry.output] : undefined,
      };
    case "assistant_thought":
    case "user_message":
      return { ...entry };
    case "plan":
      return {
        ...entry,
        plan: [...entry.plan],
      };
    case "tool_call":
      return {
        ...entry,
        content: [...entry.content],
        locations: entry.locations ? [...entry.locations] : undefined,
      };
  }
}

function mergeToolContent(
  existing: readonly AcpRuntimeThreadToolContent[],
  incoming: readonly AcpRuntimeThreadToolContent[],
): readonly AcpRuntimeThreadToolContent[] {
  if (existing.length === 0) {
    return incoming;
  }

  return incoming.map((next) => {
    const previous = existing.find((entry) => toolContentKey(entry) === toolContentKey(next));
    if (!previous) {
      return next;
    }

    if (next.kind === "terminal" && previous.kind === "terminal") {
      return {
        ...previous,
        ...next,
        command: next.command ?? previous.command,
        cwd: next.cwd ?? previous.cwd,
        output: next.output ?? previous.output,
        truncated: next.truncated ?? previous.truncated,
      };
    }

    if (next.kind === "diff" && previous.kind === "diff") {
      return {
        ...previous,
        ...next,
        changeType: next.changeType ?? previous.changeType,
      };
    }

    return next;
  });
}

function toolContentKey(content: AcpRuntimeThreadToolContent): string {
  switch (content.kind) {
    case "terminal":
      return `terminal:${content.terminalId}`;
    case "diff":
      return `diff:${content.path}`;
    case "content":
      return `content:${content.id}`;
  }
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split("\n").length;
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
    permission: operation.permission ? { ...operation.permission } : undefined,
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

function clonePermissionRequest(
  request: AcpRuntimePermissionRequest,
): AcpRuntimePermissionRequest {
  return {
    ...request,
    scopeOptions: [...request.scopeOptions],
  };
}

function promptToThreadText(prompt: AcpRuntimePrompt): string {
  if (typeof prompt === "string") {
    return prompt;
  }

  if (!Array.isArray(prompt)) {
    return "";
  }

  if (prompt.length === 0) {
    return "";
  }

  const first = prompt[0];
  if (isPromptMessage(first)) {
    return prompt
      .flatMap((message) =>
        isPromptMessage(message) && message.role === "user"
          ? normalizePromptContent(message.content)
          : [],
      )
      .join("\n\n")
      .trim();
  }

  return normalizePromptContent(prompt as readonly AcpRuntimePromptPart[])
    .join("\n")
    .trim();
}

function isPromptMessage(value: unknown): value is AcpRuntimePromptMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    "content" in value
  );
}

function normalizePromptContent(
  content: string | readonly AcpRuntimePromptPart[],
): string[] {
  if (typeof content === "string") {
    return [content];
  }
  return content.flatMap((part) => normalizePromptPart(part));
}

function normalizePromptPart(part: AcpRuntimePromptPart): string[] {
  switch (part.type) {
    case "text":
      return [part.text];
    case "json":
      return [JSON.stringify(part.value)];
    case "resource":
      return [part.text ?? part.title ?? part.uri];
    case "file":
      return [part.title ?? part.uri];
    case "image":
      return [part.alt ?? part.uri];
    case "audio":
      return [part.title ?? part.mediaType];
    default:
      return [];
  }
}
