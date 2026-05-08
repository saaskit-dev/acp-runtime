import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getSessionPath,
  loadCachedSession,
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
});
