import { describe, expect, it } from "vitest";

import {
  isHarnessCase,
  isHarnessSummary,
  isTranscriptEntry,
  parseHarnessCase,
} from "./validators.js";

describe("harness validators", () => {
  it("accepts a valid harness case", () => {
    const value = {
      version: 1,
      id: "protocol.initialize",
      kind: "protocol",
      title: "initialize",
      agents: {
        include: ["simulator-agent-acp-local"],
      },
      protocolDependencies: ["initialize"],
      retries: {
        count: 2,
        onStatuses: ["not-observed"],
      },
      classification: {
        claude: {
          assertionFailureStatus: "not-observed",
          timeoutStatus: "mismatch",
        },
      },
      probes: {
        "codex-acp": {
          modeId: "read-only",
          prompt: "Write ./tmp-output.txt",
        },
      },
      steps: [
        { type: "initialize" },
        {
          type: "session-prompt",
          prompt: "$probe-prompt",
          defaultPrompt: "Write ./tmp-output.txt",
        },
      ],
      assertions: [{ type: "transcript-has-method", method: "initialize" }],
    };

    expect(isHarnessCase(value)).toBe(true);
    expect(parseHarnessCase(value)).toEqual(value);
  });

  it("rejects an invalid harness case", () => {
    expect(isHarnessCase({ id: "missing-fields" })).toBe(false);
  });

  it("accepts a valid transcript entry", () => {
    expect(isTranscriptEntry({
      timestamp: "2026-04-03T00:00:00.000Z",
      kind: "wire",
      direction: "outbound",
      type: "request",
      method: "initialize",
    })).toBe(true);
  });

  it("accepts a valid harness summary", () => {
    expect(isHarnessSummary({
      agent: "claude",
      timestamp: "2026-04-03T00:00:00.000Z",
      protocolCoverage: {
        initialize: {
          status: "PASS",
          advertised: true,
          caseId: "protocol.initialize",
          notes: [],
        },
      },
      discovery: {
        initialize: {
          protocolVersion: 1,
          agentInfo: {
            name: "Claude",
            version: "1.0.0",
          },
          capabilities: {
            loadSession: true,
          },
        },
        session: {
          id: "session_123",
          listed: [
            {
              id: "session_123",
              cwd: "/tmp",
              title: "Example",
            },
          ],
        },
        auth: {
          authenticated: true,
          methodId: "login",
        },
        plan: {
          entries: [
            {
              content: "Do the work",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
        commands: {
          available: [
            {
              name: "web",
              description: "Search the web",
              inputHint: "query",
            },
          ],
        },
        mode: {
          currentModeId: "default",
          availableModes: [
            {
              id: "default",
              name: "Default",
              description: "Default mode",
            },
          ],
        },
      },
    })).toBe(true);
  });
});
