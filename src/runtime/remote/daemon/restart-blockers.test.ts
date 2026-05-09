import { describe, expect, it } from "vitest";
import { hasDaemonRestartBlockers } from "./restart-blockers.js";

describe("daemon restart blockers", () => {
  it("does not block daemon restart for idle remote connections", () => {
    expect(
      hasDaemonRestartBlockers({
        activeConnections: 1,
        inFlightRuntimeRequests: 0,
      }),
    ).toBe(false);
  });

  it("blocks daemon restart while runtime requests are in flight", () => {
    expect(
      hasDaemonRestartBlockers({
        activeConnections: 0,
        inFlightRuntimeRequests: 1,
      }),
    ).toBe(true);
  });
});
