import { EventEmitter } from "node:events";
import type { Interface } from "node:readline/promises";
import { describe, expect, it } from "vitest";

import {
  createInputCoordinator,
  type DemoOutputGate,
} from "./runtime-demo-input.js";

class FakeInterface extends EventEmitter {
  line = "";
  promptCalls: string[] = [];
  promptValue = "";
  writes: string[] = [];

  pause(): void {}

  prompt(): void {
    this.promptCalls.push(this.promptValue);
  }

  resume(): void {}

  setPrompt(value: string): void {
    this.promptValue = value;
  }

  write(value: string): void {
    this.line = value;
    this.writes.push(value);
  }
}

function createFakeOutputGate() {
  const events: string[] = [];
  const gate: DemoOutputGate = {
    beginPrompt() {
      events.push("begin");
    },
    endPrompt() {
      events.push("end");
    },
    flush() {},
    pause() {
      events.push("pause");
    },
    print() {},
    record(line) {
      events.push(`record:${line}`);
    },
    resume() {
      events.push("resume");
    },
  };

  return { events, gate };
}

describe("runtime demo input coordinator", () => {
  it("restores an in-progress user draft after an exclusive prompt resolves", async () => {
    const rl = new FakeInterface();
    const { events, gate } = createFakeOutputGate();
    const coordinator = createInputCoordinator(
      rl as unknown as Interface,
      gate,
    );

    const userInputPromise = coordinator.nextUserInput();
    rl.line = "draft message";

    const permissionPromise = coordinator.promptExclusive({
      promptText: "permission requested",
    });

    rl.emit("line", "y");
    await expect(permissionPromise).resolves.toBe("y");

    expect(events).toEqual([
      "begin",
      "pause",
      "end",
      "record:permission requested",
      "resume",
      "begin",
    ]);
    expect(rl.writes).toEqual(["draft message"]);
    expect(rl.promptValue).toBe("you> ");

    rl.emit("line", "final input");
    await expect(userInputPromise).resolves.toBe("final input");

    coordinator.close();
  });

  it("serializes multiple exclusive prompts on one readline", async () => {
    const rl = new FakeInterface();
    const { events, gate } = createFakeOutputGate();
    const coordinator = createInputCoordinator(
      rl as unknown as Interface,
      gate,
    );

    const firstPrompt = coordinator.promptExclusive({
      promptText: "first prompt",
      promptToken: "first> ",
    });
    const secondPrompt = coordinator.promptExclusive({
      promptText: "second prompt",
      promptToken: "second> ",
    });

    expect(rl.promptValue).toBe("first> ");

    rl.emit("line", "1");
    await expect(firstPrompt).resolves.toBe("1");
    expect(rl.promptValue).toBe("second> ");

    rl.emit("line", "2");
    await expect(secondPrompt).resolves.toBe("2");

    expect(events).toEqual([
      "pause",
      "end",
      "record:first prompt",
      "resume",
      "pause",
      "end",
      "record:second prompt",
      "resume",
    ]);

    coordinator.close();
  });
});
