import { describe, expect, it } from "vitest";

import {
  CODEX_ACP_COMMAND,
  CODEX_ACP_PACKAGE,
  CODEX_ACP_REGISTRY_ID,
  createCodexAcpAgent,
} from "./codex-acp.js";

describe("createCodexAcpAgent", () => {
  it("builds a default Codex ACP binary launch config", () => {
    expect(createCodexAcpAgent()).toEqual({
      args: [],
      command: CODEX_ACP_COMMAND,
      env: undefined,
      type: CODEX_ACP_REGISTRY_ID,
    });
  });

  it("builds an npx Codex ACP launch config", () => {
    expect(
      createCodexAcpAgent({
        args: ["-c", 'model="o3"'],
        env: {
          OPENAI_API_KEY: "test-key",
        },
        version: "0.11.1",
        via: "npx",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        `${CODEX_ACP_PACKAGE}@0.11.1`,
        CODEX_ACP_COMMAND,
        "-c",
        'model="o3"',
      ],
      command: "npx",
      env: {
        OPENAI_API_KEY: "test-key",
      },
      type: CODEX_ACP_REGISTRY_ID,
    });
  });
});
