import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./core/constants.js";
import {
  AcpCreateError,
  AcpInitialConfigError,
  AcpListError,
  AcpLoadError,
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpResumeError,
  AcpRuntime,
  AcpSystemPromptError,
  AcpTurnCancelledError,
  AcpTurnWithdrawnError,
} from "./index.js";
import { AcpRuntimeSessionRegistry } from "./registry/session-registry.js";
import { AcpRuntimeJsonSessionRegistryStore } from "./registry/session-registry-store.js";
import type { AcpSessionDriver, AcpSessionService } from "./core/session-driver.js";
import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCreateOptions,
  AcpRuntimeHistoryEntry,
  AcpRuntimeOperation,
  AcpRuntimeOperationBundle,
  AcpRuntimeOperationBundleWatcher,
  AcpRuntimeOperationWatcher,
  AcpRuntimePermissionRequest,
  AcpRuntimePermissionRequestWatcher,
  AcpRuntimeProjectionWatcher,
  AcpRuntimeLoadOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeSessionList,
  AcpRuntimeDiagnostics,
  AcpRuntimeCapabilities,
  AcpRuntimeSessionMetadata,
  AcpRuntimeStreamOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimePrompt,
  AcpRuntimeQueuePolicy,
  AcpRuntimeQueuePolicyInput,
  AcpRuntimeReadModelWatcher,
  AcpRuntimeSnapshot,
  AcpRuntimeToolCallWatcher,
  AcpRuntimeThreadEntry,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnHandle,
  AcpRuntimeStateOptions,
} from "./core/types.js";
import { testLogExporter, testSpanExporter } from "./test-otel.js";

const tempDirs: string[] = [];

type AcpRuntimeBackendEventFactory = (
  prompt: AcpRuntimePrompt,
  options?: AcpRuntimeStreamOptions,
) => readonly AcpRuntimeTurnEvent[];

class SpySessionBackend implements AcpSessionDriver {
  capabilities: AcpRuntimeCapabilities;
  diagnostics: AcpRuntimeDiagnostics;
  metadata: AcpRuntimeSessionMetadata;
  status: "closed" | "ready" | "running" = "ready";
  readonly streamCalls: Array<{
    prompt: AcpRuntimePrompt;
    options?: AcpRuntimeStreamOptions;
  }> = [];
  readonly sendQueuedTurnNowCalls: string[] = [];
  readonly cancelTurnCalls: string[] = [];
  readonly terminalEvents: Array<{
    type: "cancelled" | "completed" | "failed" | "withdrawn";
    turnId: string;
  }> = [];
  readonly agentConfigOptionCalls: Array<{ id: string; value: string | number | boolean }> = [];
  readonly agentModeCalls: string[] = [];
  readonly streamedEvents: AcpRuntimeTurnEvent[] = [];
  private queuePolicyValue: AcpRuntimeQueuePolicy = { delivery: "sequential" };

  constructor(
    readonly snapshotValue: AcpRuntimeSnapshot,
    private readonly eventFactory: AcpRuntimeBackendEventFactory,
  ) {
    this.capabilities = {
      agent: {
        authentication: true,
        load: true,
        prompt: true,
        terminal: true,
      },
      agentInfo: {
        name: "mock-agent",
        title: "Mock Agent",
        version: "0.1.0",
      },
      authMethods: [
        {
          id: "oauth",
          type: "agent",
          title: "OAuth",
        },
      ],
      client: {
        filesystem: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    };
    this.diagnostics = {};
    this.metadata = {
      agentConfigOptions: [
        {
          id: "model",
          name: "Model",
          options: [
            { name: "Claude", value: "claude" },
            { name: "Opus", value: "opus" },
          ],
          type: "select",
          value: snapshotValue.config?.model ?? "claude",
        },
      ] satisfies readonly AcpRuntimeAgentConfigOption[],
      agentModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ] satisfies readonly AcpRuntimeAgentMode[],
      config: snapshotValue.config,
      currentModeId: snapshotValue.currentModeId,
      id: snapshotValue.session.id,
      title: "Mock Session",
    };
  }

  async close(): Promise<void> {
    this.status = "closed";
  }

  listAgentConfigOptions(): readonly AcpRuntimeAgentConfigOption[] {
    return this.metadata.agentConfigOptions ?? [];
  }

  listAgentModes(): readonly AcpRuntimeAgentMode[] {
    return this.metadata.agentModes ?? [];
  }

  drainHistoryEntries(): readonly AcpRuntimeHistoryEntry[] {
    return [];
  }

  diffPaths() {
    return [];
  }

  diff(_path: string) {
    return undefined;
  }

  diffs() {
    return [];
  }

  operation(_operationId: string): AcpRuntimeOperation | undefined {
    return undefined;
  }

  operationBundle(_operationId: string): AcpRuntimeOperationBundle | undefined {
    return undefined;
  }

  operationBundles() {
    return [];
  }

  operationIds() {
    return [];
  }

  operationPermissionRequests(_operationId: string) {
    return [];
  }

  operations() {
    return [];
  }

  permissionRequest(
    _requestId: string,
  ): AcpRuntimePermissionRequest | undefined {
    return undefined;
  }

  permissionRequestIds() {
    return [];
  }

  permissionRequests() {
    return [];
  }

  projectionMetadata() {
    return undefined;
  }

  projectionUsage() {
    return undefined;
  }

  queuePolicy(): AcpRuntimeQueuePolicy {
    return { ...this.queuePolicyValue };
  }

  setQueuePolicy(policy: AcpRuntimeQueuePolicyInput): AcpRuntimeQueuePolicy {
    this.queuePolicyValue = {
      delivery: policy.delivery ?? this.queuePolicyValue.delivery,
    };
    return this.queuePolicy();
  }

  async sendQueuedTurnNow(turnId: string) {
    this.sendQueuedTurnNowCalls.push(turnId);
    return false;
  }

  clearQueuedTurns() {
    return 0;
  }

  queuedTurn(_turnId: string) {
    return undefined;
  }

