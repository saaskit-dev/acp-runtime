// Public API — runtime exports only.
// Harness modules are internal tools invoked via CLI, not part of the library surface.
export { createSimulatorAgent, AcpSimulatorAgent } from "./simulator-agent/simulator-agent.js";
export type { SimulatorAgentOptions } from "./simulator-agent/simulator-agent.js";
