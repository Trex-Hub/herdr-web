/** A JSON-RPC error from core, with its stable `data.kind` and `data.hint`. */
export class CoreError extends Error {
  readonly code: number;
  readonly kind: string | undefined;
  readonly hint: string | undefined;

  constructor(error: { code: number; message: string; data?: { kind?: string; hint?: string } }) {
    super(error.message);
    this.name = "CoreError";
    this.code = error.code;
    this.kind = error.data?.kind;
    this.hint = error.data?.hint;
  }
}

/** The connection to core ended (or never came up) before a call was answered. */
export class ConnectionClosedError extends Error {
  constructor(message = "connection to core closed", options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionClosedError";
  }
}

/** A call was given a time limit and core did not answer within it. The connection itself is left alone. */
export class CoreTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Core did not answer (${method}, waited ${Math.round(timeoutMs / 1000)} s).`);
    this.name = "CoreTimeoutError";
  }
}
