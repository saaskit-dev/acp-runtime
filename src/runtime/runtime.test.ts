import { describe, expect, it } from "vitest";

import { ACP_RUNTIME_SNAPSHOT_VERSION } from "./core/constants.js";
import {
  AcpCreateError,
  AcpListError,
  AcpLoadError,
  AcpPermissionDeniedError,
  AcpProtocolError,
  AcpResumeError,
  AcpRuntime,
  AcpRuntimeSessionRegistry,
  AcpTurnCancelledError,
} from "./index.js";
import type { AcpSessionDriver, AcpSessionService } from "./core/session-driver.js";
import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCreateOptions,
  AcpRuntimeLoadOptions,
  AcpRuntimeListAgentSessionsOptions,
  AcpRuntimeSessionList,
  AcpRuntimeDiagnostics,
  AcpRuntimeCapabilities,
  AcpRuntimeSessionMetadata,
  AcpRuntimeStreamOptions,
  AcpRuntimeResumeOptions,
  AcpRuntimePrompt,
  AcpRuntimeSnapshot,
  AcpRuntimeTurnEvent,
} from "./core/types.js";

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
  readonly terminalEvents: Array<{
    type: "completed" | "failed";
    turnId: string;
  }> = [];
  readonly agentConfigOptionCalls: Array<{ id: string; value: string | number | boolean }> = [];
  readonly agentModeCalls: string[] = [];
  readonly streamedEvents: AcpRuntimeTurnEvent[] = [];

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

  async cancel(): Promise<void> {
    this.status = "ready";
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

  async *stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    this.streamCalls.push({ prompt, options });
    this.status = "running";
    for (const event of this.eventFactory(prompt, options)) {
      this.streamedEvents.push(event);
      if (event.type === "completed" || event.type === "failed") {
        this.terminalEvents.push({
          type: event.type,
          turnId: event.turnId,
        });
      }
      yield event;
    }
    if (!this.isClosed()) {
      this.status = "ready";
    }
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
      ...options,
    },
  );
}

