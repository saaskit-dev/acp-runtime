import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import {
  nodeReadableToWeb,
  nodeWritableToWeb,
  normalizeInboundAcpMessage,
} from "./stdio-connection.js";

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

describe("stdio stream bridges", () => {
  it("bridges node readable streams without native adapters", async () => {
    const readable = nodeReadableToWeb(Readable.from(["hello\n"]), {
      preferNative: false,
    });
    const reader = readable.getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("hello\n");

    const second = await reader.read();
    expect(second.done).toBe(true);
  });

  it("bridges node writable streams without native adapters", async () => {
    const chunks: Uint8Array[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(
          chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
        );
        callback();
      },
    });

    const stream = nodeWritableToWeb(writable, { preferNative: false });
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode("ping"));
    await writer.close();

    expect(new TextDecoder().decode(chunks[0])).toBe("ping");
    expect(writable.writableEnded).toBe(true);
  });
});
