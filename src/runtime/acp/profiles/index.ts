import { CODEX_ACP_REGISTRY_ID } from "../../agents/codex-acp.js";
import { CLAUDE_CODE_ACP_REGISTRY_ID } from "../../agents/claude-code-acp.js";
import { GEMINI_CLI_ACP_REGISTRY_ID } from "../../agents/gemini-cli-acp.js";
import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../../agents/simulator-agent-acp.js";
import type { AcpRuntimeAgent } from "../../core/types.js";
import { createCodexAgentProfile } from "./codex.js";
import { createClaudeCodeAgentProfile } from "./claude-code.js";
import { createGeminiAgentProfile } from "./gemini.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";
import { createSimulatorAgentProfile } from "./simulator.js";

export function resolveAcpAgentProfile(
  agent: AcpRuntimeAgent,
): AcpAgentProfile {
  switch (agent.type) {
    case CODEX_ACP_REGISTRY_ID:
      return createCodexAgentProfile(agent);
    case GEMINI_CLI_ACP_REGISTRY_ID:
      return createGeminiAgentProfile(agent);
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
