import { CLAUDE_CODE_ACP_REGISTRY_ID } from "../../agents/claude-code-acp.js";
import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../../agents/simulator-agent-acp.js";
import type { AcpRuntimeAgent } from "../../types.js";
import { createClaudeCodeAgentProfile } from "./claude-code.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";
import { createSimulatorAgentProfile } from "./simulator.js";

export function resolveAcpAgentProfile(
  agent: AcpRuntimeAgent,
): AcpAgentProfile {
  switch (agent.type) {
    case SIMULATOR_AGENT_ACP_REGISTRY_ID:
    case LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID:
      return createSimulatorAgentProfile(agent);
    case CLAUDE_CODE_ACP_REGISTRY_ID:
      return createClaudeCodeAgentProfile(agent);
    default:
      return createAgentProfile({});
  }
}

export type { AcpAgentProfile } from "./profile.js";