  queuedTurns() {
    return [];
  }

  async killTerminal() {
    return undefined;
  }

  terminal(_terminalId: string) {
    return undefined;
  }

  terminals() {
    return [];
  }

  toolCall(_toolCallId: string) {
    return undefined;
  }

  toolCalls() {
    return [];
  }

  toolCallBundles() {
    return [];
  }

  toolCallBundle(_toolCallId: string) {
    return undefined;
  }

  toolCallDiffs(_toolCallId: string) {
    return [];
  }

  toolCallIds() {
    return [];
  }

  toolCallTerminals(_toolCallId: string) {
    return [];
  }

  terminalIds() {
    return [];
  }

  watchReadModel(_watcher: AcpRuntimeReadModelWatcher) {
    return () => {};
  }

  watchProjection(_watcher: AcpRuntimeProjectionWatcher) {
    return () => {};
  }

  watchOperation(
    _operationId: string,
    _watcher: AcpRuntimeOperationWatcher,
  ) {
    return () => {};
  }

  watchOperationBundle(
    _operationId: string,
    _watcher: AcpRuntimeOperationBundleWatcher,
  ) {
    return () => {};
  }

  watchPermissionRequest(
    _requestId: string,
    _watcher: AcpRuntimePermissionRequestWatcher,
  ) {
    return () => {};
  }

  watchDiff(_path: string, _watcher: import("./core/types.js").AcpRuntimeDiffWatcher) {
    return () => {};
  }

  watchTerminal(
    _terminalId: string,
    _watcher: import("./core/types.js").AcpRuntimeTerminalWatcher,
  ) {
    return () => {};
  }

  watchToolCallObjects(
    _toolCallId: string,
    _watcher: import("./core/types.js").AcpRuntimeToolObjectWatcher,
  ) {
    return () => {};
  }

  watchToolCall(
    _toolCallId: string,
    _watcher: AcpRuntimeToolCallWatcher,
  ) {
    return () => {};
  }

  async refreshTerminal() {
    return undefined;
  }

  async releaseTerminal() {
    return undefined;
  }

  threadEntries(): readonly AcpRuntimeThreadEntry[] {
    return [];
  }

  async waitForTerminal() {
    return undefined;
  }

  withdrawQueuedTurn(_turnId: string) {
    return false;
  }

  async setAgentConfigOption(
    id: string,
    value: string | number | boolean,
  ): Promise<void> {
    this.agentConfigOptionCalls.push({ id, value });
    this.metadata.config = {
      ...(this.metadata.config ?? {}),
      [id]: value,
    };
    this.metadata.agentConfigOptions =
      this.metadata.agentConfigOptions?.map((option) =>
        option.id === id
          ? {
              ...option,
              value,
            }
          : option,
      );
  }

  async setAgentMode(modeId: string): Promise<void> {
    this.agentModeCalls.push(modeId);
    this.metadata.currentModeId = modeId;
  }

  snapshot(): AcpRuntimeSnapshot {
    return {
      ...this.snapshotValue,
      config: this.metadata.config,
      currentModeId: this.metadata.currentModeId,
    };
  }

  private isClosed(): boolean {
    return this.status === "closed";
  }

  startTurn(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AcpRuntimeTurnHandle {
    this.streamCalls.push({ prompt, options });
    this.status = "running";
    const events = this.eventFactory(prompt, options);
    const turnId =
      events.find((event) => "turnId" in event)?.turnId ?? "turn-missing";
    const completion = (async () => {
      for (const event of events) {
        if (event.type === "completed") {
          return {
            output: event.output,
            outputText: event.outputText,
            turnId: event.turnId,
          };
        }
        if (
          event.type === "failed" ||
          event.type === "cancelled" ||
          event.type === "withdrawn"
        ) {
          throw event.error;
        }
      }
      throw new AcpProtocolError("Turn ended without terminal event.");
    })();
    void completion.catch(() => {});

    return {
      completion,
      events: (async function* (
        backend: SpySessionBackend,
      ): AsyncIterable<AcpRuntimeTurnEvent> {
        for (const event of events) {
          backend.streamedEvents.push(event);
          if (
            event.type === "completed" ||
            event.type === "failed" ||
            event.type === "cancelled" ||
            event.type === "withdrawn"
          ) {
            backend.terminalEvents.push({
              type: event.type,
              turnId: event.turnId,
            });
          }
          yield event;
        }
        if (!backend.isClosed()) {
          backend.status = "ready";
        }
      })(this),
      turnId,
    };
  }

  async cancelTurn(turnId: string): Promise<boolean> {
    this.cancelTurnCalls.push(turnId);
    return !this.isClosed();
  }
}

function createSnapshot(
  overrides?: Partial<AcpRuntimeSnapshot>,
): AcpRuntimeSnapshot {
  return {
    agent: {
      command: "mock-agent",
      type: "mock-agent",
    },
    config: {
      model: "claude",
      reasoning: "medium",
    },
    currentModeId: "default",
    cwd: "/tmp/project",
    session: {
      id: "session-1",
    },
    version: ACP_RUNTIME_SNAPSHOT_VERSION,
    ...overrides,
  };
}

function createTestRuntime(
  sessionService: Partial<AcpSessionService>,
  options?: {
    agentResolver?: (agentId: string) => Promise<{ command: string; args?: string[]; env?: Record<string, string | undefined>; type?: string }>;
    state?: AcpRuntimeStateOptions | false;
  },
): AcpRuntime {
  return new AcpRuntime(
    async () => {
      throw new Error("not used");
    },
    {
      sessionService: {
        async create() {
          throw new Error("not used");
        },
        async load() {
          throw new Error("not used");
        },
        async listAgentSessions() {
          throw new Error("not used");
        },
        async resume() {
          throw new Error("not used");
        },
        ...sessionService,
      },
      agentResolver: options?.agentResolver,
      state: options?.state ?? false,
    },
  );
}

async function createSessionRegistryPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "acp-runtime-test-"));
  tempDirs.push(dir);
  return join(dir, "runtime-session-registry.json");
}

