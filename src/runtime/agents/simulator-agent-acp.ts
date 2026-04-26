import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const SIMULATOR_AGENT_ACP_COMMAND = "simulator-agent-acp";
export const SIMULATOR_AGENT_ACP_REGISTRY_ID = "simulator-agent-acp";
export const LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID =
  "simulator-agent-acp-local";
export const SIMULATOR_AGENT_ACP_PACKAGE = "@saaskit-dev/simulator-agent-acp";

export type SimulatorAgentAcpLaunchMode = "binary" | "npx";

export type SimulatorAgentAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: SimulatorAgentAcpLaunchMode;
};

export function createSimulatorAgentAcpAgent(
  options: SimulatorAgentAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = [],
    env,
    packageName = SIMULATOR_AGENT_ACP_PACKAGE,
    version,
    via = "binary",
  } = options;

  if (via === "npx") {
    return {
      ...createNpxCommandLaunch({
        args,
        env,
        executable: SIMULATOR_AGENT_ACP_COMMAND,
        packageSpec: resolvePackageSpec(packageName, version),
      }),
      type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
    };
  }

  return {
    args,
    command: SIMULATOR_AGENT_ACP_COMMAND,
    env,
    type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
  };
}
