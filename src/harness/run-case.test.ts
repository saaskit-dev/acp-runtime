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
        id: "claude",
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
        id: "opencode",
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
});
