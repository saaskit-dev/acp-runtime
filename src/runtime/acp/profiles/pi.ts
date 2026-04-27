import type { AcpRuntimeAgent } from "../../core/types.js";
import { createAgentProfile, type AcpAgentProfile } from "./profile.js";

export function createPiAgentProfile(_agent: AcpRuntimeAgent): AcpAgentProfile {
  return createAgentProfile({
    normalizeRuntimeAuthenticationMethods({ methods }) {
      return methods.map((method) =>
        method.id === "pi_terminal_login"
          ? {
              description:
                "Interactive Pi CLI setup is not launched automatically by hosts.",
              id: method.id,
              meta: method.meta,
              title: method.title,
              type: "agent",
            }
          : method,
      );
    },
  });
}
