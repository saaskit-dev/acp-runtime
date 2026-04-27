import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY,
  ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY,
} from "@saaskit-dev/acp-runtime";
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
  it("consumes Claude profile login success patterns", () => {
    const request = resolveDemoTerminalAuthenticationRequest({
      agent: {
        command: "claude",
        type: "claude-acp",
      },
      method: {
        args: ["/login"],
        id: "claude-login",
        meta: {
          [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
            "Login successful",
            "Type your message",
          ],
        },
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

  it("consumes Gemini profile login success patterns", () => {
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
          [ACP_RUNTIME_TERMINAL_AUTH_SUCCESS_PATTERNS_META_KEY]: [
            "Login successful",
            "Type your message",
          ],
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

  it("uses SDK metadata to select the default authentication method", async () => {
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
              meta: {
                [ACP_RUNTIME_AUTHENTICATION_DEFAULT_METHOD_META_KEY]: true,
              },
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

  it("does not run terminal auth when an adapter has removed terminal metadata", async () => {
    const renderer = { writeLine: vi.fn() };
    const logSink = createSilentLogSink();
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output });

    try {
      const result = await promptForDemoAuthentication({
        inputCoordinator: {
          close: vi.fn(),
          nextUserInput: vi.fn(async () => ""),
          promptExclusive: vi.fn(async () => {
            throw new Error("should not prompt");
          }),
        },
        logSink,
        renderer,
        request: {
          agent: {
            command: "npx",
            type: "github-copilot-cli",
          },
          methods: [
            {
              id: "copilot-login",
              title: "Log in with Copilot CLI",
              type: "agent",
            },
          ],
        },
        rl,
      });

      expect(result).toEqual({ methodId: "copilot-login" });
      expect(logSink.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "acp.demo.authentication.selected",
        }),
      );
      expect(renderer.writeLine).not.toHaveBeenCalled();
    } finally {
      rl.close();
    }
  });
});
