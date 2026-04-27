import { describe, expect, it } from "vitest";

import {
  PI_ACP_COMMAND,
  PI_ACP_PACKAGE,
  PI_ACP_REGISTRY_ID,
  createPiAcpAgent,
} from "./pi-acp.js";

describe("createPiAcpAgent", () => {
  it("builds an npx pi ACP launch config", () => {
    expect(
      createPiAcpAgent({
        args: ["--verbose"],
        env: {
          PI_API_KEY: "test-key",
        },
        version: "0.0.26",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        `${PI_ACP_PACKAGE}@0.0.26`,
        PI_ACP_COMMAND,
        "--verbose",
      ],
      command: "npx",
      env: {
        PI_API_KEY: "test-key",
      },
      type: PI_ACP_REGISTRY_ID,
    });
  });
});
