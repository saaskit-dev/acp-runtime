import type { AcpRuntimeAgent } from "../../types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createClaudeCodeAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({});
}
