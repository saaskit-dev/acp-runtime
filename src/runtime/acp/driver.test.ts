import { beforeEach, describe, expect, it } from "vitest";
import type { InitializeResponse, SessionNotification } from "@agentclientprotocol/sdk";

import { AcpClientBridge } from "./authority-bridge.js";
import { AcpSdkSessionDriver } from "./driver.js";
import {
  AcpProtocolError,
  AcpTurnCancelledError,
  AcpTurnTimeoutError,
  AcpTurnWithdrawnError,
} from "../core/errors.js";
import { resolveAcpAgentProfile } from "./profiles/index.js";
import { testLogExporter, testSpanExporter } from "../test-otel.js";

beforeEach(() => {
  testLogExporter.reset();
  testSpanExporter.reset();
});

describe("AcpSdkSessionDriver thread-first model", () => {
  it("emits turn, tool, and permission spans during a prompt turn", async () => {
    const bridge = new AcpClientBridge();
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          await bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              content: {
                text: "thinking aloud",
                type: "text",
              },
              sessionUpdate: "agent_thought_chunk",
            },
          } satisfies SessionNotification);

          await bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              kind: "execute",
              rawInput: {
                args: ["status"],
                command: "git",
                cwd: "/tmp/project",
              },
              sessionUpdate: "tool_call",
              status: "in_progress",
              title: "Check git status",
              toolCallId: "tool-1",
            },
          } satisfies SessionNotification);

          await bridge.requestPermission({
            options: [
              {
                kind: "allow_once",
                optionId: "allow-once",
              },
            ],
            toolCall: {
              content: [],
              kind: "execute",
              title: "Check git status",
            },
          } as never);

          await bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              content: {
                text: "done",
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          } satisfies SessionNotification);

          await bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              rawOutput: { ok: true },
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "tool-1",
            },
          } satisfies SessionNotification);

          return {
            content: [{ text: "done", type: "text" }],
            stopReason: "end_turn",
            usage: {
              cachedReadTokens: 11,
              cachedWriteTokens: 7,
              inputTokens: 101,
              outputTokens: 29,
              thoughtTokens: 13,
              totalTokens: 150,
            },
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      handlers: {
        permission: async () => ({
          decision: "allow",
          scope: "once",
        }),
      },
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const events = [];
    for await (const event of driver.stream("hello")) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toContain("usage_updated");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "usage_updated",
        usage: expect.objectContaining({
          cachedReadTokens: 11,
          cachedWriteTokens: 7,
          inputTokens: 101,
          outputTokens: 29,
          thoughtTokens: 13,
          totalTokens: 150,
        }),
      }),
    );

    const spans = testSpanExporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(
      expect.arrayContaining(["acp.turn", "acp.tool", "acp.permission"]),
    );
    expect(
      spans.find((span) => span.name === "acp.turn")?.attributes["acp.turn.outcome"],
    ).toBe("completed");
    expect(
      spans.find((span) => span.name === "acp.tool")?.attributes["acp.operation.outcome"],
    ).toBe("completed");
    expect(
      spans.find((span) => span.name === "acp.permission")?.attributes["acp.permission.decision"],
    ).toBe("allowed");
    const turnSpan = spans.find((span) => span.name === "acp.turn");
    expect(turnSpan?.attributes["acp.prompt.content"]).toBe("hello");
    expect(turnSpan?.attributes["acp.turn.output_text"]).toBe("done");
    expect(
      turnSpan?.events.some(
        (event) =>
          event.name === "acp.turn.thought"
          && event.attributes["acp.content.value"] === "thinking aloud",
      ),
    ).toBe(true);
    expect(
      turnSpan?.events.some(
        (event) =>
          event.name === "acp.turn.output"
          && event.attributes["acp.content.value"] === "done",
      ),
    ).toBe(true);
    expect(turnSpan?.attributes["acp.usage.cached_read_tokens"]).toBe(11);
    expect(turnSpan?.attributes["acp.usage.cached_write_tokens"]).toBe(7);
    expect(turnSpan?.attributes["acp.usage.input_tokens"]).toBe(101);
    expect(turnSpan?.attributes["acp.usage.output_tokens"]).toBe(29);
    expect(turnSpan?.attributes["acp.usage.thought_tokens"]).toBe(13);
    expect(turnSpan?.attributes["acp.usage.total_tokens"]).toBe(150);
    const toolSpan = spans.find((span) => span.name === "acp.tool");
    expect(toolSpan?.attributes["acp.tool.raw_input"]).toBe(
      JSON.stringify({
        args: ["status"],
        command: "git",
        cwd: "/tmp/project",
      }),
    );
    expect(toolSpan?.attributes["acp.tool.raw_output"]).toBe(
      JSON.stringify({ ok: true }),
    );
    const logs = testLogExporter.getFinishedLogRecords();
    expect(logs.map((record) => record.eventName)).toEqual(
      expect.arrayContaining([
        "acp.turn.started",
        "acp.turn.thought",
        "acp.turn.output",
        "acp.tool.started",
        "acp.tool.completed",
        "acp.permission.requested",
        "acp.permission.resolved",
        "acp.turn.completed",
      ]),
    );
    expect(
      logs.find((record) => record.eventName === "acp.turn.started")?.body,
    ).toBe("hello");
    expect(
      logs.find((record) => record.eventName === "acp.turn.output")?.body,
    ).toBe("done");
  });

  it("applies observability redaction before writing captured content", async () => {
    const bridge = new AcpClientBridge();
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          await bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              content: {
                text: "sensitive output",
                type: "text",
              },
              sessionUpdate: "agent_message_chunk",
            },
          } satisfies SessionNotification);

          return {
            content: [{ text: "sensitive output", type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      observability: {
        captureContent: "full",
        redact: (_value, context) => `[redacted:${context.kind}]`,
      },
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    for await (const _event of driver.stream("sensitive prompt")) {
      // drain
    }

    const turnSpan = testSpanExporter
      .getFinishedSpans()
      .find((span) => span.name === "acp.turn");
    expect(turnSpan?.attributes["acp.prompt.content"]).toBe(
      "[redacted:prompt]",
    );
    expect(turnSpan?.attributes["acp.turn.output_text"]).toBe(
      "[redacted:assistant_output]",
    );
  });

  it("builds tool_call thread entries from ACP session updates", async () => {
    const bridge = new AcpClientBridge();
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      handlers: {
        terminal: {
          async kill() {},
          async output() {
            return {
              exitCode: 0,
              output: "tests passed",
              truncated: false,
            };
          },
          async release() {},
          async start() {
            return { terminalId: "term-1" };
          },
          async wait() {
            return { exitCode: 0 };
          },
        },
      },
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    await bridge.sessionUpdate({
      sessionId: "session-1",
      update: {
        content: [
          {
            newText: "hello",
            oldText: "",
            path: "/tmp/hello.md",
            type: "diff",
          },
        ],
        kind: "edit",
        locations: [
          {
            line: 3,
            path: "/tmp/hello.md",
          },
        ],
        rawInput: {
          args: ["test"],
          command: "npm",
          cwd: "/tmp/project",
          path: "/tmp/hello.md",
        },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Write hello.md",
        toolCallId: "tool-1",
      },
    } satisfies SessionNotification);

    await bridge.sessionUpdate({
      sessionId: "session-1",
      update: {
        content: [
          {
            terminalId: "term-1",
            type: "terminal",
          },
        ],
        rawOutput: { ok: true },
        sessionUpdate: "tool_call_update",
        status: "completed",
        toolCallId: "tool-1",
      },
    } satisfies SessionNotification);

    expect(driver.threadEntries()).toEqual([
      {
        content: [
          {
            command: "npm test",
            cwd: "/tmp/project",
            exitCode: 0,
            id: "terminal-1",
            kind: "terminal",
            output: "tests passed",
            status: "completed",
            terminalId: "term-1",
            truncated: false,
          },
        ],
        id: "tool-call-1",
        kind: "tool_call",
        locations: [
          {
            line: 3,
            path: "/tmp/hello.md",
          },
        ],
        rawInput: {
          args: ["test"],
          command: "npm",
          cwd: "/tmp/project",
          path: "/tmp/hello.md",
        },
        rawOutput: { ok: true },
        status: "completed",
        title: "Write hello.md",
        toolCallId: "tool-1",
        toolKind: "edit",
        turnId: expect.any(String),
      },
    ]);
  });

  it("updates terminal read models through refresh, kill, wait, and release", async () => {
    const bridge = new AcpClientBridge();
    let terminalState = {
      exitCode: null as number | null,
      output: "running\n",
      truncated: false,
    };

    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      handlers: {
        terminal: {
          async kill() {
            terminalState = {
              exitCode: null,
              output: "stop requested\n",
              truncated: false,
            };
          },
          async output() {
            return terminalState;
          },
          async release() {},
          async start() {
            return { terminalId: "term-1" };
          },
          async wait() {
            terminalState = {
              exitCode: 143,
              output: "stopped\n",
              truncated: false,
            };
            return { exitCode: 143 };
          },
        },
      },
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    await bridge.sessionUpdate({
      sessionId: "session-1",
      update: {
        content: [
          {
            terminalId: "term-1",
            type: "terminal",
          },
        ],
        kind: "execute",
        rawInput: {
          args: ["test"],
          command: "npm",
          cwd: "/tmp/project",
        },
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "Run tests",
        toolCallId: "tool-1",
      },
    } satisfies SessionNotification);

    const initial = driver.terminal("term-1");
    expect(initial).toEqual(
      expect.objectContaining({
        command: "npm test",
        cwd: "/tmp/project",
        exitCode: null,
        output: "running\n",
        outputLength: 8,
        outputLineCount: 2,
        status: "running",
        terminalId: "term-1",
        toolCallId: "tool-1",
      }),
    );

    terminalState = {
      exitCode: null,
      output: "still running\n",
      truncated: true,
    };
    const refreshed = await driver.refreshTerminal("term-1");
    expect(refreshed).toEqual(
      expect.objectContaining({
        output: "still running\n",
        outputLength: 14,
        outputLineCount: 2,
        revision: 2,
        status: "running",
        terminalId: "term-1",
        toolCallId: "tool-1",
        truncated: true,
      }),
    );
    expect(refreshed?.createdAt).toBe(initial?.createdAt);

    const killed = await driver.killTerminal("term-1");
    expect(killed).toEqual(
      expect.objectContaining({
        output: "stop requested\n",
        revision: 3,
        status: "running",
        terminalId: "term-1",
        toolCallId: "tool-1",
      }),
    );
    expect(killed?.stopRequestedAt).toBeDefined();
    expect(killed?.createdAt).toBe(initial?.createdAt);

    const waited = await driver.waitForTerminal("term-1");
    expect(waited).toEqual(
      expect.objectContaining({
        completedAt: expect.any(String),
        exitCode: 143,
        output: "stopped\n",
        revision: 4,
        status: "completed",
        terminalId: "term-1",
        toolCallId: "tool-1",
      }),
    );

    const released = await driver.releaseTerminal("term-1");
    expect(released).toEqual(
      expect.objectContaining({
        exitCode: 143,
        releasedAt: expect.any(String),
        revision: 5,
        status: "completed",
        terminalId: "term-1",
        toolCallId: "tool-1",
      }),
    );
  });

  it("queues overlapping turns and starts the next turn after the active one completes", async () => {
    const bridge = new AcpClientBridge();
    let promptCallCount = 0;
    const promptTexts: string[] = [];
    let resolveFirstPrompt: (() => void) | undefined;
    const firstPromptGate = new Promise<void>((resolve) => {
      resolveFirstPrompt = resolve;
    });

    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async (params) => {
          promptCallCount += 1;
          promptTexts.push(
            params.prompt
              .map((block) => ("text" in block ? block.text : block.type))
              .join(" "),
          );
          const currentPromptCall = promptCallCount;
          if (currentPromptCall === 1) {
            await firstPromptGate;
          }

          return {
            content: [{ text: `done-${currentPromptCall}`, type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const collectRemaining = async (
      iterator: AsyncIterator<import("../core/types.js").AcpRuntimeTurnEvent>,
    ) => {
      const events = [] as import("../core/types.js").AcpRuntimeTurnEvent[];
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return events;
        }
        events.push(next.value);
      }
    };

    const firstIterator = driver.stream("first")[Symbol.asyncIterator]();
    const firstQueued = await firstIterator.next();
    expect(firstQueued).toEqual({
      done: false,
      value: expect.objectContaining({
        position: 0,
        type: "queued",
      }),
    });
    const firstStarted = await firstIterator.next();
    expect(firstStarted).toEqual({
      done: false,
      value: expect.objectContaining({
        type: "started",
      }),
    });

    const secondIterator = driver.stream("second")[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    expect(secondQueued).toEqual({
      done: false,
      value: expect.objectContaining({
        position: 0,
        type: "queued",
      }),
    });

    const thirdIterator = driver.stream("third")[Symbol.asyncIterator]();
    const thirdQueued = await thirdIterator.next();
    expect(thirdQueued).toEqual({
      done: false,
      value: expect.objectContaining({
        position: 1,
        type: "queued",
      }),
    });

    resolveFirstPrompt?.();

    const [firstRemaining, secondRemaining, thirdRemaining] = await Promise.all([
      collectRemaining(firstIterator),
      collectRemaining(secondIterator),
      collectRemaining(thirdIterator),
    ]);

    expect(firstRemaining.map((event) => event.type)).toEqual(["completed"]);
    expect(secondRemaining.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(thirdRemaining.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(secondRemaining[0]?.turnId).toBe(secondQueued.value?.turnId);
    expect(thirdRemaining[0]?.turnId).toBe(thirdQueued.value?.turnId);
    expect(promptTexts).toEqual(["first", "second", "third"]);
    expect(promptCallCount).toBe(3);
  });

  it("coalesces ready queued turns when the session queue policy requests it", async () => {
    const bridge = new AcpClientBridge();
    let promptCallCount = 0;
    const promptTexts: string[] = [];
    let resolveFirstPrompt: (() => void) | undefined;
    const firstPromptGate = new Promise<void>((resolve) => {
      resolveFirstPrompt = resolve;
    });

    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async (params) => {
          promptCallCount += 1;
          promptTexts.push(
            params.prompt
              .map((block) => ("text" in block ? block.text : block.type))
              .join(" "),
          );
          if (promptCallCount === 1) {
            await firstPromptGate;
          }
          return {
            content: [{ text: `done-${promptCallCount}`, type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      queue: {
        delivery: "coalesce",
      },
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const collectRemaining = async (
      iterator: AsyncIterator<import("../core/types.js").AcpRuntimeTurnEvent>,
    ) => {
      const events = [] as import("../core/types.js").AcpRuntimeTurnEvent[];
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return events;
        }
        events.push(next.value);
      }
    };

    const firstIterator = driver.stream("first")[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    const secondIterator = driver.stream("second")[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    expect(secondQueued).toEqual({
      done: false,
      value: expect.objectContaining({ position: 0, type: "queued" }),
    });

    const thirdIterator = driver.stream("third")[Symbol.asyncIterator]();
    const thirdQueued = await thirdIterator.next();
    expect(thirdQueued).toEqual({
      done: false,
      value: expect.objectContaining({ position: 1, type: "queued" }),
    });

    resolveFirstPrompt?.();

    const [firstRemaining, secondRemaining, thirdRemaining] = await Promise.all([
      collectRemaining(firstIterator),
      collectRemaining(secondIterator),
      collectRemaining(thirdIterator),
    ]);

    expect(firstRemaining.map((event) => event.type)).toEqual(["completed"]);
    expect(secondRemaining.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(thirdRemaining.map((event) => event.type)).toEqual(["coalesced"]);
    expect(thirdRemaining[0]).toEqual(
      expect.objectContaining({
        intoTurnId: secondQueued.value?.turnId,
        turnId: thirdQueued.value?.turnId,
      }),
    );
    expect(promptTexts).toEqual(["first", "second\n\nthird"]);
    expect(promptCallCount).toBe(2);
  });

  it("withdraws queued turns before they are started", async () => {
    const bridge = new AcpClientBridge();
    let promptCallCount = 0;
    let resolveFirstPrompt: (() => void) | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          promptCallCount += 1;
          if (promptCallCount === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstPrompt = resolve;
            });
          }
          return {
            content: [{ text: `done-${promptCallCount}`, type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const firstIterator = driver.stream("first")[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    const secondIterator = driver.stream("second")[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    expect(secondQueued).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });

    expect(driver.queuedTurns()).toEqual([
      expect.objectContaining({
        position: 0,
        prompt: "second",
        turnId: secondQueued.value?.turnId,
      }),
    ]);
    expect(driver.queuedTurn(secondQueued.value!.turnId)).toEqual(
      expect.objectContaining({
        position: 0,
        prompt: "second",
        turnId: secondQueued.value?.turnId,
      }),
    );

    expect(driver.withdrawQueuedTurn(secondQueued.value!.turnId)).toBe(true);
    expect(await secondIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnWithdrawnError),
        turnId: secondQueued.value?.turnId,
        type: "withdrawn",
      }),
    });
    expect(await secondIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(driver.queuedTurns()).toEqual([]);

    resolveFirstPrompt?.();
    while (!(await firstIterator.next()).done) {
      // drain
    }
  });

  it("clears queued turns before they are started", async () => {
    const bridge = new AcpClientBridge();
    let promptCallCount = 0;
    let resolveFirstPrompt: (() => void) | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          promptCallCount += 1;
          if (promptCallCount === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstPrompt = resolve;
            });
          }
          return {
            content: [{ text: `done-${promptCallCount}`, type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const firstIterator = driver.stream("first")[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    const secondIterator = driver.stream("second")[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    const thirdIterator = driver.stream("third")[Symbol.asyncIterator]();
    const thirdQueued = await thirdIterator.next();

    expect(driver.queuedTurns()).toHaveLength(2);
    expect(driver.clearQueuedTurns()).toBe(2);
    expect(driver.queuedTurns()).toEqual([]);

    expect(await secondIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnWithdrawnError),
        turnId: secondQueued.value?.turnId,
        type: "withdrawn",
      }),
    });
    expect(await thirdIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnWithdrawnError),
        turnId: thirdQueued.value?.turnId,
        type: "withdrawn",
      }),
    });
    expect(await secondIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await thirdIterator.next()).toEqual({
      done: true,
      value: undefined,
    });

    resolveFirstPrompt?.();
    while (!(await firstIterator.next()).done) {
      // drain
    }
  });

  it("inserts a queued turn at the front when requested", async () => {
    const bridge = new AcpClientBridge();
    let promptCallCount = 0;
    let resolveFirstPrompt: (() => void) | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          promptCallCount += 1;
          if (promptCallCount === 1) {
            await new Promise<void>((resolve) => {
              resolveFirstPrompt = resolve;
            });
          }
          return {
            content: [{ text: `done-${promptCallCount}`, type: "text" }],
            stopReason: "end_turn",
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const collectRemaining = async (
      iterator: AsyncIterator<import("../core/types.js").AcpRuntimeTurnEvent>,
    ) => {
      const events = [] as import("../core/types.js").AcpRuntimeTurnEvent[];
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          return events;
        }
        events.push(next.value);
      }
    };

    const firstIterator = driver.stream("first")[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    const secondIterator = driver.stream("second")[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    expect(secondQueued).toEqual({
      done: false,
      value: expect.objectContaining({
        position: 0,
        type: "queued",
      }),
    });

    const thirdIterator = driver.stream("third")[Symbol.asyncIterator]();
    const thirdQueued = await thirdIterator.next();
    expect(thirdQueued).toEqual({
      done: false,
      value: expect.objectContaining({
        position: 1,
        type: "queued",
      }),
    });
    await expect(
      driver.sendQueuedTurnNow(thirdQueued.value!.turnId),
    ).resolves.toBe(true);
    expect(driver.queuedTurns()).toEqual([
      expect.objectContaining({
        prompt: "third",
        status: "ready",
        turnId: thirdQueued.value?.turnId,
      }),
      expect.objectContaining({
        prompt: "second",
        status: "ready",
        turnId: secondQueued.value?.turnId,
      }),
    ]);

    resolveFirstPrompt?.();

    const [firstRemaining, secondRemaining, thirdRemaining] = await Promise.all([
      collectRemaining(firstIterator),
      collectRemaining(secondIterator),
      collectRemaining(thirdIterator),
    ]);

    expect(firstRemaining.map((event) => event.type)).toEqual(["completed"]);
    expect(thirdRemaining.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(secondRemaining.map((event) => event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(driver.queuedTurns()).toEqual([]);
    expect(thirdRemaining[0]?.turnId).toBe(thirdQueued.value?.turnId);
    expect(secondRemaining[0]?.turnId).toBe(secondQueued.value?.turnId);
  });

  it("settles a running turn immediately when timeout elapses", async () => {
    const bridge = new AcpClientBridge();
    let cancelCount = 0;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {
          cancelCount += 1;
        },
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          await new Promise<never>(() => {});
          throw new Error("unreachable");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const turn = driver.startTurn("slow", { timeoutMs: 5 });
    const iterator = turn.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await iterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    expect(await iterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnTimeoutError),
        type: "failed",
      }),
    });
    await expect(turn.completion).rejects.toBeInstanceOf(AcpTurnTimeoutError);
    expect(cancelCount).toBeGreaterThanOrEqual(1);
    expect(await iterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("settles active and queued turns when the session closes", async () => {
    const bridge = new AcpClientBridge();
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          await new Promise<never>(() => {});
          throw new Error("unreachable");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const firstTurn = driver.startTurn("first");
    const firstIterator = firstTurn.events[Symbol.asyncIterator]();
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });
    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({ type: "started" }),
    });

    const secondTurn = driver.startTurn("second");
    const secondIterator = secondTurn.events[Symbol.asyncIterator]();
    const secondQueued = await secondIterator.next();
    expect(secondQueued).toEqual({
      done: false,
      value: expect.objectContaining({ type: "queued" }),
    });

    await driver.close();

    expect(await firstIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnCancelledError),
        type: "cancelled",
      }),
    });
    expect(await secondIterator.next()).toEqual({
      done: false,
      value: expect.objectContaining({
        error: expect.any(AcpTurnWithdrawnError),
        turnId: secondQueued.value?.turnId,
        type: "withdrawn",
      }),
    });
    await expect(firstTurn.completion).rejects.toBeInstanceOf(
      AcpTurnCancelledError,
    );
    await expect(secondTurn.completion).rejects.toBeInstanceOf(
      AcpTurnWithdrawnError,
    );
    expect(await firstIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await secondIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("does not resolve permissions into a turn after it already timed out", async () => {
    const bridge = new AcpClientBridge();
    let resolvePermission: (() => void) | undefined;
    let permissionOutcome: string | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          void bridge
            .requestPermission({
              options: [{ kind: "allow_once", optionId: "allow" }],
              toolCall: {
                content: [],
                kind: "execute",
                title: "Slow permission",
              },
            } as never)
            .then((result) => {
              permissionOutcome = result.outcome.outcome;
            });
          await new Promise<never>(() => {});
          throw new Error("unreachable");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      handlers: {
        permission: async () => {
          await new Promise<void>((resolve) => {
            resolvePermission = resolve;
          });
          return {
            decision: "allow",
            scope: "once",
          };
        },
      },
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const turn = driver.startTurn("needs permission", { timeoutMs: 5 });
    const events: import("../core/types.js").AcpRuntimeTurnEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    await expect(turn.completion).rejects.toBeInstanceOf(AcpTurnTimeoutError);
    resolvePermission?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.map((event) => event.type)).toEqual([
      "queued",
      "started",
      "operation_updated",
      "permission_requested",
      "failed",
    ]);
    expect(permissionOutcome).toBe("cancelled");
    expect(driver.permissionRequests()[0]?.phase).toBe("pending");
  });

  it("drops async tool-call updates that finish after the owning turn timed out", async () => {
    const bridge = new AcpClientBridge();
    let resolveOutput:
      | ((value: { exitCode: number | null; output: string; truncated: boolean }) => void)
      | undefined;
    let updatePromise: Promise<void> | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          updatePromise = bridge.sessionUpdate({
            sessionId: "session-1",
            update: {
              content: [{ terminalId: "term-1", type: "terminal" }],
              kind: "execute",
              rawInput: {
                args: ["hi"],
                command: "echo",
                cwd: "/tmp/project",
              },
              sessionUpdate: "tool_call",
              status: "in_progress",
              title: "Run command",
              toolCallId: "tool-1",
            },
          } as never);
          void updatePromise.catch(() => undefined);
          await new Promise<never>(() => {});
          throw new Error("unreachable");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      handlers: {
        terminal: {
          kill: async () => {},
          output: async () =>
            await new Promise((resolve) => {
              resolveOutput = resolve;
            }),
          release: async () => {},
          start: async () => ({ terminalId: "term-1" }),
          wait: async () => ({ exitCode: 0 }),
        },
      },
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const turn = driver.startTurn("slow tool", { timeoutMs: 5 });
    const events: import("../core/types.js").AcpRuntimeTurnEvent[] = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    await expect(turn.completion).rejects.toBeInstanceOf(AcpTurnTimeoutError);
    resolveOutput?.({ exitCode: 0, output: "hi\n", truncated: false });
    await updatePromise;

    expect(events.map((event) => event.type)).toEqual([
      "queued",
      "started",
      "failed",
    ]);
    expect(driver.toolCall("tool-1")).toBeUndefined();
    expect(driver.terminals()).toEqual([]);
  });

  it("normalizes Gemini abort internal errors into cancelled turns", async () => {
    const bridge = new AcpClientBridge();
    let rejectPrompt: ((error: unknown) => void) | undefined;
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        args: ["--acp"],
        command: "gemini",
        type: "gemini",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => {
          await new Promise<never>((_, reject) => {
            rejectPrompt = reject;
          });
          throw new Error("unreachable");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        args: ["--acp"],
        command: "gemini",
        type: "gemini",
      }),
      response: {
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    const events: unknown[] = [];
    const turn = driver.startTurn("hello");
    const iterator = turn.events[Symbol.asyncIterator]();
    events.push((await iterator.next()).value);
    await driver.cancelTurn(turn.turnId);
    rejectPrompt?.({
      code: -32603,
      data: {
        details: "This operation was aborted",
      },
      message: "Internal error",
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push(next.value);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        error: expect.any(AcpTurnCancelledError),
        type: "cancelled",
      }),
    );
  });

  it("normalizes config values and replaces config options from agent responses", async () => {
    const bridge = new AcpClientBridge();
    const configCalls: unknown[] = [];
    const baseConfigOptions = [
      {
        category: "model",
        currentValue: "gpt-5.5",
        id: "model",
        name: "Model",
        options: [
          {
            name: "GPT-5.5",
            value: "gpt-5.5",
          },
          {
            name: "gpt-5.4",
            value: "gpt-5.4",
          },
        ],
        type: "select",
      },
      {
        category: "thought_level",
        currentValue: "medium",
        id: "reasoning_effort",
        name: "Reasoning Effort",
        options: [
          {
            name: "Medium",
            value: "medium",
          },
          {
            name: "High",
            value: "high",
          },
        ],
        type: "select",
      },
    ];
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => ({
          stopReason: "end_turn",
        }) as never,
        setSessionConfigOption: async (params) => {
          configCalls.push(params);
          return {
            configOptions:
              params.configId === "model"
                ? [
                    {
                      ...baseConfigOptions[0],
                      currentValue: params.value,
                    },
                  ]
                : [
                    baseConfigOptions[0],
                    {
                      ...baseConfigOptions[1],
                      currentValue: params.value,
                    },
                  ],
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        configOptions: baseConfigOptions,
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    await driver.setAgentConfigOption("model", "GPT-5.5");

    expect(configCalls[0]).toMatchObject({
      configId: "model",
      sessionId: "session-1",
      value: "gpt-5.5",
    });
    expect(driver.metadata.config).toEqual({
      model: "gpt-5.5",
    });
    expect(driver.listAgentConfigOptions().map((option) => option.id)).toEqual([
      "model",
    ]);

    await expect(
      driver.setAgentConfigOption("model", "gpt-5.5-medium"),
    ).rejects.toBeInstanceOf(AcpProtocolError);
    expect(configCalls).toHaveLength(1);
  });

  it("allows unique config category aliases", async () => {
    const bridge = new AcpClientBridge();
    const configCalls: unknown[] = [];
    const configOptions = [
      {
        category: "thought_level",
        currentValue: "medium",
        id: "reasoning_effort",
        name: "Reasoning Effort",
        options: [
          {
            name: "Medium",
            value: "medium",
          },
          {
            name: "High",
            value: "high",
          },
        ],
        type: "select",
      },
    ];
    const driver = new AcpSdkSessionDriver(bridge, {
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      connection: {
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () => {
          throw new Error("not used");
        },
        newSession: async () => {
          throw new Error("not used");
        },
        prompt: async () => ({
          stopReason: "end_turn",
        }) as never,
        setSessionConfigOption: async (params) => {
          configCalls.push(params);
          return {
            configOptions: [
              {
                ...configOptions[0],
                currentValue: params.value,
              },
            ],
          } as never;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
      cwd: "/tmp/project",
      dispose: async () => {},
      initializeResponse: {
        agentCapabilities: {},
        authMethods: [],
        protocolVersion: "0.2.0",
      } as InitializeResponse,
      mcpServers: [],
      profile: resolveAcpAgentProfile({
        command: "mock-agent",
        type: "mock-agent",
      }),
      response: {
        configOptions,
        sessionId: "session-1",
      } as never,
      sessionId: "session-1",
    });

    await driver.setAgentConfigOption("thought_level", "High");

    expect(configCalls).toEqual([
      expect.objectContaining({
        configId: "reasoning_effort",
        value: "high",
      }),
    ]);
    expect(driver.metadata.config).toEqual({
      reasoning_effort: "high",
    });
  });
});
