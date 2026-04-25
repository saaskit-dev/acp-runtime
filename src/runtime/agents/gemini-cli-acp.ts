import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "../../internal/launch-config.js";

export const GEMINI_CLI_ACP_REGISTRY_ID = "gemini";
export const GEMINI_CLI_ACP_PACKAGE = "@google/gemini-cli";
export const GEMINI_CLI_ACP_COMMAND = "gemini";

export type GeminiCliAcpLaunchMode = "binary" | "npx";

export type GeminiCliAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: GeminiCliAcpLaunchMode;
};

export function createGeminiCliAcpAgent(
  options: GeminiCliAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = ["--acp"],
    env,
    packageName = GEMINI_CLI_ACP_PACKAGE,
    version,
    via = "binary",
  } = options;

  if (via === "npx") {
    return {
      ...createNpxCommandLaunch({
        args,
        env,
        executable: GEMINI_CLI_ACP_COMMAND,
        packageSpec: resolvePackageSpec(packageName, version),
      }),
      type: GEMINI_CLI_ACP_REGISTRY_ID,
    };
  }

  return {
    args,
    command: GEMINI_CLI_ACP_COMMAND,
    env,
    type: GEMINI_CLI_ACP_REGISTRY_ID,
  };
}
