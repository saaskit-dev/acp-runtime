import { describe, expect, it } from "vitest";

import {
  listRuntimeAgentModeKeys,
  resolveRuntimeAgentModeId,
  runtimeAgentModeKey,
} from "./mode-utils.js";
import type { AcpRuntimeAgentMode } from "./types.js";

const modes: readonly AcpRuntimeAgentMode[] = [
  {
    description: "Default agent mode",
    id: "https://agentclientprotocol.com/protocol/session-modes#agent",
    name: "Agent",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#plan",
    name: "Plan",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
    name: "Autopilot",
  },
];

describe("runtime mode helpers", () => {
  it("derives stable display keys from URI fragments", () => {
    expect(runtimeAgentModeKey(modes[0]!)).toBe("agent");
    expect(listRuntimeAgentModeKeys(modes)).toContain("plan");
  });

  it("resolves ids from names, keys, and raw ids", () => {
    expect(resolveRuntimeAgentModeId(modes, "Agent").modeId).toBe(modes[0]!.id);
    expect(resolveRuntimeAgentModeId(modes, "agent").modeId).toBe(modes[0]!.id);
    expect(resolveRuntimeAgentModeId(modes, modes[0]!.id).modeId).toBe(
      modes[0]!.id,
    );
  });

  it("returns actionable errors for unknown modes", () => {
    expect(resolveRuntimeAgentModeId(modes, "write").error).toContain(
      "Valid values: agent",
    );
  });
});
