import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  getSessionPath,
  loadCachedSession,
  loginViaOAuth,
  saveSession,
} from "./daemon-login.js";

describe("remote daemon login cache", () => {
  it("stores relay sessions under the acp-runtime home", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "acp-runtime-session-"));
    await saveSession({
      accountId: "acct-1",
      savedAt: 123,
      token: "token-1",
    }, homeDir);

    expect(getSessionPath(homeDir)).toBe(
      join(homeDir, ".acp-runtime", "relay-session.json"),
    );
    await expect(loadCachedSession(homeDir)).resolves.toMatchObject({
      accountId: "acct-1",
      token: "token-1",
    });
  });

  it("does not read relay sessions from unrelated acp homes", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "acp-runtime-session-"));

    await expect(loadCachedSession(homeDir)).resolves.toBeUndefined();
  });

  it("clears the OAuth timeout after successful callback", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let loginUrl: string | undefined;
    const login = loginViaOAuth("ws://relay.example", {
      openBrowser: async (url) => {
        loginUrl = url;
      },
      timeoutMs: 5 * 60 * 1000,
    });

    await vi.waitFor(() => {
      expect(loginUrl).toBeDefined();
    });

    const returnTo = new URL(loginUrl ?? "").searchParams.get("returnTo");
    expect(returnTo).toBeTruthy();

    const response = await fetch(`${returnTo}?token=token-2&accountId=acct-2`);
    expect(response.status).toBe(200);
    await expect(login).resolves.toMatchObject({
      accountId: "acct-2",
      token: "token-2",
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});
