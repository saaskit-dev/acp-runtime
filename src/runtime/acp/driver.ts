import type {
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  ToolCallLocation,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { context, type Context, type Span } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";

import {
  AcpProcessError,
  AcpProtocolError,
  AcpTurnCancelledError,
  AcpTurnCoalescedError,
  AcpTurnTimeoutError,
  AcpTurnWithdrawnError,
} from "../core/errors.js";
import type {
  AcpSessionDriver,
  AcpSessionDriverTurnHandle,
} from "../core/session-driver.js";
import {
  AcpRuntimeObservabilityRedactionKind,
  AcpRuntimePermissionDecisionValue,
  AcpRuntimePermissionRequestPhase,
  AcpRuntimePermissionResolution,
  AcpRuntimeQueuedTurnStatus,
  AcpRuntimeThreadToolContentKind,
  AcpRuntimeTurnEventType,
  type AcpRuntimeObservabilityOptions,
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
  type AcpRuntimePromptMessage,
  type AcpRuntimePromptPart,
  type AcpRuntimeProjectionWatcher,
  type AcpRuntimeQueuedTurn,
  type AcpRuntimeQueuePolicy,
  type AcpRuntimeQueuePolicyInput,
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
  type AcpRuntimeConfigValue,
} from "../core/types.js";
import { ACP_RUNTIME_SNAPSHOT_VERSION } from "../core/constants.js";
import { AcpRuntimeSessionTimeline } from "../core/session-timeline.js";
import type { AcpSessionBootstrap } from "./connection-types.js";
import { AcpClientBridge } from "./authority-bridge.js";
import { emitRuntimeLog, observedLogBody } from "../observability/logging.js";
import {
  captureContentAttribute,
  captureContentEvent,
  childSpan,
  mergeTraceMeta,
  operationAttributes,
  permissionAttributes,
  promptAttributes,
  recordException,
  resolveObservabilityOptions,
  usageAttributes,
} from "../observability/tracing.js";
import {
  createInitialMetadata,
  extractRuntimeConfig,
  mapInitializeResponseToCapabilities,
  mapSessionConfigOptions,
} from "./capability-mapper.js";
import {
  normalizeRuntimeConfigValue,
  resolveRuntimeConfigOption,
} from "../core/config-options.js";
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
  complete: (completion: import("../core/types.js").AcpRuntimeTurnCompletion) => void;
  fail: (error: Error) => void;
  hasTerminalEvent: boolean;
  telemetry: {
    operationSpans: Map<string, Span>;
    permissionSpans: Map<string, Span>;
    turnContext: Context;
    turnSpan: Span;
  };
  queue: AsyncEventQueue<AcpRuntimeTurnEvent>;
  state: AcpRuntimeTurnState;
};

type QueuedTurn = {
  activeTurn: ActiveTurn;
  cleanupTimeout: () => void;
  dispatchRequested: boolean;
  prompt: AcpRuntimePrompt;
  queuedAt: string;
  started: boolean;
};

const DEFAULT_QUEUE_POLICY = {
  delivery: "sequential",
} as const satisfies AcpRuntimeQueuePolicy;

export class AcpSdkSessionDriver implements AcpSessionDriver {
  private currentTurn: ActiveTurn | undefined;
  private currentTurnExecution: QueuedTurn | undefined;
  private readonly diagnosticsValue: AcpRuntimeDiagnostics = {};
  private readonly historyTurn = createTurnState();
  private readonly metadataValue: AcpRuntimeSessionMetadata;
  private readonly observability;
  private readonly pendingTurns: QueuedTurn[] = [];
  private queuePolicyValue: AcpRuntimeQueuePolicy;
  private statusValue: AcpRuntimeSessionStatus = "ready";
  private readonly timeline = new AcpRuntimeSessionTimeline();

  readonly capabilities;

