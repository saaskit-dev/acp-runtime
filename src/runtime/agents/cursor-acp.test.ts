import { describe, expect, it } from "vitest";

import {
  CURSOR_ACP_COMMAND,
  CURSOR_ACP_REGISTRY_ID,
  createCursorAcpAgent,
} from "./cursor-acp.js";

describe("createCursorAcpAgent", () => {
  it("builds a default Cursor ACP binary launch config", () => {
    expect(createCursorAcpAgent()).toEqual({
      args: ["acp"],
      command: CURSOR_ACP_COMMAND,
      env: undefined,
      type: CURSOR_ACP_REGISTRY_ID,
    });
  });

  it("keeps custom Cursor launch arguments", () => {
    expect(
      createCursorAcpAgent({
        args: ["acp", "--debug"],
        env: {
          CURSOR_API_KEY: "test-key",
        },
      }),
    ).toEqual({
      args: ["acp", "--debug"],
      command: CURSOR_ACP_COMMAND,
      env: {
        CURSOR_API_KEY: "test-key",
      },
      type: CURSOR_ACP_REGISTRY_ID,
    });
  });
});