describe("AcpRuntime public SDK", () => {
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(session.status).toBe("ready");
    expect(session.snapshot()).toEqual(snapshot);
    expect(session.capabilities.agent.prompt).toBe(true);
    expect(session.metadata.id).toBe("session-1");
    expect(session.diagnostics.lastUsage).toBeUndefined();
    await expect(session.run("say hello")).resolves.toBe("hello");
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

    await runtime.createFromRegistry({
      agentId: "claude-acp",
      cwd: "/tmp/project",
    });

    expect(createOptions).toEqual({
      agent: {
        args: ["--flag"],
        command: "resolved-agent",
        env: { TOKEN: "1" },
        type: "claude-acp",
      },
      cwd: "/tmp/project",
    });
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

    await runtime.loadFromRegistry({
      agentId: "simulator-agent-acp-local",
      cwd: "/tmp/project",
      sessionId: "session-1",
    });

    expect(loadOptions).toEqual({
      agent: {
        command: "resolved-agent",
        type: "simulator-agent-acp-local",
      },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
  });

  it("lists sessions from registry-resolved agents", async () => {
    const expectedList: AcpRuntimeSessionList = {
      items: [],
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

    const result = await runtime.listAgentSessionsFromRegistry({
      agentId: "claude-acp",
      cursor: "cursor-1",
      cwd: "/tmp/project",
    });

    expect(result).toBe(expectedList);
    expect(listOptions).toEqual({
      agent: {
        command: "resolved-agent",
        type: "claude-acp",
      },
      cursor: "cursor-1",
      cwd: "/tmp/project",
    });
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

    const session = await runtime.create({
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
    const result = await session.send(prompt, {
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    const options = {
      timeoutMs: 999,
      signal: new AbortController().signal,
    };

    const events: string[] = [];
    for await (const event of session.stream("streamed prompt", options)) {
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    expect(session.listAgentModes()).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
    expect(session.listAgentConfigOptions()).toEqual([
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

    await session.setAgentMode("plan");
    await session.setAgentConfigOption("model", "opus");

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

  it("forwards create, load, and resume options to the implementation", async () => {
    const snapshot = createSnapshot();
    let createOptions: AcpRuntimeCreateOptions | undefined;
    let loadOptions: AcpRuntimeLoadOptions | undefined;
    let resumeOptions: AcpRuntimeResumeOptions | undefined;

    const loadedBackend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "loaded", type: "text" }],
        outputText: "loaded",
        turnId: "turn-load",
        type: "completed",
      },
    ]);
    const resumedBackend = new SpySessionBackend(snapshot, () => [
      {
        output: [{ text: "resumed", type: "text" }],
        outputText: "resumed",
        turnId: "turn-resume",
        type: "completed",
      },
    ]);

    const runtime = createTestRuntime({
      async create(options) {
        createOptions = options;
        return loadedBackend;
      },
      async load(options) {
        loadOptions = options;
        return loadedBackend;
      },
      async resume(options) {
        resumeOptions = options;
        return resumedBackend;
      },
    });

    const session = await runtime.create({
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

    await session.send("created");
    const loadCall = await runtime.load({
      agent: {
        command: "mock-agent",
      },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    await loadCall.send("loaded");
    const resumeCall = await runtime.resume({
      snapshot,
      handlers: {},
    });
    await resumeCall.send("resumed");

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
      snapshot,
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
      runtime.listAgentSessions({
        agent: { command: "mock-agent" },
        cursor: "cursor-1",
        cwd: "/tmp/project",
      }),
    ).resolves.toEqual(listed);

    expect(listOptions).toEqual({
      agent: { command: "mock-agent" },
      cursor: "cursor-1",
      cwd: "/tmp/project",
    });
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.send("write")).rejects.toBeInstanceOf(
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.send("invalid")).rejects.toBeInstanceOf(
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.send("invalid")).rejects.toBeInstanceOf(
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await expect(session.send("missing terminal")).rejects.toBeInstanceOf(
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
        type: "failed",
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

    const loaded = await runtime.load({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
      sessionId: "session-1",
    });
    await expect(loaded.send("cancel me")).rejects.toBeInstanceOf(
      AcpTurnCancelledError,
    );

    await loaded.setAgentMode("deny");
    expect(loaded.metadata.currentModeId).toBe("deny");

    await loaded.cancel();
    await loaded.close();
    expect(loaded.status).toBe("closed");
    expect(loadBackend.status).toBe("closed");

    const resumed = await runtime.resume({
      snapshot,
    });
    await expect(resumed.run("resume")).resolves.toBe("resumed");
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

    const session = await runtime.create({
      agent: { command: "mock-agent" },
      cwd: "/tmp/project",
    });

    await session.setAgentMode("plan");
    await session.setAgentConfigOption("model", "opus");

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
      runtime.create({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
      }),
    ).rejects.toBeInstanceOf(AcpCreateError);

    await expect(
      runtime.listAgentSessions({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
      }),
    ).rejects.toBeInstanceOf(AcpListError);

    await expect(
      runtime.load({
        agent: { command: "mock-agent" },
        cwd: "/tmp/project",
        sessionId: "session-1",
      }),
    ).rejects.toBeInstanceOf(AcpLoadError);

    await expect(
      runtime.resume({
        snapshot: createSnapshot(),
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
    const registry = new AcpRuntimeSessionRegistry();
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
        registry,
      },
    );

    const session = await runtime.create({
      agent: { command: "mock-agent", type: "mock-agent" },
      cwd: "/tmp/project",
    });
    expect(registry.getSnapshot(session.metadata.id)).toEqual(snapshot);

    await session.setAgentMode("plan");
    await session.setAgentConfigOption("model", "opus");

    expect(registry.getSnapshot(session.metadata.id)).toEqual({
      ...snapshot,
      config: {
        model: "opus",
        reasoning: "medium",
      },
      currentModeId: "plan",
    });
  });
});
