import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const OPENCODE_ACP_REGISTRY_ID = "opencode";
export const OPENCODE_ACP_PACKAGE = "opencode";
export const OPENCODE_ACP_COMMAND = "opencode";

export type OpenCodeAcpLaunchMode = "binary" | "npx";

export type OpenCodeAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: OpenCodeAcpLaunchMode;
};

export function createOpenCodeAcpAgent(
  options: OpenCodeAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = ["acp"],
    env,
    packageName = OPENCODE_ACP_PACKAGE,
    version,
    via = "binary",
  } = options;

  if (via === "npx") {
    return {
      ...createNpxCommandLaunch({
        args,
        env,
        executable: OPENCODE_ACP_COMMAND,
        packageSpec: resolvePackageSpec(packageName, version),
      }),
      type: OPENCODE_ACP_REGISTRY_ID,
    };
  }

  return {
    args,
    command: OPENCODE_ACP_COMMAND,
    env,
    type: OPENCODE_ACP_REGISTRY_ID,
  };
}
