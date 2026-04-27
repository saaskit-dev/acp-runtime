import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeAgent,
  AcpRuntimeCapabilities,
  AcpRuntimeConfigValue,
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
  AcpRuntimeForkSessionOptions,
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
  AcpRuntimeQueuedTurn,
  AcpRuntimeQueuePolicy,
  AcpRuntimeQueuePolicyInput,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTerminalSnapshot,
  AcpRuntimeTerminalWatcher,
  AcpRuntimeTurnCompletion,
  AcpRuntimeTurnEvent,
  AcpRuntimeUsage,
} from "./types.js";

export type AcpSessionDriverTurnHandle = {
  readonly completion: Promise<AcpRuntimeTurnCompletion>;
  readonly events: AsyncIterable<AcpRuntimeTurnEvent>;
  readonly turnId: string;
};

export type AcpSessionDriver = {
  cancelTurn(turnId: string): Promise<boolean>;
  clearQueuedTurns(): number;
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
  queuePolicy(): AcpRuntimeQueuePolicy;
  setQueuePolicy(policy: AcpRuntimeQueuePolicyInput): AcpRuntimeQueuePolicy;
  sendQueuedTurnNow(turnId: string): Promise<boolean>;
  queuedTurn(turnId: string): AcpRuntimeQueuedTurn | undefined;
  queuedTurns(): readonly AcpRuntimeQueuedTurn[];
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
  withdrawQueuedTurn(turnId: string): boolean;
  setAgentConfigOption(
    id: string,
    value: AcpRuntimeConfigValue,
  ): Promise<void>;
  setAgentMode(modeId: string): Promise<void>;
  snapshot(): AcpRuntimeSnapshot;
  startTurn(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AcpSessionDriverTurnHandle;
  readonly status: AcpRuntimeSessionStatus;
};

export type AcpSessionService = {
  create(options: AcpRuntimeCreateOptions): Promise<AcpSessionDriver>;
  fork(
    options: AcpRuntimeForkSessionOptions & {
      agent: AcpRuntimeAgent;
      cwd: string;
    },
  ): Promise<AcpSessionDriver>;
  listAgentSessions(
    options: AcpRuntimeListAgentSessionsOptions,
  ): Promise<AcpRuntimeSessionList>;
  load(options: AcpRuntimeLoadOptions): Promise<AcpSessionDriver>;
  resume(options: AcpRuntimeResumeOptions): Promise<AcpSessionDriver>;
};
