import { resolveAgentLaunch } from "../../internal/agent-launch-registry.js";

import type { AcpRuntimeAgent } from "../core/types.js";

export async function resolveRuntimeAgentFromRegistry(
  agentId: string,
): Promise<AcpRuntimeAgent> {
  const launch = await resolveAgentLaunch(agentId);
  return {
    args: launch.args,
    command: launch.command,
    env: launch.env,
    type: agentId,
  };
}
