import { describe, expect, it } from "vitest";

import { CLAUDE_CODE_ACP_REGISTRY_ID } from "../../agents/claude-code-acp.js";
import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../../agents/simulator-agent-acp.js";
import { resolveAcpAgentProfile } from "./index.js";

describe("resolveAcpAgentProfile", () => {
  it("resolves simulator profiles", () => {
    const standard = resolveAcpAgentProfile({
      command: "simulator-agent-acp",
      type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });
    const local = resolveAcpAgentProfile({
      command: "simulator-agent-acp",
      type: LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });

    expect(standard.mapOperationKind("execute")).toBe("execute_command");
    expect(local.mapOperationKind("search")).toBe("read_file");
  });

  it("resolves Claude profiles", () => {
    const profile = resolveAcpAgentProfile({
      command: "claude-agent-acp",
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    });

    expect(profile.mapOperationKind("fetch")).toBe("network_request");
  });
});
