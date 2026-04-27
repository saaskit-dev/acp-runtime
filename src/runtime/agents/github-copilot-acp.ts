import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const GITHUB_COPILOT_ACP_REGISTRY_ID = "github-copilot-cli";
export const GITHUB_COPILOT_ACP_PACKAGE = "@github/copilot";
export const GITHUB_COPILOT_ACP_COMMAND = "copilot";

export type GitHubCopilotAcpLaunchMode = "npx";

export type GitHubCopilotAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: GitHubCopilotAcpLaunchMode;
};

export function createGitHubCopilotAcpAgent(
  options: GitHubCopilotAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = ["--acp"],
    env,
    packageName = GITHUB_COPILOT_ACP_PACKAGE,
    version,
  } = options;

  return {
    ...createNpxCommandLaunch({
      args,
      env,
      executable: GITHUB_COPILOT_ACP_COMMAND,
      packageSpec: resolvePackageSpec(packageName, version),
    }),
    type: GITHUB_COPILOT_ACP_REGISTRY_ID,
  };
}
