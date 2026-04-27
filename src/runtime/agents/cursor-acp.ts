import type { AcpRuntimeAgent } from "../core/types.js";

export const CURSOR_ACP_REGISTRY_ID = "cursor";
export const CURSOR_ACP_COMMAND = "cursor-agent";

export type CursorAcpAgentOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
};

export function createCursorAcpAgent(
  options: CursorAcpAgentOptions = {},
): AcpRuntimeAgent {
  const { args = ["acp"], env } = options;

  return {
    args,
    command: CURSOR_ACP_COMMAND,
    env,
    type: CURSOR_ACP_REGISTRY_ID,
  };
}