  constructor(
    private readonly bridge: AcpClientBridge,
    private readonly bootstrap: AcpSessionBootstrap & {
      handlers?: AcpRuntimeAuthorityHandlers;
      initializeResponse: import("@agentclientprotocol/sdk").InitializeResponse;
      observability?: AcpRuntimeObservabilityOptions;
      profile: AcpAgentProfile;
      queue?: AcpRuntimeQueuePolicyInput;
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
    this.observability = resolveObservabilityOptions(bootstrap.observability);
    this.queuePolicyValue = normalizeQueuePolicy(bootstrap.queue);
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

  queuePolicy(): AcpRuntimeQueuePolicy {
    return { ...this.queuePolicyValue };
  }

  setQueuePolicy(policy: AcpRuntimeQueuePolicyInput): AcpRuntimeQueuePolicy {
    this.queuePolicyValue = normalizeQueuePolicy(policy, this.queuePolicyValue);
    this.startNextQueuedTurn();
    return this.queuePolicy();
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

  queuedTurn(turnId: string): AcpRuntimeQueuedTurn | undefined {
    const queuedTurn = this.pendingTurns.find(
      (candidate) => candidate.activeTurn.state.turnId === turnId,
    );
    if (!queuedTurn) {
      return undefined;
    }
    return this.mapQueuedTurn(queuedTurn);
  }

  queuedTurns(): readonly AcpRuntimeQueuedTurn[] {
    return this.pendingTurns.map((queuedTurn) => this.mapQueuedTurn(queuedTurn));
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

  async cancelTurn(turnId: string): Promise<boolean> {
    if (
      !this.currentTurn ||
      !this.currentTurnExecution ||
      this.currentTurn.state.turnId !== turnId ||
      this.currentTurnExecution.activeTurn.state.turnId !== turnId
    ) {
      return false;
    }
    this.currentTurn.state.cancelRequested = true;
    await this.bootstrap.connection.cancel(
      mergeTraceMeta(
        {
          sessionId: this.bootstrap.sessionId,
        },
        this.currentTurn?.telemetry.turnContext,
      ),
    );
    return true;
  }

  async close(): Promise<void> {
    if (this.statusValue === "closed") {
      return;
    }

    this.statusValue = "closed";
    const runningTurn = this.currentTurnExecution;
    if (runningTurn) {
      runningTurn.cleanupTimeout();
      runningTurn.activeTurn.state.cancelRequested = true;
      this.finishTurnWithTerminalEvent(runningTurn.activeTurn, {
        error: new AcpTurnCancelledError("Session closed."),
        turnId: runningTurn.activeTurn.state.turnId,
        type: AcpRuntimeTurnEventType.Cancelled,
      });
    }
    this.currentTurn = undefined;
    this.currentTurnExecution = undefined;
    for (const queuedTurn of this.pendingTurns.splice(0)) {
      queuedTurn.cleanupTimeout();
      queuedTurn.activeTurn.state.cancelRequested = true;
      this.finishTurnWithTerminalEvent(queuedTurn.activeTurn, {
        error: new AcpTurnWithdrawnError("Session closed before turn started."),
        turnId: queuedTurn.activeTurn.state.turnId,
        type: AcpRuntimeTurnEventType.Withdrawn,
      });
    }
    if (this.bootstrap.connection.closeSession) {
      await Promise.race([
        this.bootstrap.connection
          .closeSession(
            mergeTraceMeta({
              sessionId: this.bootstrap.sessionId,
            }),
          )
          .catch(() => {}),
        waitFor(1_000),
      ]);
    }
    await this.bootstrap.dispose?.();
  }

  async setAgentConfigOption(
    id: string,
    value: AcpRuntimeConfigValue,
  ): Promise<void> {
    if (!this.bootstrap.connection.setSessionConfigOption) {
      throw new AcpProtocolError(
        "ACP agent does not support session config option updates.",
      );
    }

    const option = resolveRuntimeConfigOption(
      this.metadataValue.agentConfigOptions ?? [],
      id,
    );
    const normalizedValue = normalizeRuntimeConfigValue(option, value);
    const params =
      option.type === "boolean"
        ? {
            configId: option.id,
            sessionId: this.bootstrap.sessionId,
            type: "boolean" as const,
            value: normalizedValue as boolean,
          }
        : {
            configId: option.id,
            sessionId: this.bootstrap.sessionId,
            value: String(normalizedValue),
          };

    const response = await this.bootstrap.connection.setSessionConfigOption(
      mergeTraceMeta(params, this.currentTurn?.telemetry.turnContext),
    );
    this.replaceConfigOptions(response.configOptions);
  }

  async setAgentMode(modeId: string): Promise<void> {
    if (!this.bootstrap.connection.setSessionMode) {
      throw new AcpProtocolError("ACP agent does not support session mode updates.");
    }

    await this.bootstrap.connection.setSessionMode({
      ...(mergeTraceMeta(
        {
          modeId,
          sessionId: this.bootstrap.sessionId,
        },
        this.currentTurn?.telemetry.turnContext,
      ) as {
        modeId: string;
        sessionId: string;
      }),
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

  startTurn(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AcpSessionDriverTurnHandle {
    const turn = this.enqueueTurn(prompt, options);
    this.dispatchQueuedTurn(turn.turnId);
    return turn;
  }

  private enqueueTurn(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AcpSessionDriverTurnHandle {
    if (this.statusValue === "closed") {
      throw new AcpProcessError("Session is closed.");
    }

    const state = createTurnState();
    let settleCompletion:
      | ((value: import("../core/types.js").AcpRuntimeTurnCompletion) => void)
      | undefined;
    let rejectCompletion: ((reason?: unknown) => void) | undefined;
    const completion = new Promise<import("../core/types.js").AcpRuntimeTurnCompletion>(
      (resolve, reject) => {
        settleCompletion = resolve;
        rejectCompletion = reject;
      },
    );
    void completion.catch(() => {});
    const { context: turnContext, span: turnSpan } = childSpan(
      "acp.turn",
      context.active(),
      {
        "acp.agent.type": this.bootstrap.agent.type,
        "acp.session.id": this.bootstrap.sessionId,
        "acp.turn.id": state.turnId,
        ...promptAttributes(prompt),
      },
    );
    const activeTurn: ActiveTurn = {
      complete: (value) => settleCompletion?.(value),
      fail: (error) => rejectCompletion?.(error),
      hasTerminalEvent: false,
      telemetry: {
        operationSpans: new Map(),
        permissionSpans: new Map(),
        turnContext,
        turnSpan,
      },
      queue: new AsyncEventQueue<AcpRuntimeTurnEvent>(),
      state,
    };
    const queuedTurn: QueuedTurn = {
      activeTurn,
      cleanupTimeout: () => {},
      dispatchRequested: false,
      prompt,
      queuedAt: new Date().toISOString(),
      started: false,
    };
    captureContentAttribute({
      key: "acp.prompt.content",
      options: this.observability,
      redactContext: {
        kind: "prompt",
        sessionId: this.bootstrap.sessionId,
        turnId: state.turnId,
      },
      span: turnSpan,
      value: prompt,
    });
    emitRuntimeLog({
      attributes: {
        "acp.agent.type": this.bootstrap.agent.type,
        "acp.session.id": this.bootstrap.sessionId,
        "acp.turn.id": state.turnId,
        ...promptAttributes(prompt),
      },
      body: observedLogBody({
        options: this.observability,
        redactContext: {
          kind: "prompt",
          sessionId: this.bootstrap.sessionId,
          turnId: state.turnId,
        },
        value: prompt,
      }) ?? "Turn queued.",
      context: turnContext,
      eventName: "acp.turn.queued",
    });

    activeTurn.queue.push({
      position: this.pendingTurns.length,
      turnId: activeTurn.state.turnId,
      type: "queued",
    });
    this.pendingTurns.push(queuedTurn);
    queuedTurn.cleanupTimeout = this.installTimeoutHandlers(queuedTurn, options);

    const events = this.createTurnEventStream(queuedTurn);
    return {
      completion,
      events,
      turnId: state.turnId,
    };
  }

  stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    return this.startTurn(prompt, options).events;
  }

  private dispatchQueuedTurn(turnId: string): boolean {
    const queuedTurn = this.findDispatchableQueuedTurn(turnId);
    if (!queuedTurn) {
      return false;
    }
    queuedTurn.dispatchRequested = true;
    this.startNextQueuedTurn();
    return true;
  }

  async sendQueuedTurnNow(turnId: string): Promise<boolean> {
    const queuedTurn = this.findDispatchableQueuedTurn(turnId);
    if (!queuedTurn) {
      return false;
    }
    queuedTurn.dispatchRequested = true;
    this.moveQueuedTurnToFront(queuedTurn);
    if (this.currentTurnExecution && this.currentTurn) {
      this.currentTurn.state.cancelRequested = true;
      await this.cancelTurn(this.currentTurn.state.turnId);
      return true;
    }
    this.startNextQueuedTurn();
    return true;
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const activeTurn = this.currentTurn;
    if (!activeTurn) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }

    const mapped = mapPermissionRequest({
      params,
      profile: this.bootstrap.profile,
      turn: activeTurn.state,
    });
    this.emitTurnEvent(activeTurn, {
      operation: mapped.operation,
      turnId: activeTurn.state.turnId,
      type: AcpRuntimeTurnEventType.OperationUpdated,
    });
    this.emitTurnEvent(activeTurn, {
      operation: mapped.operation,
      request: mapped.request,
      turnId: activeTurn.state.turnId,
      type: AcpRuntimeTurnEventType.PermissionRequested,
    });

    const decision = await this.resolvePermissionDecision(mapped.request);
    if (this.currentTurn !== activeTurn || activeTurn.hasTerminalEvent) {
      return {
        outcome: {
          outcome: "cancelled",
        },
      };
    }
    mapped.request.phase =
      decision.decision === AcpRuntimePermissionDecisionValue.Allow
        ? AcpRuntimePermissionRequestPhase.Allowed
        : AcpRuntimePermissionRequestPhase.Denied;
    if (decision.decision === AcpRuntimePermissionDecisionValue.Deny) {
      activeTurn.state.deniedOperationIds.add(mapped.operation.id);
    }
    const resolvedOperation = applyPermissionDecision({
      decision,
      operationId: mapped.operation.id,
      turn: activeTurn.state,
    });

    this.emitTurnEvent(activeTurn, {
      decision:
        decision.decision === AcpRuntimePermissionDecisionValue.Allow
          ? AcpRuntimePermissionResolution.Allowed
          : AcpRuntimePermissionResolution.Denied,
      operation: resolvedOperation,
      request: mapped.request,
      turnId: activeTurn.state.turnId,
      type: AcpRuntimeTurnEventType.PermissionResolved,
    });

    return mapPermissionDecisionToAcp(params.options, decision);
  }

  private async handleSessionUpdate(
    params: SessionNotification,
  ): Promise<void> {
    if (params.sessionId !== this.bootstrap.sessionId) {
      return;
    }

    const activeTurn = this.currentTurn;
    const turnState = activeTurn?.state ?? this.historyTurn;
    const committed = await this.syncThreadEntriesFromSessionUpdate(
      params,
      turnState.turnId,
      () =>
        activeTurn
          ? this.currentTurn === activeTurn && !activeTurn.hasTerminalEvent
          : !this.currentTurn,
    );
    if (!committed) {
      return;
    }

    if (!activeTurn) {
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
        turn: turnState,
      });
      this.timeline.appendTimelineEntries(historyEvents);
      return;
    }

    if (activeTurn.hasTerminalEvent || this.currentTurn !== activeTurn) {
      return;
    }

    const events = mapSessionUpdateToRuntimeEvents({
      diagnostics: this.diagnosticsValue,
      metadata: this.metadataValue,
      notification: params,
      profile: this.bootstrap.profile,
      turn: activeTurn.state,
    });
    for (const event of events) {
      this.emitTurnEvent(activeTurn, event);
    }
  }

  private createTurnEventStream(
    queuedTurn: QueuedTurn,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    const activeTurn = queuedTurn.activeTurn;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const next = await activeTurn.queue.next();
            if (next.done) {
              break;
            }
            yield next.value;
          }
        } finally {
          queuedTurn.cleanupTimeout();
          if (!queuedTurn.started) {
            if (self.removePendingTurn(queuedTurn)) {
              activeTurn.state.cancelRequested = true;
              self.finishTurnWithTerminalEvent(activeTurn, {
                error: new AcpTurnWithdrawnError(
                  "Turn stream closed before turn started.",
                ),
                turnId: activeTurn.state.turnId,
                type: AcpRuntimeTurnEventType.Withdrawn,
              });
            } else {
              activeTurn.queue.close();
            }
            return;
          }
          if (
            self.currentTurnExecution === queuedTurn &&
            !activeTurn.hasTerminalEvent
          ) {
            activeTurn.state.cancelRequested = true;
            self.finishTurnWithTerminalEvent(activeTurn, {
              error: new AcpTurnCancelledError("Turn stream closed."),
              turnId: activeTurn.state.turnId,
              type: AcpRuntimeTurnEventType.Cancelled,
            });
            void self.cancelTurn(activeTurn.state.turnId);
          }
        }
      },
    };
  }

  private installTimeoutHandlers(
    queuedTurn: QueuedTurn,
    options: AcpRuntimeStreamOptions | undefined,
  ): () => void {
    const timeout = options?.timeoutMs
      ? setTimeout(() => {
          queuedTurn.activeTurn.state.cancelRequested = true;
          queuedTurn.activeTurn.state.timedOut = true;
          if (this.currentTurnExecution === queuedTurn) {
            this.finishTurnWithTerminalEvent(queuedTurn.activeTurn, {
              error: new AcpTurnTimeoutError("Turn timed out."),
              turnId: queuedTurn.activeTurn.state.turnId,
              type: AcpRuntimeTurnEventType.Failed,
            });
            void this.cancelTurn(queuedTurn.activeTurn.state.turnId);
            return;
          }
          if (!this.removePendingTurn(queuedTurn)) {
            return;
          }
          this.finishWithdrawnQueuedTurn(queuedTurn);
        }, options.timeoutMs)
      : undefined;

    return () => {
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }

  private findDispatchableQueuedTurn(turnId: string): QueuedTurn | undefined {
    return this.pendingTurns.find(
      (candidate) =>
        !candidate.started && candidate.activeTurn.state.turnId === turnId,
    );
  }

  private moveQueuedTurnToFront(queuedTurn: QueuedTurn): void {
    if (!this.removePendingTurn(queuedTurn)) {
      return;
    }
    this.pendingTurns.unshift(queuedTurn);
  }

  private removePendingTurn(queuedTurn: QueuedTurn): boolean {
    const index = this.pendingTurns.indexOf(queuedTurn);
    if (index === -1) {
      return false;
    }
    this.pendingTurns.splice(index, 1);
    return true;
  }

  withdrawQueuedTurn(turnId: string): boolean {
    const queuedTurn = this.pendingTurns.find(
      (candidate) => candidate.activeTurn.state.turnId === turnId,
    );
    if (!queuedTurn || queuedTurn.started) {
      return false;
    }
    queuedTurn.activeTurn.state.cancelRequested = true;
    queuedTurn.cleanupTimeout();
    if (!this.removePendingTurn(queuedTurn)) {
      return false;
    }
    this.finishWithdrawnQueuedTurn(queuedTurn);
    return true;
  }

  clearQueuedTurns(): number {
    const queuedTurns = this.pendingTurns.filter(
      (candidate) => !candidate.started,
    );
    let withdrawn = 0;
    for (const queuedTurn of queuedTurns) {
      queuedTurn.activeTurn.state.cancelRequested = true;
      queuedTurn.cleanupTimeout();
      if (!this.removePendingTurn(queuedTurn)) {
        continue;
      }
      this.finishWithdrawnQueuedTurn(queuedTurn);
      withdrawn += 1;
    }
    return withdrawn;
  }

  private startNextQueuedTurn(): void {
    if (
      this.statusValue === "closed" ||
      this.currentTurnExecution ||
      this.pendingTurns.length === 0
    ) {
      return;
    }

    const queuedTurns = this.takeReadyTurnsForDelivery();
    const queuedTurn = queuedTurns[0];
    if (!queuedTurn) {
      return;
    }
    queuedTurn.started = true;
    this.currentTurnExecution = queuedTurn;
    this.currentTurn = queuedTurn.activeTurn;
    this.statusValue = "running";
    const prompt =
      queuedTurns.length > 1
        ? coalescePrompts(queuedTurns.map((turn) => turn.prompt))
        : queuedTurn.prompt;
    for (const coalescedTurn of queuedTurns.slice(1)) {
      this.finishCoalescedQueuedTurn(
        coalescedTurn,
        queuedTurn.activeTurn.state.turnId,
      );
    }
    this.timeline.appendPrompt(
      prompt,
      queuedTurn.activeTurn.state.turnId,
    );
    emitRuntimeLog({
      attributes: {
        "acp.agent.type": this.bootstrap.agent.type,
        "acp.session.id": this.bootstrap.sessionId,
        "acp.turn.id": queuedTurn.activeTurn.state.turnId,
        ...promptAttributes(prompt),
      },
      body: observedLogBody({
        options: this.observability,
        redactContext: {
          kind: "prompt",
          sessionId: this.bootstrap.sessionId,
          turnId: queuedTurn.activeTurn.state.turnId,
        },
        value: prompt,
      }) ?? "Turn started.",
      context: queuedTurn.activeTurn.telemetry.turnContext,
      eventName: "acp.turn.started",
    });
    this.emitTurnEvent(queuedTurn.activeTurn, {
      turnId: queuedTurn.activeTurn.state.turnId,
      type: "started",
    });
    void this.runQueuedTurn(queuedTurn, prompt);
  }

  private takeReadyTurnsForDelivery(): QueuedTurn[] {
    if (this.queuePolicyValue.delivery === "coalesce") {
      const queuedTurns = this.pendingTurns.filter(
        (candidate) => candidate.dispatchRequested,
      );
      for (const queuedTurn of queuedTurns) {
        this.removePendingTurn(queuedTurn);
      }
      return queuedTurns;
    }

    const queuedTurn = this.pendingTurns.find(
      (candidate) => candidate.dispatchRequested,
    );
    if (!queuedTurn || !this.removePendingTurn(queuedTurn)) {
      return [];
    }
    return [queuedTurn];
  }

  private async runQueuedTurn(
    queuedTurn: QueuedTurn,
    prompt: AcpRuntimePrompt,
  ): Promise<void> {
    try {
      await this.startPrompt(queuedTurn.activeTurn, prompt);
    } finally {
      if (this.currentTurnExecution === queuedTurn) {
        this.currentTurnExecution = undefined;
      }
      if (this.currentTurn === queuedTurn.activeTurn) {
        this.currentTurn = undefined;
      }

      if (this.statusValue === "closed") {
        return;
      }

      if (this.pendingTurns.length > 0) {
        this.startNextQueuedTurn();
        return;
      }

      this.restoreReadyStatus();
    }
  }

  private finishWithdrawnQueuedTurn(queuedTurn: QueuedTurn): void {
    const event: AcpRuntimeTurnEvent = queuedTurn.activeTurn.state.timedOut
      ? {
          error: new AcpTurnTimeoutError("Turn timed out."),
          turnId: queuedTurn.activeTurn.state.turnId,
          type: AcpRuntimeTurnEventType.Failed,
        }
      : {
          error: new AcpTurnWithdrawnError("Turn withdrawn from queue."),
          turnId: queuedTurn.activeTurn.state.turnId,
          type: AcpRuntimeTurnEventType.Withdrawn,
        };
    this.finishTurnWithTerminalEvent(queuedTurn.activeTurn, event);
  }

  private finishCoalescedQueuedTurn(
    queuedTurn: QueuedTurn,
    intoTurnId: string,
  ): void {
    queuedTurn.cleanupTimeout();
    const error = new AcpTurnCoalescedError(
      `Turn coalesced into ${intoTurnId}.`,
      intoTurnId,
    );
    const event = {
      error,
      intoTurnId,
      turnId: queuedTurn.activeTurn.state.turnId,
      type: AcpRuntimeTurnEventType.Coalesced,
    } satisfies AcpRuntimeTurnEvent;
    this.finishTurnWithTerminalEvent(queuedTurn.activeTurn, event);
  }

  private mapQueuedTurn(queuedTurn: QueuedTurn): AcpRuntimeQueuedTurn {
    return {
      position: this.pendingTurns.indexOf(queuedTurn),
      prompt: queuedTurn.prompt,
      queuedAt: queuedTurn.queuedAt,
      status: queuedTurn.dispatchRequested
        ? AcpRuntimeQueuedTurnStatus.Ready
        : AcpRuntimeQueuedTurnStatus.Queued,
      turnId: queuedTurn.activeTurn.state.turnId,
    };
  }

  private async startPrompt(
    activeTurn: ActiveTurn,
    prompt: AcpRuntimePrompt,
  ): Promise<void> {
    let response: PromptResponse;
    try {
      response = await this.bootstrap.connection.prompt({
        ...(mergeTraceMeta(
          {
            prompt: mapPromptToAcp(prompt),
            sessionId: this.bootstrap.sessionId,
          },
          activeTurn.telemetry.turnContext,
        ) as {
          prompt: ReturnType<typeof mapPromptToAcp>;
          sessionId: string;
        }),
      });
    } catch (error) {
      if (activeTurn.hasTerminalEvent) {
        return;
      }
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
          type: AcpRuntimeTurnEventType.Failed,
        } satisfies AcpRuntimeTurnEvent;
        this.finishTurnWithTerminalEvent(activeTurn, failedEvent);
        return;
      }
    }

    if (activeTurn.hasTerminalEvent) {
      return;
    }

    const usage = mapUsage(response.usage ?? undefined);
    if (usage) {
      this.diagnosticsValue.lastUsage = usage;
      this.emitTurnEvent(activeTurn, {
        turnId: activeTurn.state.turnId,
        type: AcpRuntimeTurnEventType.UsageUpdated,
        usage,
      });
    }

    for (const event of finalizePromptResponse({
      response,
      turn: activeTurn.state,
    })) {
      if (activeTurn.hasTerminalEvent) {
        return;
      }
      if (event.type === AcpRuntimeTurnEventType.Completed) {
        this.timeline.completeTurn(
          activeTurn.state.turnId,
          event.output,
          "completed",
        );
      } else if (event.type === AcpRuntimeTurnEventType.Failed) {
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

  private replaceConfigOptions(
    configOptions: readonly SessionConfigOption[],
  ): void {
    this.metadataValue.config = extractRuntimeConfig(configOptions);
    this.metadataValue.agentConfigOptions = mapSessionConfigOptions(configOptions);
  }

  private restoreReadyStatus(): void {
    if (this.statusValue !== "closed") {
      this.statusValue = "ready";
    }
  }

  private finishTurnWithTerminalEvent(
    activeTurn: ActiveTurn,
    event: AcpRuntimeTurnEvent,
  ): void {
    if (!activeTurn.hasTerminalEvent) {
      this.timeline.completeTurn(activeTurn.state.turnId, undefined, "failed");
      this.emitTurnEvent(activeTurn, event);
    }
    activeTurn.queue.close();
  }

  private emitTurnEvent(
    activeTurn: ActiveTurn,
    event: AcpRuntimeTurnEvent,
  ): void {
    this.observeTurnEvent(activeTurn, event);
    this.timeline.appendTimelineEntry(event);
    if (!activeTurn.hasTerminalEvent) {
      if (event.type === AcpRuntimeTurnEventType.Completed) {
        activeTurn.hasTerminalEvent = true;
        activeTurn.complete({
          output: event.output,
          outputText: event.outputText,
          turnId: event.turnId,
        });
      } else if (
        event.type === AcpRuntimeTurnEventType.Cancelled ||
        event.type === AcpRuntimeTurnEventType.Coalesced ||
        event.type === AcpRuntimeTurnEventType.Withdrawn ||
        event.type === AcpRuntimeTurnEventType.Failed
      ) {
        activeTurn.hasTerminalEvent = true;
        activeTurn.fail(event.error);
      }
    }
    activeTurn.queue.push(event);
  }

  private observeTurnEvent(activeTurn: ActiveTurn, event: AcpRuntimeTurnEvent): void {
    switch (event.type) {
      case AcpRuntimeTurnEventType.Thinking:
        emitRuntimeLog({
          attributes: {
            "acp.turn.id": event.turnId,
            "acp.session.id": this.bootstrap.sessionId,
          },
          body: observedLogBody({
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.AssistantThought,
              sessionId: this.bootstrap.sessionId,
              turnId: event.turnId,
            },
            value: event.text,
          }) ?? "Assistant thought chunk.",
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.thought",
        });
        captureContentEvent({
          eventName: "acp.turn.thought",
          extraAttributes: {
            "acp.turn.id": event.turnId,
          },
          options: this.observability,
          redactContext: {
            kind: AcpRuntimeObservabilityRedactionKind.AssistantThought,
            sessionId: this.bootstrap.sessionId,
            turnId: event.turnId,
          },
          span: activeTurn.telemetry.turnSpan,
          value: event.text,
        });
        return;
      case AcpRuntimeTurnEventType.Text:
        emitRuntimeLog({
          attributes: {
            "acp.turn.id": event.turnId,
            "acp.session.id": this.bootstrap.sessionId,
          },
          body: observedLogBody({
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.AssistantOutput,
              sessionId: this.bootstrap.sessionId,
              turnId: event.turnId,
            },
            value: event.text,
          }) ?? "Assistant output chunk.",
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.output",
        });
        captureContentEvent({
          eventName: "acp.turn.output",
          extraAttributes: {
            "acp.turn.id": event.turnId,
          },
          options: this.observability,
          redactContext: {
            kind: AcpRuntimeObservabilityRedactionKind.AssistantOutput,
            sessionId: this.bootstrap.sessionId,
            turnId: event.turnId,
          },
          span: activeTurn.telemetry.turnSpan,
          value: event.text,
        });
        return;
      case AcpRuntimeTurnEventType.PlanUpdated:
        emitRuntimeLog({
          attributes: {
            "acp.turn.id": event.turnId,
            "acp.session.id": this.bootstrap.sessionId,
          },
          body: observedLogBody({
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.Plan,
              sessionId: this.bootstrap.sessionId,
              turnId: event.turnId,
            },
            value: event.plan,
          }) ?? "Turn plan updated.",
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.plan",
        });
        captureContentAttribute({
          key: "acp.turn.plan",
          options: this.observability,
          redactContext: {
            kind: AcpRuntimeObservabilityRedactionKind.Plan,
            sessionId: this.bootstrap.sessionId,
            turnId: event.turnId,
          },
          span: activeTurn.telemetry.turnSpan,
          value: event.plan,
        });
        return;
      case AcpRuntimeTurnEventType.UsageUpdated:
        activeTurn.telemetry.turnSpan.setAttributes(usageAttributes(event.usage));
        return;
      case AcpRuntimeTurnEventType.MetadataUpdated:
        activeTurn.telemetry.turnSpan.setAttributes({
          "acp.agent.mode": event.metadata.currentModeId,
          "acp.session.id": event.metadata.id,
        });
        return;
      case AcpRuntimeTurnEventType.OperationStarted:
      case AcpRuntimeTurnEventType.OperationUpdated: {
        const span = this.ensureOperationSpan(activeTurn, event.operation);
        this.observeToolCallSnapshot(activeTurn, event.operation.id, span);
        emitRuntimeLog({
          attributes: {
            ...operationAttributes(event.operation),
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
          },
          body: event.operation.title,
          context: activeTurn.telemetry.turnContext,
          eventName:
            event.type === AcpRuntimeTurnEventType.OperationStarted
              ? "acp.tool.started"
              : "acp.tool.updated",
        });
        return;
      }
      case AcpRuntimeTurnEventType.OperationCompleted:
        this.observeToolCallSnapshot(
          activeTurn,
          event.operation.id,
          this.ensureOperationSpan(activeTurn, event.operation),
        );
        this.completeOperationSpan(activeTurn, event.operation.id, {
          "acp.operation.outcome": "completed",
          ...operationAttributes(event.operation),
        });
        emitRuntimeLog({
          attributes: {
            ...operationAttributes(event.operation),
            "acp.operation.outcome": "completed",
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
          },
          body: event.operation.title,
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.tool.completed",
        });
        return;
      case AcpRuntimeTurnEventType.OperationFailed: {
        const span = this.ensureOperationSpan(activeTurn, event.operation);
        this.observeToolCallSnapshot(activeTurn, event.operation.id, span);
        recordException(span, event.error);
        this.completeOperationSpan(activeTurn, event.operation.id, {
          "acp.operation.outcome":
            event.operation.failureReason ?? "failed",
          ...operationAttributes(event.operation),
        });
        emitRuntimeLog({
          attributes: {
            ...operationAttributes(event.operation),
            "acp.operation.outcome":
              event.operation.failureReason ?? "failed",
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
          },
          body: event.error instanceof Error ? event.error.message : String(event.error),
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.tool.failed",
          exception: event.error,
          severityNumber: SeverityNumber.ERROR,
        });
        return;
      }
      case AcpRuntimeTurnEventType.PermissionRequested: {
        const { span } = childSpan(
          "acp.permission",
          activeTurn.telemetry.turnContext,
          permissionAttributes(event.request),
        );
        activeTurn.telemetry.permissionSpans.set(event.request.id, span);
        emitRuntimeLog({
          attributes: {
            ...permissionAttributes(event.request),
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
          },
          body: event.request.title,
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.permission.requested",
        });
        return;
      }
      case AcpRuntimeTurnEventType.PermissionResolved: {
        const permissionSpan = activeTurn.telemetry.permissionSpans.get(
          event.request.id,
        );
        if (permissionSpan) {
          permissionSpan.setAttributes({
            "acp.permission.decision": event.decision,
            ...permissionAttributes(event.request),
          });
          permissionSpan.end();
          activeTurn.telemetry.permissionSpans.delete(event.request.id);
        }
        emitRuntimeLog({
          attributes: {
            ...permissionAttributes(event.request),
            "acp.permission.decision": event.decision,
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
          },
          body: event.request.title,
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.permission.resolved",
          severityNumber:
            event.decision === AcpRuntimePermissionResolution.Allowed
              ? SeverityNumber.INFO
              : SeverityNumber.WARN,
        });
        return;
      }
      case AcpRuntimeTurnEventType.Completed:
        emitRuntimeLog({
          attributes: {
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
            "acp.turn.outcome": "completed",
          },
          body: observedLogBody({
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.AssistantOutput,
              sessionId: this.bootstrap.sessionId,
              turnId: event.turnId,
            },
            value: event.outputText,
          }) ?? "Turn completed.",
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.completed",
        });
        captureContentAttribute({
          key: "acp.turn.output_text",
          options: this.observability,
          redactContext: {
            kind: AcpRuntimeObservabilityRedactionKind.AssistantOutput,
            sessionId: this.bootstrap.sessionId,
            turnId: event.turnId,
          },
          span: activeTurn.telemetry.turnSpan,
          value: event.outputText,
        });
        activeTurn.telemetry.turnSpan.setAttributes({
          "acp.turn.outcome": "completed",
          "acp.turn.output_part_count": event.output.length,
        });
        this.endTurnTelemetry(activeTurn);
        return;
      case AcpRuntimeTurnEventType.Cancelled:
        emitRuntimeLog({
          attributes: {
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
            "acp.turn.outcome": "cancelled",
          },
          body: event.error instanceof Error ? event.error.message : String(event.error),
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.cancelled",
          severityNumber: SeverityNumber.WARN,
        });
        activeTurn.telemetry.turnSpan.setAttribute(
          "acp.turn.outcome",
          "cancelled",
        );
        this.endTurnTelemetry(activeTurn);
        return;
      case AcpRuntimeTurnEventType.Withdrawn:
        emitRuntimeLog({
          attributes: {
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
            "acp.turn.outcome": "withdrawn",
          },
          body: event.error instanceof Error ? event.error.message : String(event.error),
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.withdrawn",
          severityNumber: SeverityNumber.WARN,
        });
        activeTurn.telemetry.turnSpan.setAttribute(
          "acp.turn.outcome",
          "withdrawn",
        );
        this.endTurnTelemetry(activeTurn);
        return;
      case AcpRuntimeTurnEventType.Failed:
        emitRuntimeLog({
          attributes: {
            "acp.session.id": this.bootstrap.sessionId,
            "acp.turn.id": event.turnId,
            "acp.turn.outcome": "failed",
          },
          body: event.error instanceof Error ? event.error.message : String(event.error),
          context: activeTurn.telemetry.turnContext,
          eventName: "acp.turn.failed",
          exception: event.error,
          severityNumber: SeverityNumber.ERROR,
        });
        recordException(activeTurn.telemetry.turnSpan, event.error);
        activeTurn.telemetry.turnSpan.setAttribute("acp.turn.outcome", "failed");
        this.endTurnTelemetry(activeTurn);
        return;
      default:
        return;
    }
  }

  private ensureOperationSpan(
    activeTurn: ActiveTurn,
    operation: AcpRuntimeOperation,
  ): Span {
    const existing = activeTurn.telemetry.operationSpans.get(operation.id);
    if (existing) {
      existing.setAttributes(operationAttributes(operation));
      return existing;
    }

    const { span } = childSpan(
      "acp.tool",
      activeTurn.telemetry.turnContext,
      operationAttributes(operation),
    );
    activeTurn.telemetry.operationSpans.set(operation.id, span);
    return span;
  }

  private observeToolCallSnapshot(
    activeTurn: ActiveTurn,
    operationId: string,
    span: Span,
  ): void {
    const toolCallId = this.findToolCallIdForOperation(activeTurn, operationId);
    if (!toolCallId) {
      return;
    }

    span.setAttribute("acp.tool.tool_call_id", toolCallId);
    const snapshot = this.timeline.getToolCall(toolCallId);
    if (!snapshot) {
      return;
    }

    captureContentAttribute({
      key: "acp.tool.raw_input",
      options: this.observability,
      redactContext: {
        kind: AcpRuntimeObservabilityRedactionKind.ToolRawInput,
        operationId,
        sessionId: this.bootstrap.sessionId,
        toolCallId,
        turnId: snapshot.turnId,
      },
      span,
      value: snapshot.rawInput,
    });
    captureContentAttribute({
      key: "acp.tool.raw_output",
      options: this.observability,
      redactContext: {
        kind: AcpRuntimeObservabilityRedactionKind.ToolRawOutput,
        operationId,
        sessionId: this.bootstrap.sessionId,
        toolCallId,
        turnId: snapshot.turnId,
      },
      span,
      value: snapshot.rawOutput,
    });

    snapshot.content.forEach((content, index) => {
      const contentIndex = index + 1;
      switch (content.kind) {
        case AcpRuntimeThreadToolContentKind.Diff:
          span.setAttributes({
            [`acp.tool.diff.${contentIndex}.path`]: content.path,
            [`acp.tool.diff.${contentIndex}.change_type`]: content.changeType,
          });
          captureContentAttribute({
            key: `acp.tool.diff.${contentIndex}.new_text`,
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.DiffNewText,
              operationId,
              path: content.path,
              sessionId: this.bootstrap.sessionId,
              toolCallId,
              turnId: snapshot.turnId,
            },
            span,
            value: content.newText,
          });
          captureContentAttribute({
            key: `acp.tool.diff.${contentIndex}.old_text`,
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.DiffOldText,
              operationId,
              path: content.path,
              sessionId: this.bootstrap.sessionId,
              toolCallId,
              turnId: snapshot.turnId,
            },
            span,
            value: content.oldText,
          });
          break;
        case AcpRuntimeThreadToolContentKind.Terminal:
          span.setAttributes({
            [`acp.tool.terminal.${contentIndex}.id`]: content.terminalId,
            [`acp.tool.terminal.${contentIndex}.status`]: content.status,
            [`acp.tool.terminal.${contentIndex}.command`]: content.command,
            [`acp.tool.terminal.${contentIndex}.cwd`]: content.cwd,
          });
          captureContentAttribute({
            key: `acp.tool.terminal.${contentIndex}.output`,
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.TerminalOutput,
              operationId,
              sessionId: this.bootstrap.sessionId,
              terminalId: content.terminalId,
              toolCallId,
              turnId: snapshot.turnId,
            },
            span,
            value: content.output,
          });
          break;
        case AcpRuntimeThreadToolContentKind.Content:
          if (!content.text) {
            break;
          }
          captureContentAttribute({
            key: `acp.tool.content.${contentIndex}.text`,
            options: this.observability,
            redactContext: {
              kind: AcpRuntimeObservabilityRedactionKind.ToolRawOutput,
              operationId,
              sessionId: this.bootstrap.sessionId,
              toolCallId,
              turnId: snapshot.turnId,
            },
            span,
            value: content.text,
          });
          break;
        default:
          break;
      }
    });
  }

  private findToolCallIdForOperation(
    activeTurn: ActiveTurn,
    operationId: string,
  ): string | undefined {
    for (const [toolCallId, mappedOperationId] of activeTurn.state.vendorToolCallToOperationId.entries()) {
      if (mappedOperationId === operationId) {
        return toolCallId;
      }
    }
    return undefined;
  }

  private completeOperationSpan(
    activeTurn: ActiveTurn,
    operationId: string,
    attributes: Record<string, string | number | boolean | undefined>,
  ): void {
    const span = activeTurn.telemetry.operationSpans.get(operationId);
    if (!span) {
      return;
    }
    span.setAttributes(attributes);
    span.end();
    activeTurn.telemetry.operationSpans.delete(operationId);
  }

  private endTurnTelemetry(activeTurn: ActiveTurn): void {
    for (const span of activeTurn.telemetry.permissionSpans.values()) {
      span.setAttribute("acp.permission.outcome", "unfinished");
      span.end();
    }
    activeTurn.telemetry.permissionSpans.clear();

    for (const span of activeTurn.telemetry.operationSpans.values()) {
      span.setAttribute("acp.operation.outcome", "unfinished");
      span.end();
    }
    activeTurn.telemetry.operationSpans.clear();

    activeTurn.telemetry.turnSpan.end();
  }

  private async syncThreadEntriesFromSessionUpdate(
    params: SessionNotification,
    turnId: string,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    const update = params.update;
    if (update.sessionUpdate === "agent_message_chunk") {
      if (!shouldCommit()) {
        return false;
      }
      const text = extractHistoryText(update.content);
      if (text) {
        this.timeline.appendAssistantText(turnId, text);
      }
      return true;
    }

    if (update.sessionUpdate === "agent_thought_chunk") {
      if (!shouldCommit()) {
        return false;
      }
      const text = extractHistoryText(update.content);
      if (text) {
        this.timeline.appendThoughtText(turnId, text);
      }
      return true;
    }

    if (update.sessionUpdate === "plan") {
      if (!shouldCommit()) {
        return false;
      }
      this.timeline.updatePlan(
        turnId,
        update.entries.map((entry, index) => ({
          content: entry.content,
          id: `plan-${index + 1}`,
          priority: entry.priority,
          status: entry.status,
        })),
      );
      return true;
    }

    if (update.sessionUpdate === "tool_call") {
      const content = await mapToolCallContentToThreadContent({
        content: update.content ?? [],
        rawInput: update.rawInput ?? undefined,
        terminalHandler: this.bootstrap.handlers?.terminal,
      });
      if (!shouldCommit()) {
        return false;
      }
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
      return true;
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
      if (!shouldCommit()) {
        return false;
      }
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
      return true;
    }
    return true;
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

function normalizeQueuePolicy(
  input: AcpRuntimeQueuePolicyInput | undefined,
  base: AcpRuntimeQueuePolicy = DEFAULT_QUEUE_POLICY,
): AcpRuntimeQueuePolicy {
  const delivery = input?.delivery ?? base.delivery;
  if (delivery !== "sequential" && delivery !== "coalesce") {
    throw new AcpProtocolError(`Unknown queue delivery policy: ${String(delivery)}`);
  }
  return { delivery };
}

function coalescePrompts(prompts: readonly AcpRuntimePrompt[]): AcpRuntimePrompt {
  if (prompts.length === 0) {
    return "";
  }
  if (prompts.length === 1) {
    return prompts[0];
  }
  if (prompts.every((prompt) => typeof prompt === "string")) {
    return (prompts as readonly string[]).join("\n\n");
  }

  const items: Array<AcpRuntimePromptMessage | AcpRuntimePromptPart> = [];
  for (const prompt of prompts) {
    if (typeof prompt === "string") {
      items.push({ content: prompt, role: "user" });
      continue;
    }
    items.push(...prompt);
  }
  return items;
}
