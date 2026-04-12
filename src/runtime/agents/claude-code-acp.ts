import type { AcpRuntimeAgent } from "../types.js";

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

function resolvePackageSpec(packageName: string, version?: string): string {
  if (!version || version.trim().length === 0) {
    return packageName;
  }
  return `${packageName}@${version}`;
}

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
      args: ["--yes", resolvePackageSpec(packageName, version), ...args],
      command: "npx",
      env,
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
