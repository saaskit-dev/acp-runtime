import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runHarnessCase } from "./run-case.js";

describe("runHarnessCase", () => {
  it("writes transcript, summary, and notes", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        version: 1,
        id: "claude",
        displayName: "Claude ACP Adapter",
        transport: "stdio",
        launch: {
          command: "claude",
          args: ["--acp"],
        },
        auth: {
          mode: "optional",
        },
      },
      testCase: {
        version: 1,
        id: "protocol.initialize",
        kind: "protocol",
        title: "Initialize",
        description: "Verify initialize handshake",
        protocolDependencies: ["initialize"],
        steps: [{ type: "initialize" }],
        assertions: [{ type: "transcript-has-method", method: "initialize" }],
      },
      outputDir,
      executor: async ({ emitRuntimeEvent, emitWireEntry }) => {
        emitRuntimeEvent({
          type: "step-started",
          caseId: "protocol.initialize",
          agentId: "claude",
          stepType: "initialize",
        });
        emitWireEntry({
          direction: "outbound",
          type: "request",
          method: "initialize",
          payload: { protocolVersion: "0.1" },
        });

        return {
          status: "passed",
          summaryPatch: {
            protocolCoverage: {
              initialize: {
                status: "PASS",
                advertised: true,
                caseId: "protocol.initialize",
                notes: [],
              },
            },
          },
          notes: ["executor completed"],
        };
      },
    });

    expect(result.status).toBe("passed");

    const transcript = await readFile(join(outputDir, "transcript.jsonl"), "utf8");
    const summary = await readFile(join(outputDir, "summary.json"), "utf8");
    const notes = await readFile(join(outputDir, "notes.md"), "utf8");

    expect(transcript).toContain("\"method\":\"initialize\"");
    expect(summary).toContain("\"protocolCoverage\"");
    expect(notes).toContain("executor completed");
  });

  it("classifies assertion-only misses as not-observed when the case requests it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        version: 1,
        id: "opencode",
        displayName: "OpenCode ACP Adapter",
        transport: "stdio",
        launch: {
          command: "opencode",
          args: ["acp"],
        },
        auth: {
          mode: "optional",
        },
      },
      testCase: {
        version: 1,
        id: "protocol.plan-update",
        kind: "protocol",
        title: "Plan Update",
        description: "Observe plan updates when available",
        protocolDependencies: ["session/update"],
        classification: {
          assertionFailureStatus: "not-observed",
        },
        steps: [],
        assertions: [{ type: "transcript-has-event", eventType: "plan" }],
      },
      outputDir,
      executor: async () => ({
        status: "passed",
        summaryPatch: {},
        notes: [],
      }),
    });

    expect(result.status).toBe("not-observed");

    const summary = await readFile(join(outputDir, "summary.json"), "utf8");
    expect(summary).toContain('"status": "NOT_OBSERVED"');
  });
});
