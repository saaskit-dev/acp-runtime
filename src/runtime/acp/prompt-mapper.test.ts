import { describe, expect, it } from "vitest";

import { mapPromptToAcp } from "./prompt-mapper.js";

describe("mapPromptToAcp", () => {
  it("maps mixed message and part arrays in order", () => {
    expect(
      mapPromptToAcp([
        {
          content: "system guidance",
          role: "system",
        },
        {
          text: "direct user content",
          type: "text",
        },
        {
          content: [{ text: "nested user content", type: "text" }],
          role: "user",
        },
      ]),
    ).toEqual([
      {
        text: "[system]\nsystem guidance",
        type: "text",
      },
      {
        text: "direct user content",
        type: "text",
      },
      {
        text: "[user]",
        type: "text",
      },
      {
        text: "nested user content",
        type: "text",
      },
    ]);
  });
});
