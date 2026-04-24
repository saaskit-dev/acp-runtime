import { describe, expect, it } from "vitest";

import {
  getAgentMeta,
  LOCAL_SIMULATOR_AGENT_ID,
  resolveAgentLaunch,
} from "./registry-client.js";
import { resolveSimulatorWorkspaceRoot } from "@saaskit-dev/acp-runtime/internal/simulator-workspace";

describe("harness registry client", () => {
  it("resolves the local simulator launch without hitting the ACP registry", async () => {
    const launch = await resolveAgentLaunch(LOCAL_SIMULATOR_AGENT_ID);

    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toContain(resolveSimulatorWorkspaceRoot());
    expect(launch.args).toContain("--auth-mode");
    expect(launch.args).toContain("none");
  });

  it("returns synthetic metadata for the local simulator agent", async () => {
    const meta = await getAgentMeta(LOCAL_SIMULATOR_AGENT_ID);

    expect(meta.name).toContain("Simulator Agent ACP");
    expect(meta.description).toContain("local simulator-agent-acp workspace build");
  });
});
