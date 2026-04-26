import type { AcpRuntimeAgent } from "../core/types.js";
import {
  createNpxCommandLaunch,
  resolvePackageSpec,
} from "./launch-config.js";

export const CLAUDE_CODE_ACP_REGISTRY_ID = "claude-acp";
export const CLAUDE_CODE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
export const CLAUDE_CODE_ACP_COMMAND = "claude-agent-acp";

export type ClaudeCodeAcpLaunchMode = "binary" | "npx";

export type ClaudeCodeAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  packageName?: string;
  version?: string;
  via?: ClaudeCodeAcpLaunchMode;
};

export function createClaudeCodeAcpAgent(
  options: ClaudeCodeAcpAgentOptions = {},
): AcpRuntimeAgent {
  const {
    args = [],
    env,
    packageName = CLAUDE_CODE_ACP_PACKAGE,
    version,
    via = "binary",
  } = options;

  if (via === "npx") {
    return {
      ...createNpxCommandLaunch({
        args,
        env,
        executable: CLAUDE_CODE_ACP_COMMAND,
        packageSpec: resolvePackageSpec(packageName, version),
      }),
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    };
  }

  return {
    args,
    command: CLAUDE_CODE_ACP_COMMAND,
    env,
    type: CLAUDE_CODE_ACP_REGISTRY_ID,
  };
}
