import { describe, expect, it } from "vitest";

import { CODEX_ACP_REGISTRY_ID } from "../../agents/codex-acp.js";
import { CLAUDE_CODE_ACP_REGISTRY_ID } from "../../agents/claude-code-acp.js";
import { GEMINI_CLI_ACP_REGISTRY_ID } from "../../agents/gemini-cli-acp.js";
import {
  LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
  SIMULATOR_AGENT_ACP_REGISTRY_ID,
} from "../../agents/simulator-agent-acp.js";
import { resolveAcpAgentProfile } from "./index.js";
import { GEMINI_TERMINAL_AUTH_METHOD_ID } from "./gemini.js";

describe("resolveAcpAgentProfile", () => {
  it("resolves simulator profiles", () => {
    const standard = resolveAcpAgentProfile({
      command: "simulator-agent-acp",
      type: SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });
    const local = resolveAcpAgentProfile({
      command: "simulator-agent-acp",
      type: LOCAL_SIMULATOR_AGENT_ACP_REGISTRY_ID,
    });

    expect(standard.mapOperationKind("execute")).toBe("execute_command");
    expect(local.mapOperationKind("search")).toBe("read_file");
  });

  it("resolves Claude profiles", () => {
    const profile = resolveAcpAgentProfile({
      command: "claude-agent-acp",
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    });

    expect(profile.mapOperationKind("fetch")).toBe("network_request");
  });

  it("resolves Codex profiles", () => {
    const profile = resolveAcpAgentProfile({
      command: "codex-acp",
      type: CODEX_ACP_REGISTRY_ID,
    });

    expect(profile.mapOperationKind("execute")).toBe("execute_command");
  });

  it("resolves Gemini profiles and synthesizes legacy auth methods", () => {
    const profile = resolveAcpAgentProfile({
      args: ["--acp"],
      command: "gemini",
      type: GEMINI_CLI_ACP_REGISTRY_ID,
    });

    const methods = profile.normalizeInitializeAuthMethods?.({
      agent: {
        args: ["--acp"],
        command: "gemini",
        type: GEMINI_CLI_ACP_REGISTRY_ID,
      },
      authMethods: [],
    });

    expect(methods).toEqual([
      expect.objectContaining({
        id: GEMINI_TERMINAL_AUTH_METHOD_ID,
        _meta: expect.objectContaining({
          "acp-runtime/profile-policy": expect.objectContaining({
            kind: "synthetic-auth-method",
            profile: "gemini",
          }),
        }),
        name: "Login",
      }),
    ]);
  });
});
