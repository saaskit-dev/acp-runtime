import { describe, expect, it } from "vitest";

import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_COMMAND,
  SIMULATOR_AGENT_ACP_PACKAGE,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
  createSimulatorAgentAcpAgent,
} from "./simulator-agent-acp.js";

describe("createSimulatorAgentAcpAgent", () => {
  it("builds a default simulator ACP binary launch config", () => {
    expect(createSimulatorAgentAcpAgent()).toEqual({
      args: [],
      command: SIMULATOR_AGENT_ACP_COMMAND,
      env: undefined,
      type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });
  });

  it("builds an npx simulator launch config", () => {
    expect(
      createSimulatorAgentAcpAgent({
        args: ["--verbose"],
        env: {
          DEBUG: "1",
        },
        version: "0.1.1",
        via: "npx",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        `${SIMULATOR_AGENT_ACP_PACKAGE}@0.1.1`,
        SIMULATOR_AGENT_ACP_COMMAND,
        "--verbose",
      ],
      command: "npx",
      env: {
        DEBUG: "1",
      },
      type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });
  });
});
