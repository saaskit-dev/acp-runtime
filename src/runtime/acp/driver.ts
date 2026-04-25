import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ToolCallLocation,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { AcpProcessError, AcpProtocolError } from "../core/errors.js";
import type { AcpSessionDriver } from "../core/session-driver.js";
import {
  type AcpRuntimeDiagnostics,
  type AcpRuntimeDiffWatcher,
  type AcpRuntimeHistoryEntry,
  type AcpRuntimeOperation,
  type AcpRuntimeOperationBundle,
  type AcpRuntimeOperationBundleWatcher,
  type AcpRuntimeOperationWatcher,
  type AcpRuntimePermissionRequest,
  type AcpRuntimePermissionRequestWatcher,
  type AcpRuntimePrompt,
  type AcpRuntimeProjectionWatcher,
  type AcpRuntimeReadModelWatcher,
  type AcpRuntimeSessionMetadata,
  type AcpRuntimeSessionStatus,
  type AcpRuntimeSnapshot,
  type AcpRuntimeStreamOptions,
  type AcpRuntimeTerminalHandler,
  type AcpRuntimeTerminalSnapshot,
  type AcpRuntimeThreadEntry,
  type AcpRuntimeToolCallBundle,
  type AcpRuntimeToolCallSnapshot,
  type AcpRuntimeToolCallWatcher,
  type AcpRuntimeThreadToolContent,
  type AcpRuntimeToolObjectWatcher,
  type AcpRuntimeTerminalWatcher,
  type AcpRuntimeTurnEvent,
  type AcpRuntimeUsage,
  type AcpRuntimeAuthorityHandlers,
} from "../core/types.js";
import { ACP_RUNTIME_SNAPSHOT_VERSION } from "../core/constants.js";
import { AcpRuntimeSessionTimeline } from "../core/session-timeline.js";
import type { AcpSessionBootstrap } from "./connection-types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import {
  createInitialMetadata,
  mapInitializeResponseToCapabilities,
} from "./capability-mapper.js";
import type { AcpAgentProfile } from "./profiles/index.js";
import {
  applyPermissionDecision,
  finalizePromptResponse,
  mapPermissionDecisionToAcp,
  mapPermissionRequest,
  mapSessionUpdateToRuntimeEvents,
  mapUsage,
} from "./session-update-mapper.js";
import { mapPromptToAcp } from "./prompt-mapper.js";
import { createTurnState, type AcpRuntimeTurnState } from "./turn-state.js";

class AsyncEventQueue<T> {
  private closed = false;
  private pendingResolves: Array<(value: IteratorResult<T>) => void> = [];
  private values: T[] = [];

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    while (this.pendingResolves.length > 0) {
      const resolve = this.pendingResolves.shift();
      resolve?.({ done: true, value: undefined });
    }
  }

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolve = this.pendingResolves.shift();
    if (resolve) {
      resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return {
        done: false,
        value: this.values.shift() as T,
      };
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    return new Promise<IteratorResult<T>>((resolve) => {
      this.pendingResolves.push(resolve);
    });
  }
}

type ActiveTurn = {
  queue: AsyncEventQueue<AcpRuntimeTurnEvent>;
  state: AcpRuntimeTurnState;
};

export class AcpSdkSessionDriver implements AcpSessionDriver {
  private currentTurn: ActiveTurn | undefined;
  private readonly diagnosticsValue: AcpRuntimeDiagnostics = {};
  private readonly historyTurn = createTurnState();
  private readonly metadataValue: AcpRuntimeSessionMetadata;
  private statusValue: AcpRuntimeSessionStatus = "ready";
  private readonly timeline = new AcpRuntimeSessionTimeline();

  readonly capabilities;

