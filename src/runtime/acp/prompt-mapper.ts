import type { ContentBlock } from "@agentclientprotocol/sdk";

import type { AcpRuntimePrompt } from "../core/types.js";

export function mapPromptToAcp(prompt: AcpRuntimePrompt): ContentBlock[] {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }

  if (prompt.length === 0) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  for (const item of prompt) {
    if (isPromptMessage(item)) {
      const message = item;
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
      continue;
    }

    blocks.push(...mapPromptPartToAcp(item));
  }
  return blocks;
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
