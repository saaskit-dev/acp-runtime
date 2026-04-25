import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCapabilities,
  AcpRuntimeDiffWatcher,
  AcpRuntimeDiffSnapshot,
  AcpRuntimeDiagnostics,
  AcpRuntimeHistoryEntry,
  AcpRuntimeOperation,
  AcpRuntimeOperationBundle,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimePermissionRequest,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimeProjectionWatcher,
  AcpRuntimeReadModelWatcher,
  AcpRuntimeSessionMetadata,
  AcpRuntimePrompt,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTerminalSnapshot,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeThreadEntry,
  AcpRuntimeToolCallBundle,
  AcpRuntimeToolCallSnapshot,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeToolObjectWatcher,
  AcpRuntimeTurnCompletion,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnHandlers,
  AcpRuntimeUsage,
} from "./types.js";
import { AcpProtocolError } from "./errors.js";
import type { AcpSessionDriver } from "./session-driver.js";

export class AcpRuntimeSession {
  private closed = false;

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

  listAgentConfigOptions(): readonly AcpRuntimeAgentConfigOption[] {
    return this.driver.listAgentConfigOptions();
  }

  listAgentModes(): readonly AcpRuntimeAgentMode[] {
    return this.driver.listAgentModes();
  }

  drainHistoryEntries(): readonly AcpRuntimeHistoryEntry[] {
    return this.driver.drainHistoryEntries();
  }

  diffPaths(): readonly string[] {
    return this.driver.diffPaths();
  }

  diff(path: string): AcpRuntimeDiffSnapshot | undefined {
    return this.driver.diff(path);
  }

  diffs(): readonly AcpRuntimeDiffSnapshot[] {
    return this.driver.diffs();
  }

  operation(operationId: string): AcpRuntimeOperation | undefined {
    return this.driver.operation(operationId);
  }

  operationBundle(operationId: string): AcpRuntimeOperationBundle | undefined {
    return this.driver.operationBundle(operationId);
  }

  operationBundles(): readonly AcpRuntimeOperationBundle[] {
    return this.driver.operationBundles();
  }

  operationIds(): readonly string[] {
    return this.driver.operationIds();
  }

  operationPermissionRequests(
    operationId: string,
  ): readonly AcpRuntimePermissionRequest[] {
    return this.driver.operationPermissionRequests(operationId);
  }

  operations(): readonly AcpRuntimeOperation[] {
    return this.driver.operations();
  }

  permissionRequest(
    requestId: string,
  ): AcpRuntimePermissionRequest | undefined {
    return this.driver.permissionRequest(requestId);
  }

  permissionRequestIds(): readonly string[] {
    return this.driver.permissionRequestIds();
  }

  permissionRequests(): readonly AcpRuntimePermissionRequest[] {
    return this.driver.permissionRequests();
  }

  projectionMetadata(): AcpRuntimeSessionMetadata | undefined {
    return this.driver.projectionMetadata();
  }

  projectionUsage(): AcpRuntimeUsage | undefined {
    return this.driver.projectionUsage();
  }

  async killTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    return this.driver.killTerminal(terminalId);
  }

  terminalIds(): readonly string[] {
    return this.driver.terminalIds();
  }

  terminal(terminalId: string): AcpRuntimeTerminalSnapshot | undefined {
    return this.driver.terminal(terminalId);
  }

  terminals(): readonly AcpRuntimeTerminalSnapshot[] {
    return this.driver.terminals();
  }

  async refreshTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    return this.driver.refreshTerminal(terminalId);
  }

  async releaseTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    return this.driver.releaseTerminal(terminalId);
  }

  toolCall(toolCallId: string): AcpRuntimeToolCallSnapshot | undefined {
    return this.driver.toolCall(toolCallId);
  }

  toolCallBundles(): readonly AcpRuntimeToolCallBundle[] {
    return this.driver.toolCallBundles();
  }

  toolCallBundle(toolCallId: string): AcpRuntimeToolCallBundle | undefined {
    return this.driver.toolCallBundle(toolCallId);
  }

  toolCallDiffs(toolCallId: string): readonly AcpRuntimeDiffSnapshot[] {
    return this.driver.toolCallDiffs(toolCallId);
  }

  toolCallIds(): readonly string[] {
    return this.driver.toolCallIds();
  }

  toolCalls(): readonly AcpRuntimeToolCallSnapshot[] {
    return this.driver.toolCalls();
  }

  toolCallTerminals(
    toolCallId: string,
  ): readonly AcpRuntimeTerminalSnapshot[] {
    return this.driver.toolCallTerminals(toolCallId);
  }

  threadEntries(): readonly AcpRuntimeThreadEntry[] {
    return this.driver.threadEntries();
  }

  watchReadModel(watcher: AcpRuntimeReadModelWatcher): () => void {
    return this.driver.watchReadModel(watcher);
  }

  watchProjection(watcher: AcpRuntimeProjectionWatcher): () => void {
    return this.driver.watchProjection(watcher);
  }

  watchOperation(
    operationId: string,
    watcher: AcpRuntimeOperationWatcher,
  ): () => void {
    return this.driver.watchOperation(operationId, watcher);
  }

  watchOperationBundle(
    operationId: string,
    watcher: AcpRuntimeOperationBundleWatcher,
  ): () => void {
    return this.driver.watchOperationBundle(operationId, watcher);
  }

  watchPermissionRequest(
    requestId: string,
    watcher: AcpRuntimePermissionRequestWatcher,
  ): () => void {
    return this.driver.watchPermissionRequest(requestId, watcher);
  }

  watchToolCall(
    toolCallId: string,
    watcher: AcpRuntimeToolCallWatcher,
  ): () => void {
    return this.driver.watchToolCall(toolCallId, watcher);
  }

  watchDiff(path: string, watcher: AcpRuntimeDiffWatcher): () => void {
    return this.driver.watchDiff(path, watcher);
  }

  watchTerminal(
    terminalId: string,
    watcher: AcpRuntimeTerminalWatcher,
  ): () => void {
    return this.driver.watchTerminal(terminalId, watcher);
  }

  watchToolCallObjects(
    toolCallId: string,
    watcher: AcpRuntimeToolObjectWatcher,
  ): () => void {
    return this.driver.watchToolCallObjects(toolCallId, watcher);
  }

  async waitForTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined> {
    return this.driver.waitForTerminal(terminalId);
  }

  async cancel(): Promise<void> {
    this.assertOpen();
    await this.driver.cancel();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await (this.options.onClose ? this.options.onClose() : this.driver.close());
  }

  async setAgentConfigOption(id: string, value: string): Promise<void> {
    this.assertOpen();
    await this.driver.setAgentConfigOption(id, value);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  async setAgentMode(modeId: string): Promise<void> {
    this.assertOpen();
    await this.driver.setAgentMode(modeId);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  async run(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): Promise<string> {
    const completion = await this.send(prompt, undefined, options);
    return completion.outputText;
  }

  async send(
    prompt: AcpRuntimePrompt,
    handlers?: AcpRuntimeTurnHandlers,
    options?: AcpRuntimeStreamOptions,
  ): Promise<AcpRuntimeTurnCompletion> {
    let completion: AcpRuntimeTurnCompletion | undefined;
    let terminalSeen = false;
    for await (const event of this.stream(prompt, options)) {
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

  snapshot(): AcpRuntimeSnapshot {
    return this.driver.snapshot();
  }

  stream(
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
