// SPDX-License-Identifier: FSL-1.1-ALv2

/** Error code: an app's connection has no active connected account (the person connects it). */
export const CONNECTION_NOT_CONNECTED = "connection_not_connected"

/**
 * The org (or user) has no active connected account for an app's connection:
 * nobody connected it, or it was disconnected. Not a fault to retry, and not a
 * server error: a typed 422 that says what to do, and a background job that
 * needs the account has nothing to do until someone connects one (the job
 * runner skips such a run quietly).
 *
 * The message prefix is load-bearing and stays exactly as it was: a sandboxed
 * handler's bridge call carries only its message back across the sandbox, and
 * callers recognise this case from it (`isNoConnectedAccountError`,
 * `NoConnectedAccountError.fromMessage`).
 */
export class NoConnectedAccountError extends Error {
  readonly status = 422
  readonly code = CONNECTION_NOT_CONNECTED
  readonly retryable = false
  /**
   * @param detail what this meant for the caller and its next step, in place of
   *   the generic "Connect it in Settings → Connections."
   */
  constructor(
    readonly connectionName: string,
    detail?: string,
  ) {
    super(
      `No connected account for connection "${connectionName}"${detail ? `: ${detail}` : ". Connect it in Settings → Connections."}`,
    )
    this.name = "NoConnectedAccountError"
  }

  /**
   * The typed error behind a message that crossed the sandbox, or null. A
   * handler's own detail after the prefix (`...: <detail>`) is kept; the
   * sandbox stack the executor appends is not.
   */
  static fromMessage(message: string): NoConnectedAccountError | null {
    const match = NO_CONNECTED_ACCOUNT_PARTS.exec(message)
    return match ? new NoConnectedAccountError(match[1] ?? "", match[2]?.trim() || undefined) : null
  }
}

// Anchored: the message starts with the prefix (after an `Error: ` the sandbox may put
// before it), so error text that only quotes the phrase (an upstream body, a handler's
// own wording) never becomes this typed error.
const NO_CONNECTED_ACCOUNT_MESSAGE = /^(?:\w*Error: )?No connected account for connection "/
const NO_CONNECTED_ACCOUNT_PARTS =
  /^(?:\w*Error: )?No connected account for connection "([^"]*)"(?:: ([^\n]*))?/

/** True for a `NoConnectedAccountError`, including one whose message crossed the sandbox. */
export function isNoConnectedAccountError(err: unknown): boolean {
  if (err instanceof NoConnectedAccountError) return true
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return NO_CONNECTED_ACCOUNT_MESSAGE.test(message)
}
