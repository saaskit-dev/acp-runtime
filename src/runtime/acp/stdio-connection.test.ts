import { Readable, Writable } from "node:stream";

import { beforeEach, describe, expect, it } from "vitest";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import {
  formatUnexpectedStdioExitError,
  emitAcpProtocolMessageLog,
  nodeReadableToWeb,
  nodeWritableToWeb,
  normalizeInboundAcpMessage,
} from "./stdio-connection.js";
import { testLogExporter } from "../test-otel.js";

beforeEach(() => {
  testLogExporter.reset();
});

describe("stdio ACP protocol logging", () => {
  it("emits raw ACP JSON-RPC messages into runtime logs", () => {
    emitAcpProtocolMessageLog({
      agent: {
        command: "codex-acp",
        type: "codex-acp",
      },
      cwd: "/tmp/project",
      direction: "outbound",
      message: {
        id: 7,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [
            {
              content: "hello",
              role: "user",
            },
          ],
          sessionId: "session-1",
        },
      } as AnyMessage,
    });

    const records = testLogExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.eventName).toBe("acp.protocol.message");
    expect(records[0]?.attributes).toMatchObject({
      "acp.agent.command": "codex-acp",
      "acp.agent.type": "codex-acp",
      "acp.protocol.direction": "outbound",
      "acp.protocol.has_error": false,
      "acp.protocol.id": 7,
      "acp.protocol.method": "session/prompt",
      "acp.protocol.transport": "stdio",
      "acp.session.cwd": "/tmp/project",
      "acp.session.id": "session-1",
    });
    expect(JSON.parse(records[0]?.body as string)).toMatchObject({
      method: "session/prompt",
      params: {
        sessionId: "session-1",
      },
    });
  });

  it("keeps protocol metadata when content capture is disabled", () => {
    emitAcpProtocolMessageLog({
      agent: {
        command: "codex-acp",
        type: "codex-acp",
      },
      cwd: "/tmp/project",
      direction: "inbound",
      message: {
        error: {
          code: -32602,
          message: "Invalid params",
        },
        id: 8,
        jsonrpc: "2.0",
      } as AnyMessage,
      observability: {
        captureContent: "none",
      },
    });

    const records = testLogExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBeUndefined();
    expect(records[0]?.severityText).toBe("WARN");
    expect(records[0]?.attributes).toMatchObject({
      "acp.protocol.direction": "inbound",
      "acp.protocol.has_error": true,
      "acp.protocol.id": 8,
    });
  });
});

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

describe("stdio process exit diagnostics", () => {
  it("includes lifecycle context in unexpected exit errors", () => {
    const error = formatUnexpectedStdioExitError({
      activeOperationSummary: "initialize",
      code: 1,
      command: "claude-agent-acp",
      cwd: "/tmp/project",
      pid: 4242,
      signal: null,
      stderr: "boot failed",
    });

    expect(error.message).toContain("ACP stdio process exited unexpectedly");
    expect(error.message).toContain("during initialize");
    expect(error.message).toContain('command="claude-agent-acp"');
    expect(error.message).toContain("cwd=/tmp/project");
    expect(error.message).toContain("pid=4242");
    expect(error.message).toContain("code=1");
    expect(error.message).toContain("signal=null");
    expect(error.message).toContain('stderr="boot failed"');
  });

  it("reports idle exits without stderr", () => {
    const error = formatUnexpectedStdioExitError({
      code: null,
      command: "codex-acp",
      cwd: "/tmp/project",
      signal: "SIGTERM",
    });

    expect(error.message).toContain("while idle");
    expect(error.message).toContain('command="codex-acp"');
    expect(error.message).toContain("code=null");
    expect(error.message).toContain("signal=SIGTERM");
    expect(error.message).not.toContain("stderr=");
  });
});
