import type {
  AcpRuntimeAgentConfigOption,
  AcpRuntimeAgentMode,
  AcpRuntimeCapabilities,
  AcpRuntimeDiagnostics,
  AcpRuntimeSessionMetadata,
  AcpRuntimePrompt,
  AcpRuntimeSessionStatus,
  AcpRuntimeSnapshot,
  AcpRuntimeStreamOptions,
  AcpRuntimeTurnCompletion,
  AcpRuntimeTurnEvent,
  AcpRuntimeTurnHandlers,
} from "./types.js";
import { AcpProtocolError } from "./errors.js";
import type { AcpSessionDriver } from "./session-driver.js";

export class AcpRuntimeSession {
  constructor(
    private readonly driver: AcpSessionDriver,
    private readonly options: {
      onSnapshotChanged?: ((snapshot: AcpRuntimeSnapshot) => Promise<void> | void) | undefined;
    } = {},
  ) {}

  get capabilities(): Readonly<AcpRuntimeCapabilities> {
    return this.driver.capabilities;
  }

  get diagnostics(): Readonly<AcpRuntimeDiagnostics> {
    return this.driver.diagnostics;
  }

  get metadata(): Readonly<AcpRuntimeSessionMetadata> {
    return this.driver.metadata;
  }

  get status(): AcpRuntimeSessionStatus {
    return this.driver.status;
  }

  listAgentConfigOptions(): readonly AcpRuntimeAgentConfigOption[] {
    return this.driver.listAgentConfigOptions();
  }

  listAgentModes(): readonly AcpRuntimeAgentMode[] {
    return this.driver.listAgentModes();
  }

  async cancel(): Promise<void> {
    await this.driver.cancel();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async setAgentConfigOption(
    id: string,
    value: string,
  ): Promise<void> {
    await this.driver.setAgentConfigOption(id, value);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  async setAgentMode(modeId: string): Promise<void> {
    await this.driver.setAgentMode(modeId);
    await this.options.onSnapshotChanged?.(this.driver.snapshot());
  }

  async run(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): Promise<string> {
    const completion = await this.send(prompt, undefined, options);
    return completion.outputText;
  }

  async send(
    prompt: AcpRuntimePrompt,
    handlers?: AcpRuntimeTurnHandlers,
    options?: AcpRuntimeStreamOptions,
  ): Promise<AcpRuntimeTurnCompletion> {
    let completion: AcpRuntimeTurnCompletion | undefined;
    let terminalSeen = false;
    for await (const event of this.stream(prompt, options)) {
      if (terminalSeen) {
        throw new AcpProtocolError(
          "Turn stream emitted events after a terminal event.",
        );
      }

      await handlers?.onEvent?.(event);
      if (event.type === "completed") {
        terminalSeen = true;
        completion = {
          output: event.output,
          outputText: event.outputText,
          turnId: event.turnId,
        };
      } else if (event.type === "failed") {
        throw event.error;
      }
    }

    if (!completion) {
      throw new AcpProtocolError("Turn stream ended without a terminal event.");
    }

    return completion;
  }

  snapshot(): AcpRuntimeSnapshot {
    return this.driver.snapshot();
  }

  stream(
    prompt: AcpRuntimePrompt,
    options?: AcpRuntimeStreamOptions,
  ): AsyncIterable<AcpRuntimeTurnEvent> {
    return this.driver.stream(prompt, options);
  }
}
