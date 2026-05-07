import { describe, expect, it } from "vitest";

import { SerialActor } from "./concurrency.js";

describe("SerialActor", () => {
  it("propagates operation failures and continues later dispatches", async () => {
    const actor = new SerialActor();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = actor.dispatch(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:fail");
      throw new Error("boom");
    });
    const second = actor.dispatch(() => {
      events.push("second:start");
      return "ok";
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst?.();

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    await expect(actor.drain()).resolves.toBeUndefined();
    expect(events).toEqual(["first:start", "first:fail", "second:start"]);
  });
});
