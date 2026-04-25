import { describe, expect, it } from "vitest";

import { resolveDemoTerminalAuthenticationRequest } from "./runtime-demo-auth-adapter.js";

describe("runtime demo auth adapter", () => {
  it("adds Claude host-side login success patterns", () => {
    const request = resolveDemoTerminalAuthenticationRequest({
      agent: {
        command: "claude",
        type: "claude-acp",
      },
      method: {
        args: ["/login"],
        id: "claude-login",
        title: "Login",
        type: "terminal",
      },
    });

    expect(request).toEqual({
      args: ["/login"],
      command: "claude",
      env: undefined,
      label: "Login",
      methodId: "claude-login",
      successPatterns: ["Login successful", "Type your message"],
    });
  });

  it("adds Gemini host-side login success patterns", () => {
    const request = resolveDemoTerminalAuthenticationRequest({
      agent: {
        command: "gemini",
        type: "gemini",
      },
      method: {
        id: "spawn-gemini-cli",
        meta: {
          "terminal-auth": {
            command: "gemini",
            label: "gemini /auth",
          },
        },
        title: "Login",
        type: "agent",
      },
    });

    expect(request?.successPatterns).toEqual([
      "Login successful",
      "Type your message",
    ]);
  });
});
