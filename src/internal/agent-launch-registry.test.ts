import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockRename = vi.fn();
const mockRm = vi.fn();
const mockOpen = vi.fn();
const mockFileHandleWriteFile = vi.fn();
const mockFileHandleClose = vi.fn();
const mockMkdir = vi.fn();
const mockStat = vi.fn();
const mockSpawnSync = vi.fn();

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  open: mockOpen,
  readFile: mockReadFile,
  rename: mockRename,
  rm: mockRm,
  stat: mockStat,
  writeFile: mockWriteFile,
}));

vi.mock("node:child_process", () => ({
  spawnSync: mockSpawnSync,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    arch: () => "x64",
    homedir: () => "/mock-home",
    platform: () => "linux",
  };
});

describe("agent launch registry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", vi.fn());
    mockOpen.mockResolvedValue({
      close: mockFileHandleClose,
      writeFile: mockFileHandleWriteFile,
    });
  });

  it("resolves npx launch config from a fresh cached registry without fetching", async () => {
    mockStat.mockResolvedValueOnce({
      mtimeMs: Date.now(),
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      agents: [
        {
          description: "Claude",
          distribution: {
            npx: {
              args: ["--debug"],
              package: "@agentclientprotocol/claude-agent-acp@0.26.0",
            },
          },
          id: "claude-acp",
          name: "Claude Agent",
          version: "0.26.0",
        },
      ],
      version: "1",
    }));

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");
    const launch = await resolveAgentLaunch("claude-acp");

    expect(launch).toEqual({
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
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves Codex ACP npx launch config from cached registry metadata", async () => {
    mockStat.mockResolvedValueOnce({
      mtimeMs: Date.now(),
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      agents: [
        {
          description: "Codex",
          distribution: {
            npx: {
              package: "@zed-industries/codex-acp@0.11.1",
            },
          },
          id: "codex-acp",
          name: "Codex CLI",
          version: "0.11.1",
        },
      ],
      version: "1",
    }));

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");
    const launch = await resolveAgentLaunch("codex-acp");

    expect(launch).toEqual({
      args: [
        "--yes",
        "-p",
        "@zed-industries/codex-acp@0.11.1",
        "codex-acp",
      ],
      command: "npx",
      env: undefined,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves uvx launch config from fetched registry and caches the response", async () => {
    mockStat.mockRejectedValueOnce(new Error("missing cache"));
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        agents: [
          {
            description: "Python Agent",
            distribution: {
              uvx: {
                args: ["serve"],
                env: { UVX_MODE: "1" },
                package: "python-agent",
              },
            },
            id: "python-agent",
            name: "Python Agent",
            version: "0.1.0",
          },
        ],
        version: "1",
      }),
    } as Response);

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");
    const launch = await resolveAgentLaunch("python-agent");

    expect(launch).toEqual({
      args: ["python-agent", "serve"],
      command: "uvx",
      env: { UVX_MODE: "1" },
    });
    expect(mockMkdir).toHaveBeenCalledWith("/mock-home/.acp-runtime/cache", {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("uses ACP_RUNTIME_CACHE_DIR when the host overrides the cache root", async () => {
    vi.stubEnv("ACP_RUNTIME_CACHE_DIR", "/custom-cache-root");
    mockStat.mockRejectedValueOnce(new Error("missing cache"));
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        agents: [
          {
            description: "Python Agent",
            distribution: {
              uvx: {
                package: "python-agent",
              },
            },
            id: "python-agent",
            name: "Python Agent",
            version: "0.1.0",
          },
        ],
        version: "1",
      }),
    } as Response);

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");
    await resolveAgentLaunch("python-agent");

    expect(mockMkdir).toHaveBeenCalledWith("/custom-cache-root", {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/custom-cache-root\/registry\.json\.\d+\.\d+\.[a-f0-9]+\.tmp$/,
      ),
      expect.any(String),
    );
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/custom-cache-root\/registry\.json\.\d+\.\d+\.[a-f0-9]+\.tmp$/,
      ),
      resolve("/custom-cache-root", "registry.json"),
    );
  });

  it("prefers PATH binaries over archive download for binary distributions", async () => {
    mockStat.mockRejectedValueOnce(new Error("missing cache"));
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        agents: [
          {
            description: "Binary Agent",
            distribution: {
              binary: {
                "linux-x86_64": {
                  args: ["serve"],
                  cmd: "./binary-agent",
                  env: { MODE: "prod" },
                },
              },
            },
            id: "binary-agent",
            name: "Binary Agent",
            version: "1.0.0",
          },
        ],
        version: "1",
      }),
    } as Response);
    mockSpawnSync.mockReturnValue({
      status: 0,
    });

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");
    const launch = await resolveAgentLaunch("binary-agent");

    expect(launch).toEqual({
      args: ["serve"],
      command: "binary-agent",
      env: { MODE: "prod" },
    });
  });

  it("fails clearly when the registry fetch fails and there is no fresh cache", async () => {
    mockStat.mockRejectedValueOnce(new Error("missing cache"));
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    } as Response);

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");

    await expect(resolveAgentLaunch("claude-acp")).rejects.toThrow(
      "Failed to fetch ACP registry: 503 Service Unavailable",
    );
  });

  it("fails clearly when the agent id is missing from the registry", async () => {
    mockStat.mockResolvedValueOnce({
      mtimeMs: Date.now(),
    });
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      agents: [],
      version: "1",
    }));

    const { resolveAgentLaunch } = await import("./agent-launch-registry.js");

    await expect(resolveAgentLaunch("missing-agent")).rejects.toThrow(
      'Agent "missing-agent" not found in ACP registry.',
    );
  });
});
