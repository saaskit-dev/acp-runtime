import { Readable, Writable } from "node:stream";

import { beforeEach, describe, expect, it } from "vitest";

import type { AnyMessage } from "@agentclientprotocol/sdk";

import {
  emitStdioProcessLifecycleLog,
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

  it("reports writes after the node writable has ended as closed ACP connections", async () => {
    const writable = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const stream = nodeWritableToWeb(writable, { preferNative: false });
    const writer = stream.getWriter();

    await new Promise<void>((resolve) => writable.end(resolve));

    await expect(
      writer.write(new TextEncoder().encode("late")),
    ).rejects.toThrow("ACP connection closed");
  });

  it("suppresses closed writable error events while rejecting the pending write", async () => {
    const closedError = Object.assign(new Error("write after end"), {
      code: "ERR_STREAM_WRITE_AFTER_END",
    });
    let writable!: Writable;
    writable = new Writable({
      write(_chunk, _encoding, callback) {
        writable.emit("error", closedError);
        callback(closedError);
      },
    });
    const stream = nodeWritableToWeb(writable, { preferNative: false });
    const writer = stream.getWriter();

    await expect(
      writer.write(new TextEncoder().encode("late")),
    ).rejects.toThrow("ACP connection closed");
  });
});

describe("stdio process exit diagnostics", () => {
  it("emits process lifecycle logs with pid, operation, and memory context", () => {
    emitStdioProcessLifecycleLog({
      agent: {
        args: ["--stdio"],
        command: "codex-acp",
        env: {
          CODEX_HOME: "/tmp/codex",
          SECRET_VALUE: "redacted-value",
        },
        type: "codex-acp",
      },
      body: "ACP stdio process exited unexpectedly.",
      cwd: "/tmp/project",
      eventName: "acp.stdio.process.exit.unexpected",
      exitClassification: "external_sigkill_or_os_oom",
      exitCode: null,
      exitKillCalled: false,
      exitSignal: "SIGKILL",
      operationSummary: "prompt",
      pid: 4242,
      severityNumber: 17,
      startedAt: Date.now() - 1_000,
      stderrTail: "last stderr line",
    });

    const records = testLogExporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.eventName).toBe("acp.stdio.process.exit.unexpected");
    expect(records[0]?.severityText).toBe("ERROR");
    expect(records[0]?.attributes).toMatchObject({
      "acp.agent.args.count": 1,
      "acp.agent.command": "codex-acp",
      "acp.agent.env.keys": "CODEX_HOME,SECRET_VALUE",
      "acp.agent.type": "codex-acp",
      "acp.process.exit.classification": "external_sigkill_or_os_oom",
      "acp.process.exit.kill_called": false,
      "acp.process.exit.signal": "SIGKILL",
      "acp.process.operation.active": "prompt",
      "acp.process.pid": 4242,
      "acp.process.stderr.tail": "last stderr line",
      "acp.session.cwd": "/tmp/project",
    });
    expect(
      records[0]?.attributes?.["acp.process.uptime_ms"],
    ).toBeGreaterThanOrEqual(0);
    expect(
      records[0]?.attributes?.["acp.runtime.memory.rss_bytes"],
    ).toBeGreaterThan(0);
  });

  it("includes lifecycle context in unexpected exit errors", () => {
    const error = formatUnexpectedStdioExitError({
      activeOperationSummary: "initialize",
      code: 1,
      command: "claude-agent-acp",
      cwd: "/tmp/project",
      exitClassification: "unexpected_exit",
      killCalled: false,
      pid: 4242,
      signal: null,
      stderr: "boot failed",
      uptimeMs: 1234,
    });

    expect(error.message).toContain("ACP stdio process exited unexpectedly");
    expect(error.message).toContain("during initialize");
    expect(error.message).toContain('command="claude-agent-acp"');
    expect(error.message).toContain("cwd=/tmp/project");
    expect(error.message).toContain("pid=4242");
    expect(error.message).toContain("code=1");
    expect(error.message).toContain("signal=null");
    expect(error.message).toContain("killCalled=false");
    expect(error.message).toContain("classification=unexpected_exit");
    expect(error.message).toContain("uptimeMs=1234");
    expect(error.message).toContain('stderr="boot failed"');
  });

  it("classifies external SIGKILL exits in diagnostics", () => {
    const error = formatUnexpectedStdioExitError({
      activeOperationSummary: "prompt",
      code: null,
      command: "codex-acp",
      cwd: "/tmp/project",
      exitClassification: "external_sigkill_or_os_oom",
      killCalled: false,
      signal: "SIGKILL",
    });

    expect(error.message).toContain("during prompt");
    expect(error.message).toContain("signal=SIGKILL");
    expect(error.message).toContain("killCalled=false");
    expect(error.message).toContain(
      "classification=external_sigkill_or_os_oom",
    );
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
