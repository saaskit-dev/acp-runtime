import { describe, expect, it } from "vitest";

import {
  GITHUB_COPILOT_ACP_COMMAND,
  GITHUB_COPILOT_ACP_PACKAGE,
  GITHUB_COPILOT_ACP_REGISTRY_ID,
  createGitHubCopilotAcpAgent,
} from "./github-copilot-acp.js";

describe("createGitHubCopilotAcpAgent", () => {
  it("builds an npx GitHub Copilot ACP launch config", () => {
    expect(
      createGitHubCopilotAcpAgent({
        env: {
          GITHUB_TOKEN: "test-token",
        },
        version: "1.0.36",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        `${GITHUB_COPILOT_ACP_PACKAGE}@1.0.36`,
        GITHUB_COPILOT_ACP_COMMAND,
        "--acp",
      ],
      command: "npx",
      env: {
        GITHUB_TOKEN: "test-token",
      },
      type: GITHUB_COPILOT_ACP_REGISTRY_ID,
    });
  });
});
