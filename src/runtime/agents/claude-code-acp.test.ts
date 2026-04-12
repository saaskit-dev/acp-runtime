import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_ACP_COMMAND,
  CLAUDE_CODE_ACP_PACKAGE,
  CLAUDE_CODE_ACP_REGISTRY_ID,
  createClaudeCodeAcpAgent,
} from "./claude-code-acp.js";

describe("createClaudeCodeAcpAgent", () => {
  it("builds a default Claude Code ACP binary launch config", () => {
    expect(createClaudeCodeAcpAgent()).toEqual({
      args: [],
      command: CLAUDE_CODE_ACP_COMMAND,
      env: undefined,
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    });
  });

  it("builds an npx Claude Code ACP launch config", () => {
    expect(
      createClaudeCodeAcpAgent({
        args: ["--debug"],
        env: {
          ANTHROPIC_API_KEY: "test-key",
        },
        version: "0.26.0",
        via: "npx",
      }),
    ).toEqual({
      args: ["--yes", `${CLAUDE_CODE_ACP_PACKAGE}@0.26.0`, "--debug"],
      command: "npx",
      env: {
        ANTHROPIC_API_KEY: "test-key",
      },
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    });
  });
});
