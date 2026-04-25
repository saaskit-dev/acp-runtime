import type {
  AcpRuntimeCapabilities,
  AcpRuntimeDiffWatcher,
  AcpRuntimeDiagnostics,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimeProjectionWatcher,
  AcpRuntimeReadModelWatcher,
  AcpRuntimeSessionMetadata,
  AcpRuntimePrompt,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeToolObjectWatcher,
  AcpRuntimeTurnCompletion,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnHandlers,
} from "./types.js";
import { AcpProtocolError } from "./errors.js";
import type { AcpSessionDriver } from "./session-driver.js";

export class AcpRuntimeSession {
  private closed = false;

  readonly agent = {
    listModes: () => this.driver.listAgentModes(),
    listConfigOptions: () => this.driver.listAgentConfigOptions(),
    setMode: (modeId: string) => this.applyAgentMode(modeId),
    setConfigOption: (id: string, value: string) =>
      this.applyAgentConfigValue(id, value),
  } as const;

  readonly turn = {
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
  } as const;

  readonly model = {
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
    watch: (watcher: AcpRuntimeReadModelWatcher) =>
      this.driver.watchReadModel(watcher),
  } as const;

  readonly live = {
    metadata: () => this.driver.projectionMetadata(),
    usage: () => this.driver.projectionUsage(),
    watch: (watcher: AcpRuntimeProjectionWatcher) =>
      this.driver.watchProjection(watcher),
  } as const;

  readonly lifecycle = {
    snapshot: () => this.driver.snapshot(),
    cancel: () => this.cancelSessionLifecycle(),
    close: () => this.closeSessionLifecycle(),
  } as const;

  constructor(
    private readonly driver: AcpSessionDriver,
    private readonly options: {
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

  get metadata(): Readonly<AcpRuntimeSessionMetadata> {
    return this.driver.metadata;
  }

  get status(): AcpRuntimeSessionStatus {
    return this.closed ? "closed" : this.driver.status;
  }

  private async cancelSessionLifecycle(): Promise<void> {
    this.assertOpen();
    await this.driver.cancel();
  }

  private async closeSessionLifecycle(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await (this.options.onClose ? this.options.onClose() : this.driver.close());
  }

  private async applyAgentConfigValue(
    id: string,
    value: string,
  ): Promise<void> {
    this.assertOpen();
    await this.driver.setAgentConfigOption(id, value);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  private async applyAgentMode(modeId: string): Promise<void> {
    this.assertOpen();
    await this.driver.setAgentMode(modeId);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  private async executePromptRun(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): Promise<string> {
    const completion = await this.executePromptSend(prompt, undefined, options);
    return completion.outputText;
  }

  private async executePromptSend(
    prompt: AcpRuntimePrompt,
    handlers?: AcpRuntimeTurnHandlers,
    options?: AcpRuntimeStreamOptions,
  ): Promise<AcpRuntimeTurnCompletion> {
    let completion: AcpRuntimeTurnCompletion | undefined;
    let terminalSeen = false;
    for await (const event of this.openPromptStream(prompt, options)) {
      if (terminalSeen) {
        throw new AcpProtocolError(
          "Turn stream emitted events after a terminal event.",
        );
      }

      await handlers?.onEvent?.(event);
      if (event.type === "completed") {
        terminalSeen = true;
        completion = {
          output: event.output,
          outputText: event.outputText,
          turnId: event.turnId,
        };
      } else if (event.type === "failed") {
        throw event.error;
      }
    }

    if (!completion) {
      throw new AcpProtocolError("Turn stream ended without a terminal event.");
    }

    return completion;
  }

  private openPromptStream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    this.assertOpen();
    return this.driver.stream(prompt, options);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AcpProtocolError("Session is closed.");
    }
  }
}
