import { describe, expect, it } from "vitest";
import type { InitializeResponse, SessionNotification } from "@agentclientprotocol/sdk";

import { AcpClientBridge } from "./authority-bridge.js";
import { AcpSdkSessionDriver } from "./driver.js";
import { AcpTurnCancelledError } from "../core/errors.js";
import { resolveAcpAgentProfile } from "./profiles/index.js";

describe("AcpSdkSessionDriver thread-first model", () => {
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

  it("normalizes Gemini abort internal errors into cancelled turns", async () => {
    const bridge = new AcpClientBridge();
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
          throw {
            code: -32603,
            data: {
              details: "This operation was aborted",
            },
            message: "Internal error",
          };
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

    const controller = new AbortController();
    controller.abort();

    const events: unknown[] = [];
    for await (const event of driver.stream("hello", {
      signal: controller.signal,
    })) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        error: expect.any(AcpTurnCancelledError),
        type: "failed",
      }),
    );
  });
});
