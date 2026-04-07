import { describe, expect, it } from "vitest";

import {
  ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT,
  ACP_PROTOCOL_DOCS_SCHEMA_URL,
  ACP_PROTOCOL_DOCS_URL,
  ACP_PROTOCOL_SOURCE_REF,
  ACP_PROTOCOL_SOURCE_REPO,
  ACP_PROTOCOL_VERSION,
} from "./index.js";

describe("public protocol alignment exports", () => {
  it("exports ACP protocol alignment metadata", () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
    expect(ACP_PROTOCOL_SOURCE_REPO).toBe("https://github.com/agentclientprotocol/agent-client-protocol");
    expect(ACP_PROTOCOL_SOURCE_REF).toBe("v0.11.4");
    expect(ACP_PROTOCOL_DOCS_URL).toBe("https://agentclientprotocol.com/protocol/overview");
    expect(ACP_PROTOCOL_DOCS_SCHEMA_URL).toBe("https://agentclientprotocol.com/protocol/draft/schema");
    expect(ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT).toBe("2026-04-08");
  });
});
