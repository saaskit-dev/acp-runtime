// Public API — runtime exports only.
// Harness modules are internal tools invoked via CLI, not part of the library surface.
export {
  ACP_PROTOCOL_ALIGNMENT_VERIFIED_AT,
  ACP_PROTOCOL_DOCS_SCHEMA_URL,
  ACP_PROTOCOL_DOCS_URL,
  ACP_PROTOCOL_SOURCE_REF,
  ACP_PROTOCOL_SOURCE_REPO,
  ACP_PROTOCOL_VERSION,
  createSimulatorAgentAcp,
  SimulatorAgentAcp,
} from "./simulator-agent/simulator-agent.js";
export type { SimulatorAgentAcpOptions } from "./simulator-agent/simulator-agent.js";
