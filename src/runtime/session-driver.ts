import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCapabilities,
  AcpRuntimeCreateOptions,
  AcpRuntimeDiagnostics,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimeSessionList,
  AcpRuntimeSessionMetadata,
  AcpRuntimePrompt,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTurnEvent,
} from "./types.js";

export type AcpSessionDriver = {
  cancel(): Promise<void>;
  close(): Promise<void>;
  readonly capabilities: Readonly<AcpRuntimeCapabilities>;
  readonly diagnostics: Readonly<AcpRuntimeDiagnostics>;
  listAgentConfigOptions(): readonly AcpRuntimeAgentConfigOption[];
  listAgentModes(): readonly AcpRuntimeAgentMode[];
  readonly metadata: Readonly<AcpRuntimeSessionMetadata>;
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
