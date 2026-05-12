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

  it("preserves inline images as ACP image content", () => {
    expect(
      mapPromptToAcp([
        {
          mediaType: "image/png",
          type: "image",
          uri: "data:image/png;base64,aGVsbG8=",
        },
        {
          alt: "screenshot",
          mediaType: "image/png",
          type: "image",
          uri: "file:///tmp/screenshot.png",
        },
      ]),
    ).toEqual([
      {
        data: "aGVsbG8=",
        mimeType: "image/png",
        type: "image",
      },
      {
        mimeType: "image/png",
        name: "screenshot",
        title: "screenshot",
        type: "resource_link",
        uri: "file:///tmp/screenshot.png",
      },
    ]);
  });
});
