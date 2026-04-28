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
