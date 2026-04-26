import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { describe, expect, it } from "vitest";

import { configureDemoLogSink } from "./runtime-demo-log-sink.js";

describe("runtime demo log sink", () => {
  it("writes raw jsonl as OTel-shaped log records", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-demo-log-"));
    const logFile = join(root, "runtime.log");

    try {
      const sink = await configureDemoLogSink(logFile);
      sink.writeLine("\u001b[33mrendered timeline line\u001b[0m");
      sink.emit({
        attributes: {
          "acp.turn.id": "turn-1",
          "acp.tool.kind": "read_file",
        },
        body: {
          preview: "package.json",
        },
        eventName: "acp.demo.tool.completed",
        severityNumber: SeverityNumber.WARN,
      });
      await sink.attachSession("session-1");
      await sink.close();

      expect(sink.sessionLogFile).toBe(join(root, "sessions", "session-1", "runtime.log"));
      expect(sink.sessionRawLogFile).toBe(
        join(root, "sessions", "session-1", "runtime.log.jsonl"),
      );
      expect((await stat(sink.sessionLogFile ?? "")).isFile()).toBe(true);
      expect((await stat(sink.sessionRawLogFile ?? "")).isFile()).toBe(true);

      await expect(readFile(logFile, "utf8")).resolves.toContain(
        "rendered timeline line",
      );
      await expect(readFile(logFile, "utf8")).resolves.not.toContain("\u001b");
      await expect(readFile(sink.sessionLogFile ?? "", "utf8")).resolves.toContain(
        "rendered timeline line",
      );
      await expect(readFile(sink.sessionRawLogFile ?? "", "utf8")).resolves.toContain(
        "acp.demo.tool.completed",
      );

      const raw = await readFile(`${logFile}.jsonl`, "utf8");
      const lines = raw.trim().split("\n");

      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;

      expect(record.recordType).toBeUndefined();
      expect(record.eventName).toBe("acp.demo.tool.completed");
      expect(record.severityNumber).toBe(SeverityNumber.WARN);
      expect(record.severityText).toBe("WARN");
      expect(record.body).toEqual({
        preview: "package.json",
      });
      expect(record.attributes).toMatchObject({
        "acp.tool.kind": "read_file",
        "acp.turn.id": "turn-1",
      });
      expect(record.instrumentationScope).toMatchObject({
        name: "@saaskit-dev/acp-runtime/demo",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("defaults demo log events to INFO severity", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-runtime-demo-log-"));
    const logFile = join(root, "custom.log");

    try {
      const sink = await configureDemoLogSink(logFile);
      sink.emit({
        eventName: "acp.demo.local_command",
        body: "command executed",
      });
      await sink.close();

      const raw = await readFile(`${logFile}.jsonl`, "utf8");
      const record = JSON.parse(raw.trim()) as Record<string, unknown>;

      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.severityText).toBe("INFO");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