function createSessionRegistry(path: string): AcpRuntimeSessionRegistry {
  return new AcpRuntimeSessionRegistry({
    store: new AcpRuntimeJsonSessionRegistryStore(path),
  });
}

async function readStoredSnapshot(
  path: string,
  sessionId: string,
): Promise<AcpRuntimeSnapshot | undefined> {
  const registry = createSessionRegistry(path);
  await registry.hydrate();
  return registry.getSnapshot(sessionId);
}

beforeEach(() => {
  testSpanExporter.reset();
  testLogExporter.reset();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("AcpRuntime public SDK", () => {
  it("emits a session start span when creating a session", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      {
        turnId: "turn-1",
        type: "started",
      },
      {
        output: [{ text: "ok", type: "text" }],
        outputText: "ok",
        turnId: "turn-1",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: snapshot.agent,
      cwd: snapshot.cwd,
    });

    await session.close();

    const sessionSpan = testSpanExporter
      .getFinishedSpans()
      .find((span) => span.name === "acp.session.start");

    expect(sessionSpan).toBeDefined();
    expect(sessionSpan?.attributes["acp.session.id"]).toBe("session-1");
    expect(sessionSpan?.attributes["acp.agent.type"]).toBe("mock-agent");
    const sessionLog = testLogExporter
      .getFinishedLogRecords()
      .find((record) => record.eventName === "acp.session.start");
    expect(sessionLog).toBeDefined();
    expect(sessionLog?.attributes["acp.session.id"]).toBe("session-1");
    expect(sessionLog?.body).toBe("Runtime session started.");
  });

  it("creates a session and returns completed output through run()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { position: 0, turnId: "turn-1", type: "queued" },
      { turnId: "turn-1", type: "started" },
      { text: "hello", turnId: "turn-1", type: "text" },
      {
        output: [{ text: "hello", type: "text" }],
        outputText: "hello",
        turnId: "turn-1",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create(_options: AcpRuntimeCreateOptions) {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(session.status).toBe("ready");
    expect(session.snapshot()).toEqual(snapshot);
    expect(session.capabilities.agent.prompt).toBe(true);
    expect(session.metadata.id).toBe("session-1");
    expect(session.diagnostics.lastUsage).toBeUndefined();
    await expect(session.turn.run("say hello")).resolves.toBe("hello");
    expect(session.status).toBe("ready");
  });

  it("creates sessions from registry-resolved agents", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    let createOptions: AcpRuntimeCreateOptions | undefined;

    const runtime = createTestRuntime(
      {
        async create(options: AcpRuntimeCreateOptions) {
          createOptions = options;
          return backend;
        },
      },
      {
        async agentResolver(agentId) {
          return {
            args: ["--flag"],
            command: "resolved-agent",
            env: { TOKEN: "1" },
            type: agentId,
          };
        },
      },
    );

    await runtime.sessions.start({
      agent: "claude-acp",
      cwd: "/tmp/project",
    });

    expect(createOptions).toEqual(
      expect.objectContaining({
      agent: {
        args: ["--flag"],
        command: "resolved-agent",
        env: { TOKEN: "1" },
        type: "claude-acp",
      },
      cwd: "/tmp/project",
      }),
    );
  });

  it("exposes namespaced runtime session helpers", async () => {
    const createBackend = new SpySessionBackend(createSnapshot(), () => []);
    const loadBackend = new SpySessionBackend(
      createSnapshot({
        session: {
          id: "session-2",
        },
      }),
      () => [],
    );
    let createOptions: AcpRuntimeCreateOptions | undefined;
    let loadOptions: AcpRuntimeLoadOptions | undefined;

    const runtime = createTestRuntime(
      {
        async create(options: AcpRuntimeCreateOptions) {
          createOptions = options;
          return createBackend;
        },
        async load(options: AcpRuntimeLoadOptions) {
          loadOptions = options;
          return loadBackend;
        },
      },
      {
        async agentResolver(agentId) {
          return {
            command: "resolved-agent",
            type: agentId,
          };
        },
      },
    );

    await runtime.sessions.start({
      agent: "claude-acp",
      cwd: "/tmp/project",
    });
    await runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-2",
    });

    expect(createOptions?.agent.type).toBe("claude-acp");
    expect(loadOptions?.sessionId).toBe("session-2");
  });

  it("loads sessions from registry-resolved agents", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    let loadOptions: AcpRuntimeLoadOptions | undefined;

    const runtime = createTestRuntime(
      {
        async load(options: AcpRuntimeLoadOptions) {
          loadOptions = options;
          return backend;
        },
      },
      {
        async agentResolver(agentId) {
          return {
            command: "resolved-agent",
            type: agentId,
          };
        },
      },
    );

    await runtime.sessions.load({
      agent: "simulator-agent-acp-local",
      cwd: "/tmp/project",
      sessionId: "session-1",
    });

    expect(loadOptions).toEqual(
      expect.objectContaining({
      agent: {
        command: "resolved-agent",
        type: "simulator-agent-acp-local",
      },
      cwd: "/tmp/project",
      sessionId: "session-1",
      }),
    );
  });

  it("lists sessions from registry-resolved agents", async () => {
    const expectedList: AcpRuntimeSessionList = {
      sessions: [],
      nextCursor: undefined,
    };
    let listOptions: AcpRuntimeListAgentSessionsOptions | undefined;

    const runtime = createTestRuntime(
      {
        async listAgentSessions(options: AcpRuntimeListAgentSessionsOptions) {
          listOptions = options;
          return expectedList;
        },
      },
      {
        async agentResolver(agentId) {
          return {
            command: "resolved-agent",
            type: agentId,
          };
        },
      },
    );

    const result = await runtime.sessions.list({
      agent: "claude-acp",
      cursor: "cursor-1",
      cwd: "/tmp/project",
      source: "remote",
    });

    expect(result).toEqual(expectedList);
    expect(listOptions).toEqual(
      expect.objectContaining({
      agent: {
        command: "resolved-agent",
        type: "claude-acp",
      },
      cursor: "cursor-1",
      cwd: "/tmp/project",
      }),
    );
  });

  it("supports structured prompts and structured output through send()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, (prompt) => {
      receivedPrompt = prompt;
      return [
        { turnId: "turn-2", type: "started" },
        {
          metadata: {
            availableCommands: [{ name: "plan" }],
            currentModeId: "default",
            id: "session-1",
            title: "Runtime Session",
          },
          turnId: "turn-2",
          type: "metadata_updated",
        },
        { text: "reading context", turnId: "turn-2", type: "thinking" },
        {
          turnId: "turn-2",
          type: "usage_updated",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
        },
        {
          operation: {
            id: "op-1",
            kind: "write_file",
            phase: "proposed",
            title: "Write summary file",
            turnId: "turn-2",
          },
          turnId: "turn-2",
          type: "operation_started",
        },
        {
          output: [
            { text: "summary complete", type: "text" },
            {
              title: "summary.json",
              type: "file",
              uri: "file:///tmp/summary.json",
            },
            { type: "json", value: { ok: true } },
          ],
          outputText: "summary complete",
          turnId: "turn-2",
          type: "completed",
        },
      ];
    });
    let receivedPrompt: AcpRuntimePrompt | undefined;
    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    const prompt = [
      {
        content: "Return a structured summary.",
        role: "system",
      },
      {
        content: [
          { text: "Summarize this file.", type: "text" },
          { title: "README", type: "file", uri: "file:///tmp/README.md" },
          {
            data: "aGVsbG8=",
            mediaType: "audio/wav",
            title: "voice-note",
            type: "audio",
          },
          {
            mediaType: "text/plain",
            text: "embedded runtime context",
            title: "notes",
            type: "resource",
            uri: "file:///tmp/notes.txt",
          },
        ],
        role: "user",
      },
    ] as const;

    const seen: string[] = [];
    const result = await session.turn.send(prompt, {
      onEvent(event) {
        seen.push(event.type);
      },
    });

    expect(receivedPrompt).toEqual(prompt);
    expect(result).toEqual({
      output: [
        { text: "summary complete", type: "text" },
        {
          title: "summary.json",
          type: "file",
          uri: "file:///tmp/summary.json",
        },
        { type: "json", value: { ok: true } },
      ],
      outputText: "summary complete",
      turnId: "turn-2",
    });
    expect(seen).toEqual([
      "started",
      "metadata_updated",
      "thinking",
      "usage_updated",
      "operation_started",
      "completed",
    ]);
  });

  it("forwards stream arguments and returns the raw events through stream()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { position: 0, turnId: "turn-stream", type: "queued" },
      { turnId: "turn-stream", type: "started" },
      {
        output: [{ text: "streamed", type: "text" }],
        outputText: "streamed",
        turnId: "turn-stream",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    const options = {
      timeoutMs: 999,
    };

    const events: string[] = [];
    for await (const event of session.turn.stream("streamed prompt", options)) {
      events.push(event.type);
    }

    expect(events).toEqual(["queued", "started", "completed"]);
    expect(backend.streamCalls).toHaveLength(1);
    expect(backend.streamCalls[0].prompt).toBe("streamed prompt");
    expect(backend.streamCalls[0].options).toEqual(options);
    expect(backend.streamedEvents).toHaveLength(3);
    expect(backend.terminalEvents).toEqual([
      {
        turnId: "turn-stream",
        type: "completed",
      },
    ]);
  });

  it("exposes turn handles and turn cancellation through session.turn", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-handle", type: "started" },
      {
        output: [{ text: "done", type: "text" }],
        outputText: "done",
        turnId: "turn-handle",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    const turn = session.turn.start("hello from handle");
    expect(turn.turnId).toBe("turn-handle");
    expect(await session.turn.cancel(turn.turnId)).toBe(true);
    expect(backend.cancelTurnCalls).toEqual(["turn-handle"]);

    const events: string[] = [];
    for await (const event of turn.events) {
      events.push(event.type);
    }
    expect(events).toEqual(["started", "completed"]);
    expect((await turn.completion).outputText).toBe("done");
  });

  it("exposes raw agent modes and config options for direct host control", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "ok", type: "text" }],
        outputText: "ok",
        turnId: "turn-raw",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(session.agent.listModes()).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
    expect(session.agent.listConfigOptions()).toEqual([
      {
        id: "model",
        name: "Model",
        options: [
          { name: "Claude", value: "claude" },
          { name: "Opus", value: "opus" },
        ],
        type: "select",
        value: "claude",
      },
    ]);

    await session.agent.setMode("plan");
    await session.agent.setConfigOption("model", "opus");

    expect(backend.agentModeCalls).toEqual(["plan"]);
    expect(backend.agentConfigOptionCalls).toEqual([
      { id: "model", value: "opus" },
    ]);
    expect(session.metadata.currentModeId).toBe("plan");
    expect(session.metadata.config).toEqual({
      model: "opus",
      reasoning: "medium",
    });
    expect(session.snapshot().currentModeId).toBe("plan");
    expect(session.snapshot().config).toEqual({
      model: "opus",
      reasoning: "medium",
    });
  });

  it("applies supported initial config after session startup", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      initialConfig: {
        mode: "plan",
        model: "opus",
      },
    });

    expect(backend.agentModeCalls).toEqual(["plan"]);
    expect(backend.agentConfigOptionCalls).toEqual([
      { id: "model", value: "opus" },
    ]);
    expect(session.initialConfigReport).toEqual({
      items: [
        {
          appliedValue: "plan",
          key: "mode",
          optionId: "currentModeId",
          requestedValue: "plan",
          status: "applied",
        },
        {
          appliedValue: "opus",
          key: "model",
          optionId: "model",
          requestedValue: "opus",
          status: "applied",
        },
      ],
      ok: true,
    });
    expect(session.metadata.currentModeId).toBe("plan");
    expect(session.metadata.config?.model).toBe("opus");
  });

  it("adapts initial model and reasoning aliases through agent profiles", async () => {
    const snapshot = createSnapshot({
      agent: {
        command: "claude-agent-acp",
        type: "claude-acp",
      },
      config: {
        effort: "medium",
        model: "sonnet",
      },
    });
    const backend = new SpySessionBackend(snapshot, () => []);
    backend.metadata.agentConfigOptions = [
      {
        category: "model",
        id: "model",
        name: "Model",
        options: [
          { name: "Sonnet", value: "sonnet" },
          { name: "Opus", value: "opus" },
        ],
        type: "select",
        value: "sonnet",
      },
      {
        category: "effort",
        id: "effort",
        name: "Effort",
        options: [
          { name: "Medium", value: "medium" },
          { name: "Max", value: "max" },
        ],
        type: "select",
        value: "medium",
      },
    ];
    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: {
        command: "claude-agent-acp",
        type: "claude-acp",
      },
      cwd: "/tmp/project",
      initialConfig: {
        model: "opus",
        effort: "xhigh",
      },
    });

    expect(backend.agentConfigOptionCalls).toEqual([
      { id: "model", value: "opus" },
      { id: "effort", value: "max" },
    ]);
    expect(session.initialConfigReport?.items).toMatchObject([
      {
        appliedValue: "opus",
        key: "model",
        optionId: "model",
        requestedValue: "opus",
        status: "applied",
      },
      {
        appliedValue: "max",
        key: "effort",
        optionId: "effort",
        requestedValue: "xhigh",
        status: "applied",
      },
    ]);
  });

  it("keeps sessions usable when best-effort initial config drifts", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      initialConfig: {
        mode: "removed-mode",
        model: "removed-model",
      },
    });

    expect(backend.status).toBe("ready");
    expect(backend.agentModeCalls).toEqual([]);
    expect(backend.agentConfigOptionCalls).toEqual([]);
    expect(session.initialConfigReport?.ok).toBe(false);
    expect(session.initialConfigReport?.items).toEqual([
      {
        key: "mode",
        reason: "Requested mode is not available.",
        requestedValue: "removed-mode",
        status: "skipped",
      },
      {
        key: "model",
        optionId: "model",
        reason:
          "Requested value is not supported by the current ACP agent config.",
        requestedValue: "removed-model",
        status: "skipped",
      },
    ]);
  });

  it("fails and closes newly created sessions for strict initial config drift", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    await expect(
      runtime.sessions.start({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        initialConfig: {
          model: "removed-model",
          strict: true,
        },
      }),
    ).rejects.toBeInstanceOf(AcpInitialConfigError);
    expect(backend.status).toBe("closed");
  });

  it("forwards create, load, and resume options to the implementation", async () => {
    const createSnapshotValue = createSnapshot({
      session: { id: "session-create" },
    });
    const loadSnapshotValue = createSnapshot({
      session: { id: "session-load" },
    });
    const resumeSnapshotValue = createSnapshot({
      session: { id: "session-resume" },
    });
    let createOptions: AcpRuntimeCreateOptions | undefined;
    let loadOptions: AcpRuntimeLoadOptions | undefined;
    let resumeOptions: AcpRuntimeResumeOptions | undefined;

    const createdBackend = new SpySessionBackend(createSnapshotValue, () => [
      {
        output: [{ text: "created", type: "text" }],
        outputText: "created",
        turnId: "turn-create",
        type: "completed",
      },
    ]);
    const loadedBackend = new SpySessionBackend(loadSnapshotValue, () => [
      {
        output: [{ text: "loaded", type: "text" }],
        outputText: "loaded",
        turnId: "turn-load",
        type: "completed",
      },
    ]);
    const resumedBackend = new SpySessionBackend(resumeSnapshotValue, () => [
      {
        output: [{ text: "resumed", type: "text" }],
        outputText: "resumed",
        turnId: "turn-resume",
        type: "completed",
      },
    ]);
    const sessionRegistryPath = await createSessionRegistryPath();
    const registry = createSessionRegistry(sessionRegistryPath);
    await registry.rememberSnapshot(resumeSnapshotValue);

    const runtime = createTestRuntime(
      {
        async create(options) {
          createOptions = options;
          return createdBackend;
        },
        async load(options) {
          loadOptions = options;
          return loadedBackend;
        },
        async resume(options) {
          resumeOptions = options;
          return resumedBackend;
        },
      },
      {
        state: { sessionRegistryPath },
      },
    );

    const session = await runtime.sessions.start({
      agent: {
        command: "mock-agent",
      },
      cwd: "/tmp/project",
      mcpServers: [
        {
          name: "workspace",
          transport: {
            type: "stdio",
            command: "node",
          },
        },
      ],
    });

    await session.turn.send("created");
    const loadCall = await runtime.sessions.load({
      agent: {
        command: "mock-agent",
      },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    await loadCall.turn.send("loaded");
    const resumeCall = await runtime.sessions.resume({
      handlers: {},
      sessionId: resumeSnapshotValue.session.id,
    });
    await resumeCall.turn.send("resumed");

    expect(createOptions).toMatchObject({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      mcpServers: [
        {
          name: "workspace",
          transport: { type: "stdio", command: "node" },
        },
      ],
    });
    expect(loadOptions).toMatchObject({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    expect(resumeOptions).toMatchObject({
      snapshot: resumeSnapshotValue,
      handlers: {},
    });
  });

  it("forwards list options to the implementation and returns runtime session references", async () => {
    let listOptions: AcpRuntimeListAgentSessionsOptions | undefined;
    const listed: AcpRuntimeSessionList = {
      nextCursor: "cursor-2",
      sessions: [
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-1",
          title: "Listed Session",
          updatedAt: "2026-04-12T00:00:03.000Z",
        },
      ],
    };

    const runtime = createTestRuntime({
      async listAgentSessions(options) {
        listOptions = options;
        return listed;
      },
    });

    await expect(
      runtime.sessions.list({
        agent: { command: "mock-agent" },
        cursor: "cursor-1",
        cwd: "/tmp/project",
        source: "remote",
      }),
    ).resolves.toEqual({
      nextCursor: "cursor-2",
      sessions: [
        {
          ...listed.sessions[0],
          source: "remote",
        },
      ],
    });

    expect(listOptions).toEqual(
      expect.objectContaining({
      agent: { command: "mock-agent" },
      cursor: "cursor-1",
      cwd: "/tmp/project",
      }),
    );
  });

  it("rethrows runtime failures from send()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-3", type: "started" },
      {
        error: new AcpPermissionDeniedError("Denied."),
        turnId: "turn-3",
        type: "failed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.turn.send("write")).rejects.toBeInstanceOf(
      AcpPermissionDeniedError,
    );
  });

  it("throws protocol error when terminal event is followed by non-terminal events", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-bad-order", type: "started" },
      {
        output: [{ text: "ok", type: "text" }],
        outputText: "ok",
        turnId: "turn-bad-order",
        type: "completed",
      },
      { text: "after terminal", turnId: "turn-bad-order", type: "text" },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.turn.send("invalid")).rejects.toBeInstanceOf(
      AcpProtocolError,
    );
  });

  it("throws protocol error when terminal events are emitted twice", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-multi", type: "started" },
      {
        output: [{ text: "first", type: "text" }],
        outputText: "first",
        turnId: "turn-multi",
        type: "completed",
      },
      {
        output: [{ text: "second", type: "text" }],
        outputText: "second",
        turnId: "turn-multi",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.turn.send("invalid")).rejects.toBeInstanceOf(
      AcpProtocolError,
    );
  });

  it("throws a protocol error when a turn stream has no terminal event", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-missing-terminal", type: "started" },
      {
        text: "still thinking",
        turnId: "turn-missing-terminal",
        type: "thinking",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.turn.send("missing terminal")).rejects.toBeInstanceOf(
      AcpProtocolError,
    );
  });

  it("supports load(), resume(), setAgentMode(), cancel(), and close()", async () => {
    const snapshot = createSnapshot();
    const loadBackend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-4", type: "started" },
      {
        error: new AcpTurnCancelledError("cancelled"),
        turnId: "turn-4",
        type: "cancelled",
      },
    ]);
    const resumedBackend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-5", type: "started" },
      {
        output: [{ text: "resumed", type: "text" }],
        outputText: "resumed",
        turnId: "turn-5",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async load() {
        return loadBackend;
      },
      async resume() {
        return resumedBackend;
      },
    });

    const loaded = await runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    await expect(loaded.turn.send("cancel me")).rejects.toBeInstanceOf(
      AcpTurnCancelledError,
    );

    await loaded.agent.setMode("deny");
    expect(loaded.metadata.currentModeId).toBe("deny");

    await loaded.close();
    expect(loaded.status).toBe("closed");
    expect(loadBackend.status).toBe("closed");

    const resumed = await runtime.sessions.resume({
      agent: snapshot.agent,
      cwd: snapshot.cwd,
      sessionId: snapshot.session.id,
    });
    await expect(resumed.turn.run("resume")).resolves.toBe("resumed");
  });

  it("rejects send() with a withdrawn error when a queued turn is removed before start", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { position: 0, turnId: "turn-withdrawn", type: "queued" },
      {
        error: new AcpTurnWithdrawnError("withdrawn"),
        turnId: "turn-withdrawn",
        type: "withdrawn",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.turn.send("queued")).rejects.toBeInstanceOf(
      AcpTurnWithdrawnError,
    );
  });

  it("exposes namespaced session facades", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { turnId: "turn-1", type: "started" },
      { text: "hello", turnId: "turn-1", type: "text" },
      {
        output: [{ text: "hello", type: "text" }],
        outputText: "hello",
        turnId: "turn-1",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(await session.turn.run("hello")).toBe("hello");
    await session.agent.setMode("plan");
    await session.agent.setConfigOption("model", "opus");

    expect(session.state.diffs.list()).toEqual([]);
    expect(session.state.thread.entries()).toEqual([]);
    expect(session.queue.policy()).toEqual({ delivery: "sequential" });
    expect(session.queue.setPolicy({ delivery: "coalesce" })).toEqual({
      delivery: "coalesce",
    });
    expect(session.queue.policy()).toEqual({ delivery: "coalesce" });
    expect(session.turn.queue.list()).toEqual([]);
    expect(session.turn.queue.get("missing")).toBeUndefined();
    expect(session.turn.queue.remove("missing")).toBe(false);
    expect(session.turn.queue.clear()).toBe(0);
    await expect(session.turn.queue.sendNow("missing")).resolves.toBe(false);
    expect(backend.sendQueuedTurnNowCalls).toEqual(["missing"]);
    expect(session.state.metadata()).toBeUndefined();
    expect(session.snapshot().session.id).toBe("session-1");
    await session.close();
    expect(session.status).toBe("closed");
  });

  it("forwards stream options through stream()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      { position: 0, turnId: "turn-stream", type: "queued" },
      { turnId: "turn-stream", type: "started" },
      {
        output: [{ text: "streamed", type: "text" }],
        outputText: "streamed",
        turnId: "turn-stream",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    const options = {
      timeoutMs: 999,
    };

    for await (const _event of session.turn.stream("streamed prompt", options)) {
      // drain
    }

    expect(backend.streamCalls[0].options).toEqual(options);
  });

  it("updates snapshots after raw agent changes", async () => {
    const snapshot = createSnapshot();
    const runtime = createTestRuntime({
      async create() {
        return new SpySessionBackend(snapshot, () => [
          {
            output: [{ text: "ok", type: "text" }],
            outputText: "ok",
            turnId: "turn-configure",
            type: "completed",
          },
        ]);
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await session.agent.setMode("plan");
    await session.agent.setConfigOption("model", "opus");

    expect(session.snapshot()).toEqual({
      ...snapshot,
      config: {
        model: "opus",
        reasoning: "medium",
      },
      currentModeId: "plan",
    });
  });

  it("wraps creation, list, load, and resume failures in typed runtime errors", async () => {
    const runtime = createTestRuntime({
      async create() {
        throw new Error("create failed");
      },
      async listAgentSessions() {
        throw new Error("list failed");
      },
      async load() {
        throw new Error("load failed");
      },
      async resume() {
        throw new Error("resume failed");
      },
    });

    await expect(
      runtime.sessions.start({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
      }),
    ).rejects.toBeInstanceOf(AcpCreateError);

    await expect(
      runtime.sessions.list({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        source: "remote",
      }),
    ).rejects.toBeInstanceOf(AcpListError);

    await expect(
      runtime.sessions.load({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        sessionId: "session-1",
      }),
    ).rejects.toBeInstanceOf(AcpLoadError);

    await expect(
      runtime.sessions.resume({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        sessionId: "session-1",
      }),
    ).rejects.toBeInstanceOf(AcpResumeError);
  });

  it("records managed session snapshots into the host registry and refreshes them after raw updates()", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "ok", type: "text" }],
        outputText: "ok",
        turnId: "turn-registry",
        type: "completed",
      },
    ]);
    const sessionRegistryPath = await createSessionRegistryPath();
    const runtime = new AcpRuntime(
      async () => {
        throw new Error("not used");
      },
      {
        sessionService: {
          async create() {
            return backend;
          },
          async listAgentSessions() {
            return { sessions: [] };
          },
          async load() {
            return backend;
          },
          async resume() {
            return backend;
          },
        },
        state: { sessionRegistryPath },
      },
    );

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent", type: "mock-agent" },
      cwd: "/tmp/project",
    });
    await expect(
      readStoredSnapshot(sessionRegistryPath, session.metadata.id),
    ).resolves.toEqual(snapshot);

    await session.agent.setMode("plan");
    await session.agent.setConfigOption("model", "opus");

    await expect(
      readStoredSnapshot(sessionRegistryPath, session.metadata.id),
    ).resolves.toEqual({
      ...snapshot,
      config: {
        model: "opus",
        reasoning: "medium",
      },
      currentModeId: "plan",
    });
  });

  it("exposes registry-backed session lists through the unified runtime list API", async () => {
    const sessionRegistryPath = await createSessionRegistryPath();
    const registry = createSessionRegistry(sessionRegistryPath);
    await registry.rememberSnapshot(
      createSnapshot({
        session: {
          id: "session-a",
        },
      }),
      {
        title: "Session A",
      },
    );
    await registry.rememberSnapshot(
      createSnapshot({
        agent: {
          command: "mock-agent",
          type: "mock-agent",
        },
        session: {
          id: "session-b",
        },
      }),
      {
        title: "Session B",
      },
    );

    const runtime = createTestRuntime(
      {
        async listAgentSessions() {
          return {
            nextCursor: undefined,
            sessions: [
              {
                agentType: "mock-agent",
                cwd: "/tmp/project",
                id: "session-b",
                title: "Remote Session B",
                updatedAt: "2026-04-12T00:00:10.000Z",
              },
              {
                agentType: "mock-agent",
                cwd: "/tmp/project",
                id: "session-c",
                title: "Remote Session C",
                updatedAt: "2026-04-12T00:00:11.000Z",
              },
            ],
          };
        },
      },
      { state: { sessionRegistryPath } },
    );

    expect(await runtime.sessions.list({ source: "local" })).toEqual({
      nextCursor: undefined,
      sessions: [
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-b",
          source: "local",
          title: "Session B",
          updatedAt: expect.any(String),
        },
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-a",
          source: "local",
          title: "Session A",
          updatedAt: expect.any(String),
        },
      ],
    });

    expect(
      await runtime.sessions.list({
        agent: { command: "mock-agent", type: "mock-agent" },
        cwd: "/tmp/project",
        source: "all",
      }),
    ).toEqual({
      nextCursor: undefined,
      sessions: [
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-b",
          source: "both",
          title: "Remote Session B",
          updatedAt: expect.any(String),
        },
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-a",
          source: "local",
          title: "Session A",
          updatedAt: expect.any(String),
        },
        {
          agentType: "mock-agent",
          cwd: "/tmp/project",
          id: "session-c",
          source: "remote",
          title: "Remote Session C",
          updatedAt: "2026-04-12T00:00:11.000Z",
        },
      ],
    });
  });

  it("deduplicates concurrent load calls for the same session id", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    let resolveLoad: ((driver: AcpSessionDriver) => void) | undefined;
    let loadCalls = 0;

    const runtime = createTestRuntime({
      async load() {
        loadCalls += 1;
        return await new Promise<AcpSessionDriver>((resolve) => {
          resolveLoad = resolve;
        });
      },
    });

    const firstPromise = runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    const secondPromise = runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadCalls).toBe(1);
    resolveLoad?.(backend);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.metadata.id).toBe("session-1");
    expect(second.metadata.id).toBe("session-1");

    await first.close();
    expect(backend.status).toBe("ready");
    await second.close();
    expect(backend.status).toBe("closed");
  });

  it("reuses an active loaded session and closes the driver only after the final handle closes", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "shared", type: "text" }],
        outputText: "shared",
        turnId: "turn-shared",
        type: "completed",
      },
    ]);
    let loadCalls = 0;

    const runtime = createTestRuntime({
      async load() {
        loadCalls += 1;
        return backend;
      },
    });

    const first = await runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    const second = await runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });

    expect(loadCalls).toBe(1);

    await first.close();
    expect(first.status).toBe("closed");
    expect(second.status).toBe("ready");
    expect(backend.status).toBe("ready");
    await expect(second.turn.run("still open")).resolves.toBe("shared");

    await second.close();
    expect(backend.status).toBe("closed");
  });

  it("rejects systemPrompt on load because the option is not accepted", async () => {
    let loadCalls = 0;
    const runtime = createTestRuntime({
      async load() {
        loadCalls += 1;
        throw new Error("should not load");
      },
    });

    await expect(
      runtime.sessions.load({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        sessionId: "session-1",
        systemPrompt: "not allowed",
      } as Parameters<typeof runtime.sessions.load>[0] & {
        systemPrompt: string;
      }),
    ).rejects.toBeInstanceOf(AcpSystemPromptError);
    expect(loadCalls).toBe(0);
  });

  it("waits for an in-flight close before reopening the same session id", async () => {
    const snapshot = createSnapshot();
    let resolveClose: (() => void) | undefined;
    class SlowCloseBackend extends SpySessionBackend {
      override async close(): Promise<void> {
        await new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        await super.close();
      }
    }
    const firstBackend = new SlowCloseBackend(snapshot, () => []);
    const secondBackend = new SpySessionBackend(snapshot, () => []);
    let loadCalls = 0;
    const runtime = createTestRuntime({
      async load() {
        loadCalls += 1;
        return loadCalls === 1 ? firstBackend : secondBackend;
      },
    });

    const first = await runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    const closePromise = first.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondPromise = runtime.sessions.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadCalls).toBe(1);

    resolveClose?.();
    await closePromise;
    const second = await secondPromise;
    expect(loadCalls).toBe(2);
    expect(firstBackend.status).toBe("closed");
    expect(second.metadata.id).toBe("session-1");
    await second.close();
  });

  it("deduplicates concurrent resume calls for the same session id and shares the underlying driver", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    let resolveResume: ((driver: AcpSessionDriver) => void) | undefined;
    let resumeCalls = 0;

    const sessionRegistryPath = await createSessionRegistryPath();
    const registry = createSessionRegistry(sessionRegistryPath);
    await registry.rememberSnapshot(snapshot);

    const runtime = createTestRuntime(
      {
        async resume() {
          resumeCalls += 1;
          return await new Promise<AcpSessionDriver>((resolve) => {
            resolveResume = resolve;
          });
        },
      },
      { state: { sessionRegistryPath } },
    );

    const firstPromise = runtime.sessions.resume({
      sessionId: snapshot.session.id,
    });
    const secondPromise = runtime.sessions.resume({
      sessionId: snapshot.session.id,
    });

    for (let attempt = 0; attempt < 10 && resumeCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(resumeCalls).toBe(1);
    resolveResume?.(backend);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    await first.close();
    expect(backend.status).toBe("ready");
    await second.close();
    expect(backend.status).toBe("closed");
  });

  it("rejects systemPrompt on resume because the option is not accepted", async () => {
    let resumeCalls = 0;
    const runtime = createTestRuntime({
      async resume() {
        resumeCalls += 1;
        throw new Error("should not resume");
      },
    });

    await expect(
      runtime.sessions.resume({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        sessionId: "session-1",
        systemPrompt: "not allowed",
      } as Parameters<typeof runtime.sessions.resume>[0] & {
        systemPrompt: string;
      }),
    ).rejects.toBeInstanceOf(AcpSystemPromptError);
    expect(resumeCalls).toBe(0);
  });

  it("deduplicates concurrent load and resume calls for the same session id", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);
    let resolveLoad: ((driver: AcpSessionDriver) => void) | undefined;
    let loadCalls = 0;
    let resumeCalls = 0;

    const sessionRegistryPath = await createSessionRegistryPath();
    const registry = createSessionRegistry(sessionRegistryPath);
    await registry.rememberSnapshot(snapshot);

    const runtime = createTestRuntime(
      {
        async load() {
          loadCalls += 1;
          return await new Promise<AcpSessionDriver>((resolve) => {
            resolveLoad = resolve;
          });
        },
        async resume() {
          resumeCalls += 1;
          return backend;
        },
      },
      { state: { sessionRegistryPath } },
    );

    const loadPromise = runtime.sessions.load({
      sessionId: snapshot.session.id,
    });
    const resumePromise = runtime.sessions.resume({
      sessionId: snapshot.session.id,
    });

    for (let attempt = 0; attempt < 10 && loadCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(loadCalls).toBe(1);
    expect(resumeCalls).toBe(0);
    resolveLoad?.(backend);

    const [loaded, resumed] = await Promise.all([loadPromise, resumePromise]);
    expect(loaded.metadata.id).toBe(snapshot.session.id);
    expect(resumed.metadata.id).toBe(snapshot.session.id);
    await loaded.close();
    expect(backend.status).toBe("ready");
    await resumed.close();
    expect(backend.status).toBe("closed");
  });

  it("exposes thread-first read models from the active session handle", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => []);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(session.state.diffs.keys()).toEqual([]);
    expect(session.state.diffs.get("/tmp/file.txt")).toBeUndefined();
    expect(session.state.diffs.list()).toEqual([]);
    expect(session.state.terminals.ids()).toEqual([]);
    expect(session.state.terminals.get("term-1")).toBeUndefined();
    expect(session.state.terminals.list()).toEqual([]);
    expect(session.state.toolCalls.get("tool-1")).toBeUndefined();
    expect(session.state.toolCalls.bundles()).toEqual([]);
    expect(session.state.toolCalls.bundle("tool-1")).toBeUndefined();
    expect(session.state.toolCalls.diffs("tool-1")).toEqual([]);
    expect(session.state.toolCalls.ids()).toEqual([]);
    expect(session.state.toolCalls.list()).toEqual([]);
    expect(session.state.toolCalls.terminals("tool-1")).toEqual([]);
    expect(session.state.thread.entries()).toEqual([]);
    await session.close();
  });

  it("rejects mutating and turn operations after a session handle is closed", async () => {
    const snapshot = createSnapshot();
    const backend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "ok", type: "text" }],
        outputText: "ok",
        turnId: "turn-closed",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create() {
        return backend;
      },
    });

    const session = await runtime.sessions.start({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await session.close();

    await expect(session.agent.setMode("plan")).rejects.toThrow(
      "Session is closed.",
    );
    await expect(session.agent.setConfigOption("model", "opus")).rejects.toThrow(
      "Session is closed.",
    );
    await expect(session.turn.run("closed")).rejects.toThrow("Session is closed.");
    expect(() => session.turn.stream("closed")).toThrow("Session is closed.");
  });
});