  constructor(
    private readonly bridge: AcpClientBridge,
    private readonly bootstrap: AcpSessionBootstrap & {
      handlers?: AcpRuntimeAuthorityHandlers;
      initializeResponse: import("@agentclientprotocol/sdk").InitializeResponse;
      profile: AcpAgentProfile;
    },
  ) {
    this.capabilities = mapInitializeResponseToCapabilities({
      handlers: bootstrap.handlers,
      response: bootstrap.initializeResponse,
    });
    this.metadataValue = createInitialMetadata({
      configOptions: bootstrap.response.configOptions,
      modes: bootstrap.response.modes,
      sessionId: bootstrap.sessionId,
    });
    this.bridge.setPermissionHandler((params) =>
      this.handlePermissionRequest(params),
    );
    this.bridge.setSessionUpdateHandler((params) =>
      this.handleSessionUpdate(params),
    );
  }

  get diagnostics(): Readonly<AcpRuntimeDiagnostics> {
    return this.diagnosticsValue;
  }

  get metadata(): Readonly<AcpRuntimeSessionMetadata> {
    return this.metadataValue;
  }

  get status(): AcpRuntimeSessionStatus {
    return this.statusValue;
  }

  listAgentConfigOptions() {
    return this.metadataValue.agentConfigOptions ?? [];
  }

  listAgentModes() {
    return this.metadataValue.agentModes ?? [];
  }

  drainHistoryEntries(): readonly AcpRuntimeHistoryEntry[] {
    return this.timeline.drainHistoryEntries();
  }

  diffPaths() {
    return this.timeline.diffPaths();
  }

  diff(path: string) {
    return this.timeline.diff(path);
  }

  diffs() {
    return this.timeline.diffs;
  }

  operation(operationId: string): AcpRuntimeOperation | undefined {
    return this.timeline.operation(operationId);
  }

  operationBundle(operationId: string): AcpRuntimeOperationBundle | undefined {
    return this.timeline.operationBundle(operationId);
  }

  operationBundles(): readonly AcpRuntimeOperationBundle[] {
    return this.timeline.operationBundles();
  }

  operationIds() {
    return this.timeline.operationIds();
  }

  operationPermissionRequests(operationId: string) {
    return this.timeline.operationPermissionRequests(operationId);
  }

  operations() {
    return this.timeline.operations;
  }

  permissionRequest(
    requestId: string,
  ): AcpRuntimePermissionRequest | undefined {
    return this.timeline.permissionRequest(requestId);
  }

  permissionRequestIds() {
    return this.timeline.permissionRequestIds();
  }

  permissionRequests() {
    return this.timeline.permissionRequests;
  }

  projectionMetadata(): AcpRuntimeSessionMetadata | undefined {
    return this.timeline.projectionMetadata;
  }

  projectionUsage(): AcpRuntimeUsage | undefined {
    return this.timeline.projectionUsage;
  }

  sealHistoryReplay(): void {
    this.timeline.completeTurn(this.historyTurn.turnId, undefined, "completed");
    this.timeline.sealHistoryReplay();
  }

  terminals() {
    return this.timeline.terminals;
  }

  terminalIds() {
    return this.timeline.terminalIds();
  }

  terminal(terminalId: string) {
    return this.timeline.terminal(terminalId);
  }

  toolCall(toolCallId: string): AcpRuntimeToolCallSnapshot | undefined {
    return this.timeline.getToolCall(toolCallId);
  }

  toolCallBundles(): readonly AcpRuntimeToolCallBundle[] {
    return this.timeline.toolCallBundles();
  }

  toolCallBundle(toolCallId: string): AcpRuntimeToolCallBundle | undefined {
    return this.timeline.toolCallBundle(toolCallId);
  }

  threadEntries(): readonly AcpRuntimeThreadEntry[] {
    return this.timeline.entries;
  }

  toolCallDiffs(toolCallId: string) {
    return this.timeline.toolCallDiffs(toolCallId);
  }

  toolCallIds() {
    return this.timeline.toolCallIds();
  }

  toolCalls() {
    return this.timeline.toolCalls();
  }

  toolCallTerminals(toolCallId: string) {
    return this.timeline.toolCallTerminals(toolCallId);
  }

  watchReadModel(watcher: AcpRuntimeReadModelWatcher): () => void {
    return this.timeline.watch(watcher);
  }

