import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpRuntimeTurnEventType } from "../../core/types.js";
import type { AcpRuntimeSession } from "../../core/session.js";
import type { AcpRuntimePrompt } from "../../core/types.js";
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
            runtime,
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
    expect(created.sessionId).toBe("runtime-session-1");

    const listed = await clientConnection.listSessions({ cwd: "/workspace" });
    expect(listCalled).toBe(true);
    expect(listed.sessions).toHaveLength(1);

    session.close = async () => {
      closeCalled = true;
    };
    await clientConnection.closeSession({ sessionId: created.sessionId });
    expect(closeCalled).toBe(true);
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
  onPrompt(prompt: AcpRuntimePrompt): void;
}): AcpRuntimeSession {
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
      id: "runtime-session-1",
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
        id: "runtime-session-1",
      },
      version: 1,
    }),
    state: {} as AcpRuntimeSession["state"],
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
