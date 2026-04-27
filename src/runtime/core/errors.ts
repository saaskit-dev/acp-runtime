export abstract class AcpError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AcpCreateError extends AcpError {
  readonly code: string = "CREATE_ERROR";
}

export class AcpForkError extends AcpError {
  readonly code: string = "FORK_ERROR";
}

export class AcpLoadError extends AcpError {
  readonly code: string = "LOAD_ERROR";
}

export class AcpListError extends AcpError {
  readonly code: string = "LIST_ERROR";
}

export class AcpResumeError extends AcpError {
  readonly code: string = "RESUME_ERROR";
}

export class AcpProtocolError extends AcpError {
  readonly code: string = "PROTOCOL_ERROR";
}

export class AcpProcessError extends AcpError {
  readonly code: string = "PROCESS_ERROR";
}

export class AcpAuthenticationError extends AcpError {
  readonly code: string = "AUTHENTICATION_ERROR";
}

export class AcpInitialConfigError extends AcpError {
  readonly code: string = "INITIAL_CONFIG_ERROR";
}

export class AcpSystemPromptError extends AcpError {
  readonly code: string = "SYSTEM_PROMPT_ERROR";
}

export class AcpPermissionError extends AcpError {
  readonly code: string = "PERMISSION_ERROR";
}

export class AcpPermissionDeniedError extends AcpPermissionError {
  override readonly code = "PERMISSION_DENIED";
}

export class AcpTurnCancelledError extends AcpError {
  readonly code: string = "TURN_CANCELLED";
}

export class AcpTurnCoalescedError extends AcpError {
  readonly code: string = "TURN_COALESCED";

  constructor(
    message: string,
    readonly intoTurnId: string,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class AcpTurnWithdrawnError extends AcpError {
  readonly code: string = "TURN_WITHDRAWN";
}

export class AcpTurnTimeoutError extends AcpError {
  readonly code: string = "TURN_TIMEOUT";
}