  watchProjection(watcher: AcpRuntimeProjectionWatcher): () => void {
    return this.timeline.watchProjection(watcher);
  }

  watchOperation(
    operationId: string,
    watcher: AcpRuntimeOperationWatcher,
  ): () => void {
    return this.timeline.watchOperation(operationId, watcher);
  }

  watchOperationBundle(
    operationId: string,
    watcher: AcpRuntimeOperationBundleWatcher,
  ): () => void {
    return this.timeline.watchOperationBundle(operationId, watcher);
  }

  watchPermissionRequest(
    requestId: string,
    watcher: AcpRuntimePermissionRequestWatcher,
  ): () => void {
    return this.timeline.watchPermissionRequest(requestId, watcher);
  }

  watchDiff(path: string, watcher: AcpRuntimeDiffWatcher): () => void {
    return this.timeline.watchDiff(path, watcher);
  }

  watchTerminal(
    terminalId: string,
    watcher: AcpRuntimeTerminalWatcher,
  ): () => void {
    return this.timeline.watchTerminal(terminalId, watcher);
  }

  watchToolCallObjects(
    toolCallId: string,
    watcher: AcpRuntimeToolObjectWatcher,
  ): () => void {
    return this.timeline.watchToolCallObjects(toolCallId, watcher);
  }

  watchToolCall(
    toolCallId: string,
    watcher: AcpRuntimeToolCallWatcher,
  ): () => void {
    return this.timeline.watchToolCall(toolCallId, watcher);
  }

