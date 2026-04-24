import { describe, expect, it } from "vitest";

import {
  createNpxCommandLaunch,
  inferExecutableFromPackageSpec,
  resolvePackageSpec,
} from "./launch-config.js";

describe("launch config helpers", () => {
  it("resolves package specs with optional versions", () => {
    expect(resolvePackageSpec("@scope/pkg")).toBe("@scope/pkg");
    expect(resolvePackageSpec("@scope/pkg", "1.2.3")).toBe("@scope/pkg@1.2.3");
  });

  it("infers executables from package specs", () => {
    expect(inferExecutableFromPackageSpec("@agentclientprotocol/claude-agent-acp@0.26.0")).toBe(
      "claude-agent-acp",
    );
    expect(inferExecutableFromPackageSpec("deepagents-acp@0.1.7")).toBe(
      "deepagents-acp",
    );
  });

  it("builds npx launch arguments with explicit executables", () => {
    expect(
      createNpxCommandLaunch({
        args: ["--debug"],
        executable: "claude-agent-acp",
        packageName: "@agentclientprotocol/claude-agent-acp",
        version: "0.26.0",
      }),
    ).toEqual({
      args: [
        "--yes",
        "-p",
        "@agentclientprotocol/claude-agent-acp@0.26.0",
        "claude-agent-acp",
        "--debug",
      ],
      command: "npx",
      env: undefined,
    });
  });
});
