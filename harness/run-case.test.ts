import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { caseAppliesToAgent, runHarnessCase } from "./run-case.js";

describe("runHarnessCase", () => {
  it("writes transcript to <caseId>.jsonl", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "claude",
        displayName: "Claude ACP Adapter",
      },
      testCase: {
        version: 1,
        id: "protocol.initialize",
        kind: "protocol",
        title: "Initialize",
        protocolDependencies: ["initialize"],
        steps: [{ type: "initialize" }],
        assertions: [{ type: "transcript-has-method", method: "initialize" }],
      },
      outputDir,
      executor: async ({ emitRuntimeEvent, emitWireEntry }) => {
        emitRuntimeEvent({
          type: "step-started",
          caseId: "protocol.initialize",
          agentType: "claude",
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
        };
      },
    });

    expect(result.status).toBe("passed");

    const transcript = await readFile(join(outputDir, "protocol.initialize.jsonl"), "utf8");
    expect(transcript).toContain("\"method\":\"initialize\"");
  });

  it("classifies assertion-only misses as not-observed when the case requests it", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "opencode",
        displayName: "OpenCode ACP Adapter",
      },
      testCase: {
        version: 1,
        id: "protocol.plan-update",
        kind: "protocol",
        title: "Plan Update",
        protocolDependencies: ["session/update"],
        classification: {
          opencode: {
            assertionFailureStatus: "not-observed",
          },
        },
        steps: [],
        assertions: [{ type: "transcript-has-event", eventType: "plan" }],
      },
      outputDir,
      executor: async () => ({
        status: "passed",
        summaryPatch: {},
      }),
    });

    expect(result.status).toBe("not-observed");
  });

  it("supports agent include and exclude filters", () => {
    expect(caseAppliesToAgent({
      version: 1,
      id: "simulator.only",
      kind: "protocol",
      title: "Simulator only",
      agents: {
        include: ["simulator-agent-acp-local"],
      },
      protocolDependencies: ["initialize"],
      steps: [],
      assertions: [],
    }, "simulator-agent-acp-local")).toBe(true);

    expect(caseAppliesToAgent({
      version: 1,
      id: "simulator.excluded",
      kind: "protocol",
      title: "Excluded",
      agents: {
        exclude: ["simulator-agent-acp-local"],
      },
      protocolDependencies: ["initialize"],
      steps: [],
      assertions: [],
    }, "simulator-agent-acp-local")).toBe(false);
  });

  it("supports equality assertions on method responses", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "codex-acp",
        displayName: "Codex ACP",
      },
      testCase: {
        version: 1,
        id: "scenario.permission-denied-cancelled",
        kind: "scenario",
        title: "Permission denied outcome",
        protocolDependencies: ["session/prompt"],
        steps: [],
        assertions: [{
          type: "transcript-method-response-has",
          method: "session/prompt",
          path: "stopReason",
          equals: "cancelled",
        }],
      },
      outputDir,
      executor: async ({ emitWireEntry }) => {
        emitWireEntry({
          direction: "inbound",
          type: "response",
          method: "session/prompt",
          payload: {
            stopReason: "cancelled",
          },
        });

        return {
          status: "passed",
          summaryPatch: {},
        };
      },
    });

    expect(result.status).toBe("passed");
  });

  it("derives permission families into harness summary and scenario notes", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "claude-acp",
        displayName: "Claude ACP",
      },
      testCase: {
        version: 1,
        id: "scenario.permission-mode-denied",
        kind: "scenario",
        title: "Mode denied",
        level: "P1",
        protocolDependencies: ["session/prompt"],
        steps: [],
        assertions: [],
      },
      outputDir,
      executor: async ({ emitWireEntry }) => {
        emitWireEntry({
          direction: "inbound",
          type: "tool_call_update",
          method: "session/update",
          payload: {
            update: {
              sessionUpdate: "tool_call_update",
              status: "failed",
            },
          },
        });
        emitWireEntry({
          direction: "inbound",
          type: "response",
          method: "session/prompt",
          payload: {
            stopReason: "end_turn",
          },
        });

        return {
          status: "passed",
          summaryPatch: {
            discovery: {
              mode: {
                currentModeId: "dontAsk",
              },
            },
          },
        };
      },
    });

    expect(result.summaryPatch.discovery?.permission).toEqual({
      deniedFamilies: ["mode_denied"],
      requestObserved: false,
    });
    expect(result.summaryPatch.scenarioResults?.["scenario.permission-mode-denied"]?.notes).toContain(
      "Observed permission families: mode_denied",
    );
  });

  it("supports any-of assertions for host authority or agent-native tools", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "claude-acp",
        displayName: "Claude ACP",
      },
      testCase: {
        version: 1,
        id: "scenario.read-file",
        kind: "scenario",
        title: "Read File",
        level: "P0",
        protocolDependencies: ["session/prompt"],
        steps: [],
        assertions: [{
          type: "any-of",
          assertions: [
            { type: "transcript-has-method", method: "fs/read_text_file" },
            { type: "transcript-has-tool-update", kind: "read", status: "completed" },
          ],
        }],
      },
      outputDir,
      executor: async ({ emitWireEntry }) => {
        emitWireEntry({
          direction: "inbound",
          type: "tool_call_update",
          method: "session/update",
          payload: {
            update: {
              kind: "read",
              status: "completed",
              sessionUpdate: "tool_call_update",
            },
          },
        });

        return {
          status: "passed",
          summaryPatch: {},
        };
      },
    });

    expect(result.status).toBe("passed");
  });

  it("matches tool_call_update assertions using the preceding tool_call kind", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "acp-runtime-harness-"));

    const result = await runHarnessCase({
      agent: {
        type: "codex-acp",
        displayName: "Codex ACP",
      },
      testCase: {
        version: 1,
        id: "scenario.run-command",
        kind: "scenario",
        title: "Run Command",
        level: "P0",
        protocolDependencies: ["session/prompt"],
        steps: [],
        assertions: [{
          type: "transcript-has-tool-update",
          kind: "execute",
          status: "completed",
        }],
      },
      outputDir,
      executor: async ({ emitWireEntry }) => {
        emitWireEntry({
          direction: "inbound",
          type: "tool_call",
          method: "session/update",
          payload: {
            update: {
              kind: "execute",
              toolCallId: "tool-1",
              sessionUpdate: "tool_call",
            },
          },
        });
        emitWireEntry({
          direction: "inbound",
          type: "tool_call_update",
          method: "session/update",
          payload: {
            update: {
              toolCallId: "tool-1",
              status: "completed",
              sessionUpdate: "tool_call_update",
            },
          },
        });

        return {
          status: "passed",
          summaryPatch: {},
        };
      },
    });

    expect(result.status).toBe("passed");
  });
});
