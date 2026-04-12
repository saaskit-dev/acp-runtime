import type { AcpRuntimeAgent } from "../../types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createSimulatorAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({});
}
