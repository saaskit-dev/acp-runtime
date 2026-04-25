import { describe, expect, it } from "vitest";

import {
  mapRuntimeAuthMethods,
  resolveRuntimeTerminalAuthenticationRequest,
} from "./auth-methods.js";
import { createGeminiAgentProfile } from "./profiles/gemini.js";

describe("runtime auth method mapping", () => {
  it("preserves first-class terminal auth details", () => {
    const methods = mapRuntimeAuthMethods({
      authMethods: [
        {
          args: ["/auth"],
          env: {
            AUTH_MODE: "interactive",
          },
          id: "login",
          name: "Login",
          type: "terminal",
        },
      ],
    });

    expect(methods).toEqual([
      {
        args: ["/auth"],
        description: undefined,
        env: {
          AUTH_MODE: "interactive",
        },
        id: "login",
        meta: undefined,
        title: "Login",
        type: "terminal",
      },
    ]);
  });

  it("resolves legacy terminal auth meta into a terminal request", () => {
    const [method] = mapRuntimeAuthMethods({
      authMethods: [
        {
          _meta: {
            "terminal-auth": {
              args: ["auth", "--interactive"],
              command: "legacy-agent",
              env: {
                AUTH_MODE: "interactive",
              },
              label: "legacy /auth",
            },
          },
          id: "legacy-login",
          name: "Login",
        },
      ],
    }) ?? [];

    const request = resolveRuntimeTerminalAuthenticationRequest({
      agent: {
        command: "legacy-agent",
        type: "mock-agent",
      },
      method: method!,
    });

    expect(request).toEqual({
      args: ["auth", "--interactive"],
      command: "legacy-agent",
      env: {
        AUTH_MODE: "interactive",
      },
      label: "legacy /auth",
      methodId: "legacy-login",
    });
  });

  it("maps Gemini compatibility auth methods without host login policy", () => {
    const profile = createGeminiAgentProfile({
      args: ["--acp"],
      command: "gemini",
      type: "gemini",
    });
    const methods = mapRuntimeAuthMethods({
      authMethods: profile.normalizeInitializeAuthMethods?.({
        agent: {
          args: ["--acp"],
          command: "gemini",
          type: "gemini",
        },
        authMethods: [],
      }),
      profile,
    });

    expect(methods?.[0]).toEqual(
      expect.objectContaining({
        id: "spawn-gemini-cli",
        meta: expect.objectContaining({
          "acp-runtime/profile-policy": expect.objectContaining({
            kind: "synthetic-auth-method",
            profile: "gemini",
          }),
        }),
        type: "agent",
      }),
    );
  });
});
