import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const PI_ACP_REGISTRY_ID = "pi-acp";
export const PI_ACP_PACKAGE = "pi-acp";
export const PI_ACP_COMMAND = "pi-acp";

export type PiAcpLaunchMode = "npx";

export type PiAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: PiAcpLaunchMode;
};

export function createPiAcpAgent(
  options: PiAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = [],
    env,
    packageName = PI_ACP_PACKAGE,
    version,
  } = options;

  return {
    ...createNpxCommandLaunch({
      args,
      env,
      executable: PI_ACP_COMMAND,
      packageSpec: resolvePackageSpec(packageName, version),
    }),
    type: PI_ACP_REGISTRY_ID,
  };
}
