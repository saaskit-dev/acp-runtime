import { describe, expect, it } from "vitest";

import "../test-otel.js";
import { createAcpSessionService } from "./session-service.js";
import { withSpan } from "../observability/tracing.js";
import { AcpSystemPromptError } from "../core/errors.js";

describe("AcpSessionService observability", () => {
  it("injects trace metadata into initialize and newSession requests", async () => {
    let initializeParams:
      | import("@agentclientprotocol/sdk").InitializeRequest
      | undefined;
    let newSessionParams:
      | import("@agentclientprotocol/sdk").NewSessionRequest
      | undefined;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {},
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async (params) => {
          initializeParams = params;
          return {
            agentCapabilities: {},
            authMethods: [],
            protocolVersion: "0.2.0",
          } as import("@agentclientprotocol/sdk").InitializeResponse;
        },
        newSession: async (params) => {
          newSessionParams = params;
          return {
            sessionId: "session-1",
          } as import("@agentclientprotocol/sdk").NewSessionResponse;
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    await withSpan(
      "test.parent",
      { attributes: { "test.kind": "session-service" } },
      async (_span, spanContext) => {
        const driver = await service.create({
          agent: {
            command: "mock-agent",
            type: "mock-agent",
          },
          cwd: "/tmp/project",
          _traceContext: spanContext,
        } as import("../core/types.js").AcpRuntimeCreateOptions);
        await driver.close();
      },
    );

    expect(initializeParams?._meta?.traceparent).toMatch(/^00-/);
    expect(newSessionParams?._meta?.traceparent).toMatch(/^00-/);
  });

  it("injects Claude systemPrompt into session metadata", async () => {
    let newSessionParams:
      | import("@agentclientprotocol/sdk").NewSessionRequest
      | undefined;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {},
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: {},
            authMethods: [],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        newSession: async (params) => {
          newSessionParams = params;
          return {
            sessionId: "session-1",
          } as import("@agentclientprotocol/sdk").NewSessionResponse;
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.create({
      agent: {
        command: "claude-agent-acp",
        type: "claude-acp",
      },
      cwd: "/tmp/project",
      systemPrompt: "You are terse.",
    });
    await driver.close();

    expect(newSessionParams?._meta?.systemPrompt).toBe("You are terse.");
  });

  it("maps Codex systemPrompt to launch config", async () => {
    let launchedAgent:
      | import("../core/types.js").AcpRuntimeAgent
      | undefined;

    const service = createAcpSessionService(async (input) => {
      launchedAgent = input.agent;
      return {
        connection: {
          authenticate: async () => {},
          cancel: async () => {},
          closeSession: async () => ({}),
          initialize: async () =>
            ({
              agentCapabilities: {},
              authMethods: [],
              protocolVersion: "0.2.0",
            }) as import("@agentclientprotocol/sdk").InitializeResponse,
          newSession: async () =>
            ({
              sessionId: "session-1",
            }) as import("@agentclientprotocol/sdk").NewSessionResponse,
          prompt: async () => {
            throw new Error("not used");
          },
          signal: new AbortController().signal,
          closed: Promise.resolve(),
        },
      };
    });

    const driver = await service.create({
      agent: {
        args: ["--existing"],
        command: "codex-acp",
        type: "codex-acp",
      },
      cwd: "/tmp/project",
      systemPrompt: "You are an awaiter.",
    });
    await driver.close();

    expect(launchedAgent?.args).toEqual([
      "--existing",
      "-c",
      'developer_instructions="You are an awaiter."',
    ]);
  });

  it("rejects systemPrompt for unsupported agents", async () => {
    const service = createAcpSessionService(async () => {
      throw new Error("should not launch");
    });

    await expect(
      service.create({
        agent: {
          command: "unknown-agent",
          type: "unknown-agent",
        },
        cwd: "/tmp/project",
        systemPrompt: "custom",
      }),
    ).rejects.toBeInstanceOf(AcpSystemPromptError);
  });

  it("skips authenticate when an agent reports authentication is not implemented", async () => {
    let authenticateCalls = 0;
    let newSessionCalls = 0;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {
          authenticateCalls += 1;
          const error = new Error("Internal error") as Error & {
            data?: unknown;
          };
          error.name = "RequestError";
          error.data = { details: "Authentication not implemented" };
          throw error;
        },
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: {},
            authMethods: [
              {
                id: "agent-login",
                name: "Agent Login",
              },
            ],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        newSession: async () => {
          newSessionCalls += 1;
          return {
            sessionId: "session-1",
          } as import("@agentclientprotocol/sdk").NewSessionResponse;
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.create({
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      cwd: "/tmp/project",
      handlers: {
        authentication: async ({ methods }) => ({
          methodId: methods[0]?.id ?? "agent-login",
        }),
      },
    });
    await driver.close();

    expect(authenticateCalls).toBe(1);
    expect(newSessionCalls).toBe(1);
  });

  it("automatically authenticates protocol-only agent methods without a host auth handler", async () => {
    const authenticateMethodIds: string[] = [];

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async (input) => {
          authenticateMethodIds.push(input.methodId);
          return {};
        },
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: {},
            authMethods: [
              {
                id: "agent-login",
                name: "Agent Login",
              },
            ],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        newSession: async () =>
          ({
            sessionId: "session-1",
          }) as import("@agentclientprotocol/sdk").NewSessionResponse,
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.create({
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      cwd: "/tmp/project",
    });
    await driver.close();

    expect(authenticateMethodIds).toEqual(["agent-login"]);
  });

  it("does not automatically run terminal authentication without a host auth handler", async () => {
    let authenticateCalls = 0;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {
          authenticateCalls += 1;
          return {};
        },
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: {},
            authMethods: [
              {
                args: ["login"],
                id: "terminal-login",
                name: "Terminal Login",
                type: "terminal",
              },
            ],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        newSession: async () =>
          ({
            sessionId: "session-1",
          }) as import("@agentclientprotocol/sdk").NewSessionResponse,
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.create({
      agent: {
        command: "mock-agent",
        type: "mock-agent",
      },
      cwd: "/tmp/project",
    });
    await driver.close();

    expect(authenticateCalls).toBe(0);
  });

  it("ignores systemPrompt on load and does not send session metadata", async () => {
    let loadSessionParams:
      | import("@agentclientprotocol/sdk").LoadSessionRequest
      | undefined;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {},
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: { loadSession: true },
            authMethods: [],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        loadSession: async (params) => {
          loadSessionParams = params;
          return {
            sessionId: "session-1",
          } as import("@agentclientprotocol/sdk").LoadSessionResponse;
        },
        prompt: async () => {
          throw new Error("not used");
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.load({
      agent: {
        command: "claude-agent-acp",
        type: "claude-acp",
      },
      cwd: "/tmp/project",
      sessionId: "session-1",
      systemPrompt: "ignored",
    } as Parameters<typeof service.load>[0] & { systemPrompt: string });
    await driver.close();

    expect(loadSessionParams?._meta?.systemPrompt).toBeUndefined();
  });

  it("ignores systemPrompt on resume and does not send session metadata", async () => {
    let resumeSessionParams:
      | import("@agentclientprotocol/sdk").ResumeSessionRequest
      | undefined;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {},
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: { loadSession: true },
            authMethods: [],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        prompt: async () => {
          throw new Error("not used");
        },
        resumeSession: async (params) => {
          resumeSessionParams = params;
          return {
            sessionId: "session-1",
          } as import("@agentclientprotocol/sdk").ResumeSessionResponse;
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.resume({
      snapshot: {
        agent: {
          command: "claude-agent-acp",
          type: "claude-acp",
        },
        cwd: "/tmp/project",
        session: { id: "session-1" },
        version: 1,
      },
      systemPrompt: "ignored",
    } as Parameters<typeof service.resume>[0] & { systemPrompt: string });
    await driver.close();

    expect(resumeSessionParams?._meta?.systemPrompt).toBeUndefined();
  });

  it("does not replay snapshot mode or config after resume", async () => {
    let setModeCalls = 0;
    let setConfigCalls = 0;

    const service = createAcpSessionService(async () => ({
      connection: {
        authenticate: async () => {},
        cancel: async () => {},
        closeSession: async () => ({}),
        initialize: async () =>
          ({
            agentCapabilities: { loadSession: true },
            authMethods: [],
            protocolVersion: "0.2.0",
          }) as import("@agentclientprotocol/sdk").InitializeResponse,
        prompt: async () => {
          throw new Error("not used");
        },
        resumeSession: async () =>
          ({
            sessionId: "session-1",
          }) as import("@agentclientprotocol/sdk").ResumeSessionResponse,
        setSessionConfigOption: async () => {
          setConfigCalls += 1;
          return {};
        },
        setSessionMode: async () => {
          setModeCalls += 1;
          return {};
        },
        signal: new AbortController().signal,
        closed: Promise.resolve(),
      },
    }));

    const driver = await service.resume({
      snapshot: {
        agent: {
          command: "mock-agent",
          type: "mock-agent",
        },
        config: {
          model: "opus",
        },
        currentModeId: "plan",
        cwd: "/tmp/project",
        session: { id: "session-1" },
        version: 1,
      },
    });
    await driver.close();

    expect(setModeCalls).toBe(0);
    expect(setConfigCalls).toBe(0);
  });
});
