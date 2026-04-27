import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CODEX_ACP_REGISTRY_ID } from "../../agents/codex-acp.js";
import { CLAUDE_CODE_ACP_REGISTRY_ID } from "../../agents/claude-code-acp.js";
import { GEMINI_CLI_ACP_REGISTRY_ID } from "../../agents/gemini-cli-acp.js";
import { GITHUB_COPILOT_ACP_REGISTRY_ID } from "../../agents/github-copilot-acp.js";
import { OPENCODE_ACP_REGISTRY_ID } from "../../agents/opencode-acp.js";
import { PI_ACP_REGISTRY_ID } from "../../agents/pi-acp.js";
import {
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
} from "../../core/types.js";
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

  it("resolves Claude profiles and marks terminal login completion hints", async () => {
    const profile = resolveAcpAgentProfile({
      command: "claude-agent-acp",
      type: CLAUDE_CODE_ACP_REGISTRY_ID,
    });

    const methods = await profile.normalizeRuntimeAuthenticationMethods?.({
      agent: {
        command: "claude-agent-acp",
        type: CLAUDE_CODE_ACP_REGISTRY_ID,
      },
      methods: [
        {
          args: ["/login"],
          id: "claude-login",
          title: "Login",
          type: "terminal",
        },
      ],
    });

    expect(methods?.[0]?.meta).toEqual({
      [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
        "Login successful",
        "Type your message",
      ],
    });
  });

  it("resolves Codex profiles", () => {
    const profile = resolveAcpAgentProfile({
      command: "codex-acp",
      type: CODEX_ACP_REGISTRY_ID,
    });

    expect(profile.mapOperationKind("execute")).toBe("execute_command");
  });

  it("resolves Codex profiles and marks the preferred auth method", async () => {
    const profile = resolveAcpAgentProfile({
      command: "codex-acp",
      type: CODEX_ACP_REGISTRY_ID,
    });

    const methods = await profile.normalizeRuntimeAuthenticationMethods?.({
      agent: {
        command: "codex-acp",
        type: CODEX_ACP_REGISTRY_ID,
      },
      methods: [
        {
          id: "codex-api-key",
          title: "Use CODEX_API_KEY",
          type: "env_var",
          vars: [{ name: "CODEX_API_KEY" }],
        },
        {
          id: "chatgpt-login",
          title: "Login with ChatGPT",
          type: "agent",
        },
      ],
    });

    expect(methods?.[1]?.meta).toEqual({
      [ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY]: true,
    });
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
          [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
            "Login successful",
            "Type your message",
          ],
        }),
        name: "Login",
      }),
    ]);
  });

  it("resolves OpenCode profiles", () => {
    const profile = resolveAcpAgentProfile({
      args: ["acp"],
      command: "opencode",
      type: OPENCODE_ACP_REGISTRY_ID,
    });

    const methods = profile.normalizeInitializeAuthMethods?.({
      agent: {
        args: ["acp"],
        command: "opencode",
        type: OPENCODE_ACP_REGISTRY_ID,
      },
      authMethods: [
        {
          description: "Run `opencode auth login` in the terminal",
          id: "opencode-login",
          name: "Login with opencode",
        },
      ],
    });

    expect(methods).toEqual([
      expect.objectContaining({
        id: "opencode-login",
        name: "Login with opencode",
      }),
    ]);
  });

  it("resolves GitHub Copilot profiles and removes terminal login metadata when already logged in", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "acp-runtime-copilot-"));
    try {
      await writeFile(
        join(configDir, "config.json"),
        `// User settings belong in settings.json.
${JSON.stringify({
  loggedInUsers: [{ host: "https://github.com", login: "kilingzhang" }],
})}`,
      );
      const profile = resolveAcpAgentProfile({
        command: "npx",
        type: GITHUB_COPILOT_ACP_REGISTRY_ID,
      });

      const methods = await profile.normalizeRuntimeAuthenticationMethods?.({
        agent: {
          command: "npx",
          type: GITHUB_COPILOT_ACP_REGISTRY_ID,
        },
        methods: [
          {
            id: "copilot-login",
            meta: {
              "terminal-auth": {
                args: ["login", "--config-dir", configDir],
                command: "copilot",
                label: "Copilot Login",
              },
            },
            title: "Log in with Copilot CLI",
            type: "agent",
          },
        ],
      });

      expect(methods?.[0]).toEqual({
        id: "copilot-login",
        meta: undefined,
        title: "Log in with Copilot CLI",
        type: "agent",
      });
    } finally {
      await rm(configDir, { force: true, recursive: true });
    }
  });

  it("resolves Pi profiles and adapts terminal login to protocol-only auth", async () => {
    const profile = resolveAcpAgentProfile({
      command: "npx",
      type: PI_ACP_REGISTRY_ID,
    });

    const methods = await profile.normalizeRuntimeAuthenticationMethods?.({
      agent: {
        command: "npx",
        type: PI_ACP_REGISTRY_ID,
      },
      methods: [
        {
          args: ["--terminal-login"],
          id: "pi_terminal_login",
          title: "Launch pi in the terminal",
          type: "terminal",
        },
      ],
    });

    expect(methods?.[0]).toEqual({
      description:
        "Interactive Pi CLI setup is not launched automatically by hosts.",
      id: "pi_terminal_login",
      meta: undefined,
      title: "Launch pi in the terminal",
      type: "agent",
    });
  });
});
