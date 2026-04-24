import type { AcpRuntimeAgent } from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createClaudeCodeAgentProfile(
  _agent: AcpRuntimeAgent,
): AcpAgentProfile {
  return createAgentProfile({
    inferDeniedOperationFamily({ metadata, operation }) {
      if (
        metadata.currentModeId === "dontAsk" &&
        (operation.kind === "write_file" || operation.kind === "execute_command")
      ) {
        return "mode_denied";
      }
      return undefined;
    },
  });
}
