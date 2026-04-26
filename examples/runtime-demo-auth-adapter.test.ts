import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  promptForDemoAuthentication,
  resolveDemoTerminalAuthenticationRequest,
} from "./runtime-demo-auth-adapter.js";

const createSilentLogSink = () => ({
  attachSession: async () => {},
  close: async () => {},
  emit: vi.fn(),
  writeLine: vi.fn(),
});

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

  it("defaults Codex authentication to the ChatGPT login agent method", async () => {
    const promptExclusive = vi.fn(async () => {
      throw new Error("should not prompt");
    });
    const renderer = { writeLine: vi.fn() };
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output });

    try {
      const result = await promptForDemoAuthentication({
        inputCoordinator: {
          close: vi.fn(),
          nextUserInput: vi.fn(async () => ""),
          promptExclusive,
        },
        logSink: createSilentLogSink(),
        renderer,
        request: {
          agent: {
            command: "codex-acp",
            type: "codex-acp",
          },
          methods: [
            {
              description: "Use your ChatGPT login with Codex CLI.",
              id: "chatgpt-login",
              title: "Login with ChatGPT",
              type: "agent",
            },
            {
              id: "codex-api-key",
              title: "Use CODEX_API_KEY",
              type: "env_var",
              vars: [{ name: "CODEX_API_KEY" }],
            },
          ],
        },
        rl,
      });

      expect(result).toEqual({ methodId: "chatgpt-login" });
      expect(promptExclusive).not.toHaveBeenCalled();
    } finally {
      rl.close();
    }
  });
});
