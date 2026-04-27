import {
  resolveAgentLaunch,
  resolveAgentRegistryId,
} from "./agent-launch-registry.js";

import type { AcpRuntimeAgent } from "../core/types.js";

export async function resolveRuntimeAgentFromRegistry(
  agentId: string,
): Promise<AcpRuntimeAgent> {
  const resolvedAgentId = resolveAgentRegistryId(agentId);
  const launch = await resolveAgentLaunch(resolvedAgentId);
  return {
    args: launch.args,
    command: launch.command,
    env: launch.env,
    type: resolvedAgentId,
  };
}
