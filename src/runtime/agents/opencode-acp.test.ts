import { describe, expect, it } from "vitest";

import {
  OPENCODE_ACP_COMMAND,
  OPENCODE_ACP_PACKAGE,
  OPENCODE_ACP_REGISTRY_ID,
  createOpenCodeAcpAgent,
} from "./opencode-acp.js";

describe("createOpenCodeAcpAgent", () => {
  it("builds a default OpenCode ACP binary launch config", () => {
    expect(createOpenCodeAcpAgent()).toEqual({
      args: ["acp"],
      command: OPENCODE_ACP_COMMAND,
      env: undefined,
      type: OPENCODE_ACP_REGISTRY_ID,
    });
  });

  it("builds an npx OpenCode ACP launch config", () => {
    expect(
      createOpenCodeAcpAgent({
        env: {
          OPENCODE_API_KEY: "test-key",
        },
        version: "1.14.25",
        via: "npx",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        `${OPENCODE_ACP_PACKAGE}@1.14.25`,
        OPENCODE_ACP_COMMAND,
        "acp",
      ],
      command: "npx",
      env: {
        OPENCODE_API_KEY: "test-key",
      },
      type: OPENCODE_ACP_REGISTRY_ID,
    });
  });
});
