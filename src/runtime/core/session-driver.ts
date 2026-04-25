import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCapabilities,
  AcpRuntimeCreateOptions,
  AcpRuntimeDiffWatcher,
  AcpRuntimeHistoryEntry,
  AcpRuntimeDiffSnapshot,
  AcpRuntimeReadModelWatcher,
  AcpRuntimeThreadEntry,
  AcpRuntimeToolCallBundle,
  AcpRuntimeToolCallSnapshot,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeToolObjectWatcher,
  AcpRuntimeDiagnostics,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeOperationBundle,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
  AcpRuntimeSessionMetadata,
  AcpRuntimeOperation,
  AcpRuntimePermissionRequest,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimePrompt,
  AcpRuntimeProjectionWatcher,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTerminalSnapshot,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeTurnEvent,
  AcpRuntimeUsage,
} from "./types.js";

export type AcpSessionDriver = {
  cancel(): Promise<void>;
  close(): Promise<void>;
  readonly capabilities: Readonly<AcpRuntimeCapabilities>;
  readonly diagnostics: Readonly<AcpRuntimeDiagnostics>;
  listAgentConfigOptions(): readonly AcpRuntimeAgentConfigOption[];
  listAgentModes(): readonly AcpRuntimeAgentMode[];
  readonly metadata: Readonly<AcpRuntimeSessionMetadata>;
  diffPaths(): readonly string[];
  drainHistoryEntries(): readonly AcpRuntimeHistoryEntry[];
  diff(path: string): AcpRuntimeDiffSnapshot | undefined;
  diffs(): readonly AcpRuntimeDiffSnapshot[];
  killTerminal(terminalId: string): Promise<AcpRuntimeTerminalSnapshot | undefined>;
  operation(operationId: string): AcpRuntimeOperation | undefined;
  operationBundle(operationId: string): AcpRuntimeOperationBundle | undefined;
  operationBundles(): readonly AcpRuntimeOperationBundle[];
  operationIds(): readonly string[];
  operationPermissionRequests(
    operationId: string,
  ): readonly AcpRuntimePermissionRequest[];
  operations(): readonly AcpRuntimeOperation[];
  permissionRequest(
    requestId: string,
  ): AcpRuntimePermissionRequest | undefined;
  permissionRequestIds(): readonly string[];
  permissionRequests(): readonly AcpRuntimePermissionRequest[];
  projectionMetadata(): AcpRuntimeSessionMetadata | undefined;
  projectionUsage(): AcpRuntimeUsage | undefined;
  terminalIds(): readonly string[];
  terminal(terminalId: string): AcpRuntimeTerminalSnapshot | undefined;
  terminals(): readonly AcpRuntimeTerminalSnapshot[];
  refreshTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined>;
  releaseTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined>;
  toolCall(toolCallId: string): AcpRuntimeToolCallSnapshot | undefined;
  toolCallBundles(): readonly AcpRuntimeToolCallBundle[];
  toolCallBundle(toolCallId: string): AcpRuntimeToolCallBundle | undefined;
  toolCallDiffs(toolCallId: string): readonly AcpRuntimeDiffSnapshot[];
  toolCallIds(): readonly string[];
  toolCalls(): readonly AcpRuntimeToolCallSnapshot[];
  toolCallTerminals(toolCallId: string): readonly AcpRuntimeTerminalSnapshot[];
  threadEntries(): readonly AcpRuntimeThreadEntry[];
  watchOperation(
    operationId: string,
    watcher: AcpRuntimeOperationWatcher,
  ): () => void;
  watchOperationBundle(
    operationId: string,
    watcher: AcpRuntimeOperationBundleWatcher,
  ): () => void;
  watchPermissionRequest(
    requestId: string,
    watcher: AcpRuntimePermissionRequestWatcher,
  ): () => void;
  watchToolCall(toolCallId: string, watcher: AcpRuntimeToolCallWatcher): () => void;
  watchDiff(path: string, watcher: AcpRuntimeDiffWatcher): () => void;
  watchReadModel(watcher: AcpRuntimeReadModelWatcher): () => void;
  watchProjection(watcher: AcpRuntimeProjectionWatcher): () => void;
  watchTerminal(
    terminalId: string,
    watcher: AcpRuntimeTerminalWatcher,
  ): () => void;
  watchToolCallObjects(
    toolCallId: string,
    watcher: AcpRuntimeToolObjectWatcher,
  ): () => void;
  waitForTerminal(
    terminalId: string,
  ): Promise<AcpRuntimeTerminalSnapshot | undefined>;
  setAgentConfigOption(
    id: string,
    value: string,
  ): Promise<void>;
  setAgentMode(modeId: string): Promise<void>;
  snapshot(): AcpRuntimeSnapshot;
  readonly status: AcpRuntimeSessionStatus;
  stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent>;
};

export type AcpSessionService = {
  create(options: AcpRuntimeCreateOptions): Promise<AcpSessionDriver>;
  listAgentSessions(
    options: AcpRuntimeListAgentSessionsOptions,
  ): Promise<AcpRuntimeSessionList>;
  load(options: AcpRuntimeLoadOptions): Promise<AcpSessionDriver>;
  resume(options: AcpRuntimeResumeOptions): Promise<AcpSessionDriver>;
};
