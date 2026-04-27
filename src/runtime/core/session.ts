import type {
  AcpRuntimeCapabilities,
  AcpRuntimeDiffWatcher,
  AcpRuntimeDiagnostics,
  AcpRuntimeInitialConfigReport,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimeQueuePolicy,
  AcpRuntimeQueuePolicyInput,
  AcpRuntimeConfigValue,
  AcpRuntimeSessionMetadata,
  AcpRuntimePrompt,
  AcpRuntimeSessionStatus,
  AcpRuntimeStateWatcher,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeTurnHandle,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeToolObjectWatcher,
  AcpRuntimeTurnCompletion,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnHandlers,
} from "./types.js";
import { AcpRuntimeTurnEventType } from "./types.js";
import { AcpProtocolError } from "./errors.js";
import { resolveRuntimeAgentModeId } from "./mode-utils.js";
import type { AcpSessionDriver } from "./session-driver.js";

export class AcpRuntimeSession {
  private closed = false;

  readonly agent = {
    listModes: () => this.driver.listAgentModes(),
    listConfigOptions: () => this.driver.listAgentConfigOptions(),
    setMode: (modeId: string) => this.applyAgentMode(modeId),
    setConfigOption: (id: string, value: AcpRuntimeConfigValue) =>
      this.applyAgentConfigValue(id, value),
  } as const;

  readonly turn = {
    cancel: (turnId: string) => this.cancelTurn(turnId),
    start: (
      prompt: AcpRuntimePrompt,
      options?: AcpRuntimeStreamOptions,
    ) => this.startTurn(prompt, options),
    run: (
      prompt: AcpRuntimePrompt,
      options?: AcpRuntimeStreamOptions,
    ) => this.executePromptRun(prompt, options),
    send: (
      prompt: AcpRuntimePrompt,
      handlers?: AcpRuntimeTurnHandlers,
      options?: AcpRuntimeStreamOptions,
    ) => this.executePromptSend(prompt, handlers, options),
    stream: (
      prompt: AcpRuntimePrompt,
      options?: AcpRuntimeStreamOptions,
    ) => this.openPromptStream(prompt, options),
    queue: {
      clear: () => this.clearQueuedTurns(),
      get: (turnId: string) => this.driver.queuedTurn(turnId),
      list: () => this.driver.queuedTurns(),
      remove: (turnId: string) => this.removeQueuedTurn(turnId),
      sendNow: (turnId: string) => this.sendQueuedTurnNow(turnId),
    },
  } as const;

  readonly queue = {
    policy: () => this.driver.queuePolicy(),
    setPolicy: (policy: AcpRuntimeQueuePolicyInput) =>
      this.setQueuePolicy(policy),
  } as const;

  readonly state = {
    history: {
      drain: () => this.driver.drainHistoryEntries(),
    },
    thread: {
      entries: () => this.driver.threadEntries(),
    },
    diffs: {
      keys: () => this.driver.diffPaths(),
      get: (path: string) => this.driver.diff(path),
      list: () => this.driver.diffs(),
      watch: (path: string, watcher: AcpRuntimeDiffWatcher) =>
        this.driver.watchDiff(path, watcher),
    },
    terminals: {
      ids: () => this.driver.terminalIds(),
      get: (terminalId: string) => this.driver.terminal(terminalId),
      list: () => this.driver.terminals(),
      watch: (terminalId: string, watcher: AcpRuntimeTerminalWatcher) =>
        this.driver.watchTerminal(terminalId, watcher),
      refresh: (terminalId: string) => this.driver.refreshTerminal(terminalId),
      wait: (terminalId: string) => this.driver.waitForTerminal(terminalId),
      kill: (terminalId: string) => this.driver.killTerminal(terminalId),
      release: (terminalId: string) => this.driver.releaseTerminal(terminalId),
    },
    toolCalls: {
      ids: () => this.driver.toolCallIds(),
      get: (toolCallId: string) => this.driver.toolCall(toolCallId),
      list: () => this.driver.toolCalls(),
      bundle: (toolCallId: string) => this.driver.toolCallBundle(toolCallId),
      bundles: () => this.driver.toolCallBundles(),
      diffs: (toolCallId: string) => this.driver.toolCallDiffs(toolCallId),
      terminals: (toolCallId: string) =>
        this.driver.toolCallTerminals(toolCallId),
      watch: (toolCallId: string, watcher: AcpRuntimeToolCallWatcher) =>
        this.driver.watchToolCall(toolCallId, watcher),
      watchObjects: (
        toolCallId: string,
        watcher: AcpRuntimeToolObjectWatcher,
      ) => this.driver.watchToolCallObjects(toolCallId, watcher),
    },
    operations: {
      ids: () => this.driver.operationIds(),
      get: (operationId: string) => this.driver.operation(operationId),
      list: () => this.driver.operations(),
      bundle: (operationId: string) => this.driver.operationBundle(operationId),
      bundles: () => this.driver.operationBundles(),
      permissions: (operationId: string) =>
        this.driver.operationPermissionRequests(operationId),
      watch: (operationId: string, watcher: AcpRuntimeOperationWatcher) =>
        this.driver.watchOperation(operationId, watcher),
      watchBundle: (
        operationId: string,
        watcher: AcpRuntimeOperationBundleWatcher,
      ) => this.driver.watchOperationBundle(operationId, watcher),
    },
    permissions: {
      ids: () => this.driver.permissionRequestIds(),
      get: (requestId: string) => this.driver.permissionRequest(requestId),
      list: () => this.driver.permissionRequests(),
      watch: (
        requestId: string,
        watcher: AcpRuntimePermissionRequestWatcher,
      ) => this.driver.watchPermissionRequest(requestId, watcher),
    },
    metadata: () => this.driver.projectionMetadata(),
    usage: () => this.driver.projectionUsage(),
    watch: (watcher: AcpRuntimeStateWatcher) => {
      const stopReadModel = this.driver.watchReadModel(watcher);
      const stopProjection = this.driver.watchProjection(watcher);
      return () => {
        stopReadModel();
        stopProjection();
      };
    },
  } as const;