  async killTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    const terminalHandler = this.requireTerminalHandler();
    await terminalHandler.kill(terminalId);
    const output = await this.readTerminalOutputSnapshot(
      terminalHandler,
      terminalId,
    );
    return this.timeline.upsertTerminalSnapshot({
      exitCode: output?.exitCode,
      output: output?.output,
      status: mapTerminalStatus(output?.exitCode),
      stopRequestedAt: new Date().toISOString(),
      terminalId,
      truncated: output?.truncated,
    });
  }

  async refreshTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    const terminalHandler = this.requireTerminalHandler();
    const output = await terminalHandler.output(terminalId);
    return this.timeline.upsertTerminalSnapshot({
      exitCode: output.exitCode,
      output: output.output,
      status: mapTerminalStatus(output.exitCode),
      terminalId,
      truncated: output.truncated,
    });
  }

  async releaseTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    const terminalHandler = this.requireTerminalHandler();
    await terminalHandler.release(terminalId);
    return this.timeline.upsertTerminalSnapshot({
      releasedAt: new Date().toISOString(),
      terminalId,
    });
  }

  async waitForTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    const terminalHandler = this.requireTerminalHandler();
    const waitResult = await terminalHandler.wait(terminalId);
    const output = await this.readTerminalOutputSnapshot(
      terminalHandler,
      terminalId,
    );
    return this.timeline.upsertTerminalSnapshot({
      completedAt: new Date().toISOString(),
      exitCode: output?.exitCode ?? waitResult.exitCode,
      output: output?.output,
      status: "completed",
      terminalId,
      truncated: output?.truncated,
    });
  }

  async cancel(): Promise<void> {
    if (this.currentTurn) {
      this.currentTurn.state.cancelRequested = true;
    }
    await this.bootstrap.connection.cancel({
      sessionId: this.bootstrap.sessionId,
    });
  }

  async close(): Promise<void> {
    if (this.statusValue === "closed") {
      return;
    }

    this.statusValue = "closed";
    this.currentTurn?.queue.close();
    if (this.bootstrap.connection.closeSession) {
      await Promise.race([
        this.bootstrap.connection
          .closeSession({
            sessionId: this.bootstrap.sessionId,
          })
          .catch(() => {}),
        waitFor(1_000),
      ]);
    }
    await this.bootstrap.dispose?.();
  }

  async setAgentConfigOption(
    id: string,
    value: string,
  ): Promise<void> {
    if (!this.bootstrap.connection.setSessionConfigOption) {
      throw new AcpProtocolError(
        "ACP agent does not support session config option updates.",
      );
    }

    await this.bootstrap.connection.setSessionConfigOption({
      configId: id,
      sessionId: this.bootstrap.sessionId,
      value,
    });
    this.updateConfigOptionValue(id, value);
  }

  async setAgentMode(modeId: string): Promise<void> {
    if (!this.bootstrap.connection.setSessionMode) {
      throw new AcpProtocolError("ACP agent does not support session mode updates.");
    }

    await this.bootstrap.connection.setSessionMode({
      modeId,
      sessionId: this.bootstrap.sessionId,
    });
    this.metadataValue.currentModeId = modeId;
  }

  snapshot(): AcpRuntimeSnapshot {
    return {
      agent: this.bootstrap.agent,
      config: this.metadataValue.config,
      currentModeId: this.metadataValue.currentModeId,
      cwd: this.bootstrap.cwd,
      mcpServers: [...this.bootstrap.mcpServers],
      session: {
        id: this.bootstrap.sessionId,
      },
      version: ACP_RUNTIME_SNAPSHOT_VERSION,
    };
  }

  async *stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    if (this.statusValue === "closed") {
      throw new AcpProcessError("Session is closed.");
    }
    if (this.currentTurn) {
      throw new AcpProtocolError("Session already has an active turn.");
    }

    const activeTurn: ActiveTurn = {
      queue: new AsyncEventQueue<AcpRuntimeTurnEvent>(),
      state: createTurnState(),
    };
    this.currentTurn = activeTurn;
    this.statusValue = "running";

    const cleanupAbort = this.installAbortHandlers(activeTurn, options);
    this.timeline.appendPrompt(prompt, activeTurn.state.turnId);
    this.emitTurnEvent(activeTurn, {
      turnId: activeTurn.state.turnId,
      type: "started",
    });

    void this.startPrompt(activeTurn, prompt);

    try {
      while (true) {
        const next = await activeTurn.queue.next();
        if (next.done) {
          break;
        }
        yield next.value;
      }
    } finally {
      cleanupAbort();
      this.currentTurn = undefined;
      this.restoreReadyStatus();
    }
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (!this.currentTurn) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    const mapped = mapPermissionRequest({
      params,
      profile: this.bootstrap.profile,
      turn: this.currentTurn.state,
    });
    this.emitTurnEvent(this.currentTurn, {
      operation: mapped.operation,
      turnId: this.currentTurn.state.turnId,
      type: "operation_updated",
    });
    this.emitTurnEvent(this.currentTurn, {
      operation: mapped.operation,
      request: mapped.request,
      turnId: this.currentTurn.state.turnId,
      type: "permission_requested",
    });

    const decision = await this.resolvePermissionDecision(mapped.request);
    mapped.request.phase = decision.decision === "allow" ? "allowed" : "denied";
    if (decision.decision === "deny") {
      this.currentTurn.state.deniedOperationIds.add(mapped.operation.id);
    }
    const resolvedOperation = applyPermissionDecision({
      decision,
      operationId: mapped.operation.id,
      turn: this.currentTurn.state,
    });

    this.emitTurnEvent(this.currentTurn, {
      decision: decision.decision === "allow" ? "allowed" : "denied",
      operation: resolvedOperation,
      request: mapped.request,
      turnId: this.currentTurn.state.turnId,
      type: "permission_resolved",
    });

    return mapPermissionDecisionToAcp(params.options, decision);
  }

  private async handleSessionUpdate(
    params: SessionNotification,
  ): Promise<void> {
    if (params.sessionId !== this.bootstrap.sessionId) {
      return;
    }

    await this.syncThreadEntriesFromSessionUpdate(
      params,
      this.currentTurn?.state.turnId ?? this.historyTurn.turnId,
    );

    if (!this.currentTurn) {
      if (params.update.sessionUpdate === "user_message_chunk") {
        const text = extractHistoryText(params.update.content);
        if (text) {
          this.timeline.appendHistoryUser(text);
        }
      }

      const historyEvents = mapSessionUpdateToRuntimeEvents({
        diagnostics: this.diagnosticsValue,
        metadata: this.metadataValue,
        notification: params,
        profile: this.bootstrap.profile,
        turn: this.historyTurn,
      });
      this.timeline.appendTimelineEntries(historyEvents);
      return;
    }

    const events = mapSessionUpdateToRuntimeEvents({
      diagnostics: this.diagnosticsValue,
      metadata: this.metadataValue,
      notification: params,
      profile: this.bootstrap.profile,
      turn: this.currentTurn.state,
    });
    for (const event of events) {
      this.emitTurnEvent(this.currentTurn, event);
    }
  }

  private installAbortHandlers(
    activeTurn: ActiveTurn,
    options: AcpRuntimeStreamOptions | undefined,
  ): () => void {
    const onAbort = () => {
      activeTurn.state.cancelRequested = true;
      void this.cancel();
    };
    if (options?.signal?.aborted) {
      onAbort();
    } else {
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const timeout = options?.timeoutMs
      ? setTimeout(() => {
          activeTurn.state.cancelRequested = true;
          activeTurn.state.timedOut = true;
          void this.cancel();
        }, options.timeoutMs)
      : undefined;

    return () => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }

  private async startPrompt(
    activeTurn: ActiveTurn,
    prompt: AcpRuntimePrompt,
  ): Promise<void> {
    let response: PromptResponse;
    try {
      response = await this.bootstrap.connection.prompt({
        prompt: mapPromptToAcp(prompt),
        sessionId: this.bootstrap.sessionId,
      });
    } catch (error) {
      const normalizedResponse = this.bootstrap.profile.normalizePromptError?.({
        error,
        turn: activeTurn.state,
      });
      if (normalizedResponse) {
        response = normalizedResponse;
      } else {
      this.diagnosticsValue.lastError = {
        code: "PROCESS_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
      const failedEvent = {
        error: new AcpProcessError("ACP prompt request failed.", error),
        turnId: activeTurn.state.turnId,
        type: "failed",
      } satisfies AcpRuntimeTurnEvent;
      this.timeline.completeTurn(activeTurn.state.turnId, undefined, "failed");
      this.emitTurnEvent(activeTurn, failedEvent);
      activeTurn.queue.close();
      return;
      }
    }

    const usage = mapUsage(response.usage ?? undefined);
    if (usage) {
      this.diagnosticsValue.lastUsage = usage;
    }

    for (const event of finalizePromptResponse({
      response,
      turn: activeTurn.state,
    })) {
      if (event.type === "completed") {
        this.timeline.completeTurn(
          activeTurn.state.turnId,
          event.output,
          "completed",
        );
      } else if (event.type === "failed") {
        this.timeline.completeTurn(activeTurn.state.turnId, undefined, "failed");
      }
      this.emitTurnEvent(activeTurn, event);
    }
    activeTurn.queue.close();
  }

  private async resolvePermissionDecision(
    request: import("../core/types.js").AcpRuntimePermissionRequest,
  ): Promise<import("../core/types.js").AcpRuntimePermissionDecision> {
    if (this.bootstrap.handlers?.permission) {
      return this.bootstrap.handlers.permission(request);
    }
    return {
      decision: "deny",
    };
  }

  private updateConfigOptionValue(
    id: string,
    value: string,
  ): void {
    this.metadataValue.config = {
      ...(this.metadataValue.config ?? {}),
      [id]: value,
    };
    this.metadataValue.agentConfigOptions = (
      this.metadataValue.agentConfigOptions ?? []
    ).map((option) =>
      option.id === id
        ? {
            ...option,
            value,
          }
        : option,
    );
  }

  private restoreReadyStatus(): void {
    if (this.statusValue !== "closed") {
      this.statusValue = "ready";
    }
  }

  private emitTurnEvent(
    activeTurn: ActiveTurn,
    event: AcpRuntimeTurnEvent,
  ): void {
    this.timeline.appendTimelineEntry(event);
    activeTurn.queue.push(event);
  }

  private async syncThreadEntriesFromSessionUpdate(
    params: SessionNotification,
    turnId: string,
  ): Promise<void> {
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = extractHistoryText(update.content);
      if (text) {
        this.timeline.appendAssistantText(turnId, text);
      }
      return;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      const text = extractHistoryText(update.content);
      if (text) {
        this.timeline.appendThoughtText(turnId, text);
      }
      return;
    }

    if (update.sessionUpdate === "plan") {
      this.timeline.updatePlan(
        turnId,
        update.entries.map((entry, index) => ({
          content: entry.content,
          id: `plan-${index + 1}`,
          priority: entry.priority,
          status: entry.status,
        })),
      );
      return;
    }

    if (update.sessionUpdate === "tool_call") {
      const content = await mapToolCallContentToThreadContent({
        content: update.content ?? [],
        rawInput: update.rawInput ?? undefined,
        terminalHandler: this.bootstrap.handlers?.terminal,
      });
      this.timeline.upsertToolCall({
        content,
        locations: mapToolCallLocations(update.locations ?? undefined),
        rawInput: update.rawInput ?? undefined,
        rawOutput: update.rawOutput ?? undefined,
        status: mapToolCallStatus(update.status ?? "pending"),
        title: update.title,
        toolCallId: update.toolCallId,
        toolKind: mapToolKind(update.kind ?? undefined),
        turnId,
      });
      return;
    }

    if (update.sessionUpdate === "tool_call_update") {
      const existing = this.timeline.getToolCall(update.toolCallId);
      const rawInput = update.rawInput ?? existing?.rawInput;
      const content =
        update.content !== undefined && update.content !== null
          ? await mapToolCallContentToThreadContent({
              content: update.content,
              rawInput,
              terminalHandler: this.bootstrap.handlers?.terminal,
            })
          : undefined;
      this.timeline.upsertToolCall({
        content,
        locations: mapToolCallLocations(update.locations ?? undefined),
        rawInput,
        rawOutput: update.rawOutput ?? undefined,
        status: update.status ? mapToolCallStatus(update.status) : undefined,
        title: update.title ?? undefined,
        toolCallId: update.toolCallId,
        toolKind: mapToolKind(update.kind ?? undefined),
        turnId,
      });
    }
  }

  private requireTerminalHandler(): AcpRuntimeTerminalHandler {
    if (!this.bootstrap.handlers?.terminal) {
      throw new AcpProtocolError(
        "ACP session does not have a terminal handler.",
      );
    }
    return this.bootstrap.handlers.terminal;
  }

  private async readTerminalOutputSnapshot(
    terminalHandler: AcpRuntimeTerminalHandler,
    terminalId: string,
  ): Promise<
    | {
        exitCode: number | null;
        output: string;
        truncated: boolean;
      }
    | undefined
  > {
    try {
      return await terminalHandler.output(terminalId);
    } catch {
      return undefined;
    }
  }
}

