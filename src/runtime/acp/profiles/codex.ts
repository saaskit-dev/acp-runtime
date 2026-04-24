import type { AcpRuntimeAgent } from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createCodexAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({});
}
