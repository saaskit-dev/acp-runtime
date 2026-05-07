import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpProcessError } from "../../core/errors.js";
import { AcpRuntimeTurnEventType } from "../../core/types.js";
import type { AcpRuntimeSession } from "../../core/session.js";
import type {
  AcpRuntimeHistoryEntry,
  AcpRuntimePrompt,
} from "../../core/types.js";
import { createAcpRemoteRuntimeAgent } from "./runtime-agent.js";

describe("AcpRemoteRuntimeAgent", () => {
  it("serves a native ACP client path through the runtime facade", async () => {
    const streams = createStreamPair();
    const notifications: unknown[] = [];
    let receivedPrompt: AcpRuntimePrompt | undefined;

    const session = createFakeRuntimeSession({
      onPrompt(prompt) {
        receivedPrompt = prompt;
      },
    });
    const runtime = {
      sessions: {
        async list() {
          return {
            sessions: [
              {
                cwd: "/workspace",
                id: "runtime-session-1",
                title: "Runtime Session",
              },
            ],
          };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            remoteDaemonId: "host-a",
            remoteMachineName: "dev-mac",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("acp-runtime-remote");

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(created.sessionId).toBe("runtime-session-1");
    expect(created._meta).toMatchObject({
      "acp-runtime/remote/daemonId": "host-a",
      "acp-runtime/remote/sessionAgent": {
        command: "fake-agent",
        type: "fake",
      },
      "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
    });
    expect(created.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "remote",
          currentValue: "dev-mac",
          id: "acp-runtime.remote.machine",
          name: "Remote Machine",
        }),
        expect.objectContaining({
          category: "remote",
          currentValue: "fake",
          id: "acp-runtime.remote.agent",
          name: "Remote Agent",
        }),
        expect.objectContaining({
          category: "remote",
          currentValue: "/workspace",
          id: "acp-runtime.remote.workspace",
          name: "Remote Workspace",
        }),
      ]),
    );

    const response = await clientConnection.prompt({
      prompt: [{ text: "hello", type: "text" }],
      sessionId: created.sessionId,
    });

    expect(response.stopReason).toBe("end_turn");
    expect(receivedPrompt).toEqual([{ text: "hello", type: "text" }]);
    expect(notifications).toEqual([
      {
        sessionId: "runtime-session-1",
        update: {
          content: {
            text: "hello from runtime",
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      },
    ]);
  });

  it("restores missing active sessions before prompt and deduplicates concurrent restores", async () => {
    const streams = createStreamPair();
    const prompts: AcpRuntimePrompt[] = [];
    let loadCalls = 0;
    const session = createFakeRuntimeSession({
      id: "restored-session",
      onPrompt(prompt) {
        prompts.push(prompt);
      },
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return session;
        },
        async resume() {
          throw new Error("resume should not be called after load succeeds");
        },
        async start() {
          throw new Error("restore must not start a new session");
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const prompt = {
      _meta: {
        "acp-runtime/remote/sessionAgent": {
          command: "fake-agent",
          type: "fake",
        },
        "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
      },
      prompt: [{ text: "restore me", type: "text" }],
      sessionId: "restored-session",
    } satisfies Parameters<typeof clientConnection.prompt>[0];

    await expect(
      Promise.all([
        clientConnection.prompt(prompt),
        clientConnection.prompt(prompt),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stopReason: "end_turn" }),
      expect.objectContaining({ stopReason: "end_turn" }),
    ]);
    expect(loadCalls).toBe(1);
    expect(prompts).toHaveLength(2);
  });

  it("replays runtime history before completing remote session load", async () => {
    const streams = createStreamPair();
    const notifications: unknown[] = [];
    let drained = false;
    const session = createFakeRuntimeSession({
      history: [
        { text: "previous user message", type: "user" },
        {
          text: "previous assistant message",
          turnId: "turn-history",
          type: AcpRuntimeTurnEventType.Text,
        },
      ],
      id: "runtime-session-history",
      onPrompt() {},
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          drained = true;
          return session;
        },
        async resume() {
          throw new Error("load should restore history session");
        },
        async start() {
          throw new Error("load should not start a new session");
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            remoteDaemonId: "host-history",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const loaded = await clientConnection.loadSession({
      cwd: "/workspace",
      mcpServers: [],
      sessionId: "zed-history-session",
    });

    expect(loaded.sessionId).toBe("runtime-session-history");
    expect(drained).toBe(true);
    expect(notifications).toEqual([
      {
        sessionId: "zed-history-session",
        update: {
          content: { text: "previous user message", type: "text" },
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "zed-history-session",
        update: {
          content: { text: "previous assistant message", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      },
    ]);
  });

  it("enforces workspace roots before starting runtime sessions", async () => {
    const streams = createStreamPair();
    let startCalled = false;
    const session = createFakeRuntimeSession({
      onPrompt() {},
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          startCalled = true;
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
            workspaceRoots: ["/allowed"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    await expect(
      clientConnection.newSession({
        cwd: "/blocked",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: {
        cwd: "/blocked",
        method: "session/new",
      },
    });
    expect(startCalled).toBe(false);
  });

  it("handles session lifecycle: create, list, close", async () => {
    const streams = createStreamPair();
    const session = createFakeRuntimeSession({ onPrompt() {} });
    let listCalled = false;
    let closeCalled = false;
    const runtime = {
      sessions: {
        async list() {
          listCalled = true;
          return { sessions: [{ cwd: "/workspace", id: "s-1", title: "S1" }] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: { command: "fake", type: "fake" },
            remoteDaemonId: "host-list",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(created.sessionId).toBe("runtime-session-1");

    const listed = await clientConnection.listSessions({ cwd: "/workspace" });
    expect(listCalled).toBe(true);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?._meta).toMatchObject({
      "acp-runtime/remote/daemonId": "host-list",
      "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
    });

    session.close = async () => {
      closeCalled = true;
    };
    await clientConnection.closeSession({ sessionId: created.sessionId });
    expect(closeCalled).toBe(true);
  });

  it("returns a clear error when remote load cannot restore the requested id", async () => {
    const streams = createStreamPair();
    let loadCalled = false;
    let resumeCalled = false;
    let startCalled = false;
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalled = true;
          throw new Error("missing local runtime snapshot");
        },
        async resume() {
          resumeCalled = true;
          throw new Error("missing active runtime snapshot");
        },
        async start() {
          startCalled = true;
          return createFakeRuntimeSession({
            id: "should-not-start",
            onPrompt() {},
          });
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    await expect(
      clientConnection.loadSession({
        cwd: "/workspace",
        mcpServers: [],
        sessionId: "stale-zed-session-id",
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining(
        "Remote runtime session could not be restored",
      ),
    });
    expect(loadCalled).toBe(true);
    expect(resumeCalled).toBe(true);
    expect(startCalled).toBe(false);
  });

  it("handles setSessionMode and setSessionConfigOption", async () => {
    const streams = createStreamPair();
    let modeSet: string | undefined;
    let configSet: { id: string; value: unknown } | undefined;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.agent.setMode = async (modeId: string) => {
      modeSet = modeId;
    };
    session.agent.setConfigOption = async (configId: string, value: unknown) => {
      configSet = { id: configId, value };
    };
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await clientConnection.setSessionMode({
      modeId: "plan",
      sessionId: created.sessionId,
    });
    expect(modeSet).toBe("plan");

    await clientConnection.setSessionConfigOption({
      configId: "auto_approve",
      sessionId: created.sessionId,
      type: "boolean",
      value: true,
    });
    expect(configSet).toEqual({ id: "auto_approve", value: true });

    configSet = undefined;
    const remoteConfig = await clientConnection.setSessionConfigOption({
      configId: "acp-runtime.remote.workspace",
      sessionId: created.sessionId,
      value: "/workspace",
    });
    expect(configSet).toBeUndefined();
    expect(remoteConfig.configOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currentValue: "/workspace",
          id: "acp-runtime.remote.workspace",
        }),
      ]),
    );
  });

  it("forwards permission prompts to the remote client", async () => {
    const streams = createStreamPair();
    let permissionRequested = false;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = (prompt) => ({
      completion: Promise.resolve({
        output: [{ text: "done", type: "text" }],
        outputText: "done",
        turnId: "turn-perm",
      }),
      events: (async function* () {
        yield { turnId: "turn-perm", type: AcpRuntimeTurnEventType.Started };
        yield {
          turnId: "turn-perm",
          type: AcpRuntimeTurnEventType.Completed,
          output: [{ text: "done", type: "text" }],
          outputText: "done",
        };
      })(),
      turnId: "turn-perm",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            permissionRequested = true;
            return { outcome: { optionId: "allow_session", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    const response = await clientConnection.prompt({
      prompt: [{ text: "do something risky", type: "text" }],
      sessionId: created.sessionId,
    });
    expect(response.stopReason).toBe("end_turn");
  });

  it("handles turn cancellation", async () => {
    const streams = createStreamPair();
    let cancelCalled = false;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    let resolveCancel: () => void;
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    session.turn.cancel = async () => {
      cancelCalled = true;
      resolveCancel();
      return true;
    };
    session.turn.start = () => ({
      completion: new Promise(() => {}),
      events: (async function* () {
        yield { turnId: "turn-cancel", type: AcpRuntimeTurnEventType.Started };
        await cancelPromise;
        yield { turnId: "turn-cancel", type: AcpRuntimeTurnEventType.Cancelled };
      })(),
      turnId: "turn-cancel",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    const promptPromise = clientConnection.prompt({
      prompt: [{ text: "long task", type: "text" }],
      sessionId: created.sessionId,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    clientConnection.cancel({
      sessionId: created.sessionId,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelCalled).toBe(true);
    void promptPromise.catch(() => {});
  });

  it("returns prompt failure causes to the ACP client", async () => {
    const streams = createStreamPair();
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = () => ({
      completion: Promise.resolve({
        output: [],
        outputText: "",
        turnId: "turn-failed",
      }),
      events: (async function* () {
        yield { turnId: "turn-failed", type: AcpRuntimeTurnEventType.Started };
        yield {
          error: new AcpProcessError(
            "ACP prompt request failed.",
            new Error("Failed to authenticate. API Error: 401"),
          ),
          turnId: "turn-failed",
          type: AcpRuntimeTurnEventType.Failed,
        };
      })(),
      turnId: "turn-failed",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await expect(
      clientConnection.prompt({
        prompt: [{ text: "hello", type: "text" }],
        sessionId: created.sessionId,
      }),
    ).rejects.toThrow(
      "ACP prompt request failed. Caused by: Failed to authenticate. API Error: 401",
    );
  });
});

function createStreamPair(): { client: Stream; server: Stream } {
  const clientToServer = new TransformStream<AnyMessage, AnyMessage>();
  const serverToClient = new TransformStream<AnyMessage, AnyMessage>();
  return {
    client: {
      readable: serverToClient.readable,
      writable: clientToServer.writable,
    },
    server: {
      readable: clientToServer.readable,
      writable: serverToClient.writable,
    },
  };
}

function createFakeRuntimeSession(input: {
  history?: readonly AcpRuntimeHistoryEntry[];
  id?: string;
  onPrompt(prompt: AcpRuntimePrompt): void;
}): AcpRuntimeSession {
  const id = input.id ?? "runtime-session-1";
  let historyDrained = false;
  return {
    agent: {
      listConfigOptions: () => [],
      listModes: () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
    },
    capabilities: {
      agent: {
        prompt: true,
      },
      client: {},
    },
    close: async () => {},
    diagnostics: {},
    initialConfigReport: undefined,
    metadata: {
      id,
      title: "Runtime Session",
    },
    queue: {
      policy: () => ({ delivery: "sequential" }),
      setPolicy: () => ({ delivery: "sequential" }),
    },
    snapshot: () => ({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      cwd: "/workspace",
      session: {
        id,
      },
      version: 1,
    }),
    state: {
      history: {
        drain: () => {
          if (historyDrained) {
            return [];
          }
          historyDrained = true;
          return input.history ?? [];
        },
      },
    } as AcpRuntimeSession["state"],
    status: "ready",
    turn: {
      cancel: async () => true,
      queue: {
        clear: () => 0,
        get: () => undefined,
        list: () => [],
        remove: () => false,
        sendNow: async () => false,
      },
      run: async () => "hello from runtime",
      send: async () => ({
        output: [{ text: "hello from runtime", type: "text" }],
        outputText: "hello from runtime",
        turnId: "turn-1",
      }),
      start: (prompt) => {
        input.onPrompt(prompt);
        return {
          completion: Promise.resolve({
            output: [{ text: "hello from runtime", type: "text" }],
            outputText: "hello from runtime",
            turnId: "turn-1",
          }),
          events: createTurnEvents(),
          turnId: "turn-1",
        };
      },
      stream: () => createTurnEvents(),
    },
  } as unknown as AcpRuntimeSession;
}

async function waitFor(
  predicate: () => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function* createTurnEvents() {
  yield {
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Started,
  };
  yield {
    text: "hello from runtime",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Text,
  };
  yield {
    output: [{ text: "hello from runtime", type: "text" }],
    outputText: "hello from runtime",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Completed,
  };
}
