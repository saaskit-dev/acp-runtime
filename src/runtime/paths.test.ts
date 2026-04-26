import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => "/mock-home",
  };
});

describe("runtime default paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults runtime home state under ~/.acp-runtime", async () => {
    const { resolveRuntimeHomePath, resolveRuntimeCachePath } = await import("./paths.js");

    expect(resolveRuntimeHomePath()).toBe("/mock-home/.acp-runtime");
    expect(resolveRuntimeHomePath("state", "runtime-registry.json")).toBe(
      "/mock-home/.acp-runtime/state/runtime-registry.json",
    );
    expect(resolveRuntimeCachePath("registry.json")).toBe(
      "/mock-home/.acp-runtime/cache/registry.json",
    );
  });

  it("supports ACP_RUNTIME_HOME_DIR and ACP_RUNTIME_CACHE_DIR overrides", async () => {
    vi.stubEnv("ACP_RUNTIME_HOME_DIR", "/custom-home");
    vi.stubEnv("ACP_RUNTIME_CACHE_DIR", "/custom-cache");

    const { resolveRuntimeHomePath, resolveRuntimeCachePath } = await import("./paths.js");

    expect(resolveRuntimeHomePath("state", "runtime-registry.json")).toBe(
      "/custom-home/state/runtime-registry.json",
    );
    expect(resolveRuntimeCachePath("registry.json")).toBe(
      "/custom-cache/registry.json",
    );
  });
});
