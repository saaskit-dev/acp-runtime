import { describe, expect, it } from "vitest";

import "../test-otel.js";
import { createAcpSessionService } from "./session-service.js";
import { withSpan } from "../observability/tracing.js";

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
});