function extractHistoryText(
  content: { type: string; text?: string },
): string {
  return content.type === "text" && typeof content.text === "string"
    ? content.text
    : "";
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function mapToolCallContentToThreadContent(input: {
  content: readonly ToolCallContent[];
  rawInput?: unknown;
  terminalHandler?: AcpRuntimeTerminalHandler;
}): Promise<readonly AcpRuntimeThreadToolContent[]> {
  const terminalContext = deriveTerminalContext(input.rawInput);
  const parts = await Promise.all(
    input.content.map(async (item, index) => {
      switch (item.type) {
        case "diff":
          return {
            changeType:
              item.oldText === undefined || item.oldText === "" ? "write" : "update",
            id: `diff-${index + 1}`,
            kind: "diff",
            newText: item.newText,
            oldText: item.oldText ?? undefined,
            path: item.path,
          } satisfies AcpRuntimeThreadToolContent;
        case "terminal":
          return await mapTerminalToolCallContent({
            context: terminalContext,
            item,
            index,
            terminalHandler: input.terminalHandler,
          });
        case "content":
          return mapGenericToolCallContent(item, index);
        default:
          return undefined;
      }
    }),
  );

  return parts.flatMap((part) => (part ? [part] : []));
}

async function mapTerminalToolCallContent(input: {
  context: ReturnType<typeof deriveTerminalContext>;
  item: Extract<ToolCallContent, { type: "terminal" }>;
  index: number;
  terminalHandler?: AcpRuntimeTerminalHandler;
}): Promise<AcpRuntimeThreadToolContent> {
  let output: string | undefined;
  let truncated: boolean | undefined;
  let exitCode: number | null | undefined;

  if (input.terminalHandler?.output) {
    try {
      const snapshot = await input.terminalHandler.output(input.item.terminalId);
      output = snapshot.output;
      truncated = snapshot.truncated;
      exitCode = snapshot.exitCode;
    } catch {
      // Ignore terminal snapshot lookup errors and preserve structural entry.
    }
  }

  return {
    command: input.context.command,
    cwd: input.context.cwd,
    exitCode,
    id: `terminal-${input.index + 1}`,
    kind: "terminal",
    output,
    status:
      exitCode === undefined ? "unknown" : exitCode === null ? "running" : "completed",
    terminalId: input.item.terminalId,
    truncated,
  } satisfies AcpRuntimeThreadToolContent;
}

function deriveTerminalContext(rawInput: unknown): {
  command?: string;
  cwd?: string;
} {
  if (!rawInput || typeof rawInput !== "object") {
    return {};
  }

  const value = rawInput as {
    args?: unknown;
    command?: unknown;
    cwd?: unknown;
  };
  const command =
    typeof value.command === "string" && value.command.trim() !== ""
      ? value.command
      : undefined;
  const cwd =
    typeof value.cwd === "string" && value.cwd.trim() !== ""
      ? value.cwd
      : undefined;
  const args = Array.isArray(value.args)
    ? value.args.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (!command) {
    return { cwd };
  }

  return {
    command: args.length > 0 ? `${command} ${args.join(" ")}` : command,
    cwd,
  };
}

function mapToolCallLocations(
  locations: readonly ToolCallLocation[] | null | undefined,
): readonly { line?: number; path: string }[] | undefined {
  if (!locations || locations.length === 0) {
    return undefined;
  }

  return locations.map((location) => ({
    line: location.line ?? undefined,
    path: location.path,
  }));
}

function mapGenericToolCallContent(
  item: Extract<ToolCallContent, { type: "content" }>,
  index: number,
): AcpRuntimeThreadToolContent {
  const block = item.content;
  if (block.type === "text") {
    return {
      id: `content-${index + 1}`,
      kind: "content",
      part: { text: block.text, type: "text" },
      text: block.text,
    };
  }

  if (block.type === "resource_link") {
    return {
      id: `content-${index + 1}`,
      kind: "content",
      label: block.title ?? block.uri,
      part: {
        mediaType: block.mimeType ?? undefined,
        text: undefined,
        title: block.title ?? undefined,
        type: "resource",
        uri: block.uri,
      },
    };
  }

  if (block.type === "image") {
    return {
      id: `content-${index + 1}`,
      kind: "content",
      label: block.mimeType ?? "image",
      part: {
        alt: undefined,
        mediaType: block.mimeType ?? undefined,
        type: "image",
        uri: block.uri ?? `data:${block.mimeType};base64,${block.data}`,
      },
    };
  }

  return {
    id: `content-${index + 1}`,
    kind: "content",
    label: block.type,
  };
}

function mapToolCallStatus(
  status: "completed" | "failed" | "in_progress" | "pending",
): "completed" | "failed" | "in_progress" | "pending" {
  return status;
}

function mapToolKind(kind: ToolKind | undefined): string | undefined {
  return kind ?? undefined;
}

function mapTerminalStatus(
  exitCode: number | null | undefined,
): AcpRuntimeTerminalSnapshot["status"] | undefined {
  if (exitCode === undefined) {
    return undefined;
  }
  return exitCode === null ? "running" : "completed";
}