  constructor(
    private readonly driver: AcpSessionDriver,
    private readonly options: {
      initialConfigReport?: AcpRuntimeInitialConfigReport | undefined;
      onClose?: (() => Promise<void> | void) | undefined;
      onSnapshotChanged?:
        | ((snapshot: AcpRuntimeSnapshot) => Promise<void> | void)
        | undefined;
    } = {},
  ) {}

  get capabilities(): Readonly<AcpRuntimeCapabilities> {
    return this.driver.capabilities;
  }

  get diagnostics(): Readonly<AcpRuntimeDiagnostics> {
    return this.driver.diagnostics;
  }

  get initialConfigReport(): Readonly<AcpRuntimeInitialConfigReport> | undefined {
    return this.options.initialConfigReport;
  }

  get metadata(): Readonly<AcpRuntimeSessionMetadata> {
    return this.driver.metadata;
  }

  get status(): AcpRuntimeSessionStatus {
    return this.closed ? "closed" : this.driver.status;
  }

  snapshot(): AcpRuntimeSnapshot {
    return this.driver.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await (this.options.onClose ? this.options.onClose() : this.driver.close());
  }

  private async applyAgentConfigValue(
    id: string,
    value: AcpRuntimeConfigValue,
  ): Promise<void> {
    this.assertOpen();
    await this.driver.setAgentConfigOption(id, value);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  private async applyAgentMode(modeId: string): Promise<void> {
    this.assertOpen();
    const resolvedMode = resolveRuntimeAgentModeId(
      this.driver.listAgentModes(),
      modeId,
    );
    if (resolvedMode.error && !resolvedMode.error.startsWith("unknown mode:")) {
      throw new AcpProtocolError(resolvedMode.error);
    }
    await this.driver.setAgentMode(resolvedMode.modeId ?? modeId);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  private async executePromptRun(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): Promise<string> {
    const completion = await this.executePromptSend(prompt, undefined, options);
    return completion.outputText;
  }

  private async cancelTurn(turnId: string): Promise<boolean> {
    this.assertOpen();
    return this.driver.cancelTurn(turnId);
  }

  private async sendQueuedTurnNow(turnId: string): Promise<boolean> {
    this.assertOpen();
    return this.driver.sendQueuedTurnNow(turnId);
  }

  private clearQueuedTurns(): number {
    this.assertOpen();
    return this.driver.clearQueuedTurns();
  }

  private setQueuePolicy(policy: AcpRuntimeQueuePolicyInput): AcpRuntimeQueuePolicy {
    this.assertOpen();
    return this.driver.setQueuePolicy(policy);
  }

  private removeQueuedTurn(turnId: string): boolean {
    this.assertOpen();
    return this.driver.withdrawQueuedTurn(turnId);
  }

  private async executePromptSend(
    prompt: AcpRuntimePrompt,
    handlers?: AcpRuntimeTurnHandlers,
    options?: AcpRuntimeStreamOptions,
  ): Promise<AcpRuntimeTurnCompletion> {
    const turn = this.startTurn(prompt, options);
    let completion: AcpRuntimeTurnCompletion | undefined;
    let terminalSeen = false;
    for await (const event of turn.events) {
      if (terminalSeen) {
        throw new AcpProtocolError(
          "Turn stream emitted events after a terminal event.",
        );
      }

      await handlers?.onEvent?.(event);
      if (event.type === AcpRuntimeTurnEventType.Completed) {
        terminalSeen = true;
        completion = {
          output: event.output,
          outputText: event.outputText,
          turnId: event.turnId,
        };
      } else if (event.type === AcpRuntimeTurnEventType.Cancelled) {
        terminalSeen = true;
        throw event.error;
      } else if (event.type === AcpRuntimeTurnEventType.Coalesced) {
        terminalSeen = true;
        throw event.error;
      } else if (event.type === AcpRuntimeTurnEventType.Withdrawn) {
        terminalSeen = true;
        throw event.error;
      } else if (event.type === AcpRuntimeTurnEventType.Failed) {
        throw event.error;
      }
    }

    if (!completion) {
      throw new AcpProtocolError("Turn stream ended without a terminal event.");
    }

    return completion;
  }

  private startTurn(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AcpRuntimeTurnHandle {
    this.assertOpen();
    return this.driver.startTurn(prompt, options);
  }

  private openPromptStream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    return this.startTurn(prompt, options).events;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AcpProtocolError("Session is closed.");
    }
  }
}
