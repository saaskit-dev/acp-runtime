import type { ContentBlock } from "@agentclientprotocol/sdk";

import type { AcpRuntimePrompt } from "../core/types.js";

export function mapPromptToAcp(prompt: AcpRuntimePrompt): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }

  if (prompt.length === 0) {
    return [];
  }

  const first = prompt[0];
  if (isPromptMessage(first)) {
    const blocks: ContentBlock[] = [];
    for (const message of prompt) {
      if (!isPromptMessage(message)) {
        throw new Error("Mixed prompt part/message arrays are not supported.");
      }
      const prefix = `[${message.role}]`;
      if (typeof message.content === "string") {
        blocks.push({
          type: "text",
          text: `${prefix}\n${message.content}`,
        });
        continue;
      }

      blocks.push({
        type: "text",
        text: prefix,
      });
      blocks.push(
        ...message.content.flatMap((part) => mapPromptPartToAcp(part)),
      );
    }
    return blocks;
  }

  const parts = prompt as readonly import("../core/types.js").AcpRuntimePromptPart[];
  return parts.flatMap((part) => mapPromptPartToAcp(part));
}

function mapPromptPartToAcp(
  part: import("../core/types.js").AcpRuntimePromptPart,
): ContentBlock[] {
  switch (part.type) {
    case "text":
      return [{ type: "text", text: part.text }];
    case "file":
      return [
        {
          type: "resource_link",
          mimeType: part.mediaType,
          name: part.title ?? part.uri,
          title: part.title,
          uri: part.uri,
        },
      ];
    case "image":
      return [
        {
          type: "resource_link",
          mimeType: part.mediaType,
          name: part.alt ?? part.uri,
          title: part.alt,
          uri: part.uri,
        },
      ];
    case "audio":
      return [
        {
          data: part.data,
          mimeType: part.mediaType,
          type: "audio",
        },
      ];
    case "resource":
      return [
        {
          type: "resource",
          resource: {
            mimeType: part.mediaType,
            text:
              part.text ??
              (part.value === undefined
                ? ""
                : JSON.stringify(part.value, null, 2)),
            uri: part.uri,
          },
        },
      ];
    case "json":
      return [
        {
          type: "text",
          text: JSON.stringify(part.value, null, 2),
        },
      ];
    default:
      return assertNever(part);
  }
}

function isPromptMessage(
  value:
    | import("../core/types.js").AcpRuntimePromptPart
    | import("../core/types.js").AcpRuntimePromptMessage,
): value is import("../core/types.js").AcpRuntimePromptMessage {
  return "role" in value;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ACP prompt value: ${JSON.stringify(value)}`);
}
