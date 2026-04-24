import { describe, expect, it } from "vitest";

import {
  resolvePermissionDecisionResponse,
  shouldSkipHarnessStep,
} from "./stdio-executor.js";

describe("harness stdio executor helpers", () => {
  it("selects the first option for allow decisions", () => {
    const response = resolvePermissionDecisionResponse("allow", [
      {
        optionId: "allow",
        kind: "allow_once",
        name: "Allow",
      },
      {
        optionId: "deny",
        kind: "reject_once",
        name: "Deny",
      },
    ]);

    expect(response).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "allow",
      },
    });
  });

  it("prefers explicit reject options for deny decisions", () => {
    const response = resolvePermissionDecisionResponse("deny", [
      {
        optionId: "allow",
        kind: "allow_once",
        name: "Allow",
      },
      {
        optionId: "reject",
        kind: "reject_once",
        name: "Reject",
      },
      {
        optionId: "reject-forever",
        kind: "reject_always",
        name: "Reject always",
      },
    ]);

    expect(response).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "reject",
      },
    });
  });

  it("falls back to cancelled when deny has no explicit reject option", () => {
    const response = resolvePermissionDecisionResponse("deny", [
      {
        optionId: "allow",
        kind: "allow_once",
        name: "Allow",
      },
    ]);

    expect(response).toEqual({
      outcome: {
        outcome: "cancelled",
      },
    });
  });

  it("supports probe-aware skip conditions", () => {
    expect(shouldSkipHarnessStep("!probe.modeId", {
      hasModes: true,
      hasAuthMethods: false,
      hasConfigOptions: false,
      probeProfile: undefined,
    })).toBe(true);

    expect(shouldSkipHarnessStep("!probe.modeId", {
      hasModes: true,
      hasAuthMethods: false,
      hasConfigOptions: false,
      probeProfile: { modeId: "read-only" },
    })).toBe(false);

    expect(shouldSkipHarnessStep("!probe.prompt", {
      hasModes: true,
      hasAuthMethods: false,
      hasConfigOptions: false,
      probeProfile: undefined,
    })).toBe(true);

    expect(shouldSkipHarnessStep("!probe.prompt", {
      hasModes: true,
      hasAuthMethods: false,
      hasConfigOptions: false,
      probeProfile: { prompt: "Write ./.tmp/tmp-output.txt" },
    })).toBe(false);
  });
});
