import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const CODEX_ACP_REGISTRY_ID = "codex-acp";
export const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
export const CODEX_ACP_COMMAND = "codex-acp";

export type CodexAcpLaunchMode = "binary" | "npx";

export type CodexAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: CodexAcpLaunchMode;
};

export function createCodexAcpAgent(
  options: CodexAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = [],
    env,
    packageName = CODEX_ACP_PACKAGE,
    version,
    via = "binary",
  } = options;

  if (via === "npx") {
    return {
      ...createNpxCommandLaunch({
        args,
        env,
        executable: CODEX_ACP_COMMAND,
        packageSpec: resolvePackageSpec(packageName, version),
      }),
      type: CODEX_ACP_REGISTRY_ID,
    };
  }

  return {
    args,
    command: CODEX_ACP_COMMAND,
    env,
    type: CODEX_ACP_REGISTRY_ID,
  };
}
