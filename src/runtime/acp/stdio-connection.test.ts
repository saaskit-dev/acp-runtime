import { describe, expect, it } from "vitest";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import { normalizeInboundAcpMessage } from "./stdio-connection.js";

describe("stdio ACP inbound normalization", () => {
  it("rewrites Claude Code usage_update messages with used=null", () => {
    const message = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: null,
          size: 200000,
          cost: {
            amount: 0.01,
            currency: "USD",
          },
        },
      },
    } as AnyMessage;

    expect(normalizeInboundAcpMessage(message)).toEqual({
      ...message,
      params: {
        ...message.params,
        update: {
          ...message.params.update,
          used: 0,
        },
      },
    });
  });

  it("leaves non-usage updates unchanged", () => {
    const message = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "session_info_update",
          title: "Example",
        },
      },
    } as AnyMessage;

    expect(normalizeInboundAcpMessage(message)).toBe(message);
  });

  it("leaves usage_update messages with numeric used unchanged", () => {
    const message = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 42,
          size: 200000,
        },
      },
    } as AnyMessage;

    expect(normalizeInboundAcpMessage(message)).toBe(message);
  });
});
