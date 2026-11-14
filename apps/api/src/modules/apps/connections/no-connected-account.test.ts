// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isNoConnectedAccountError, NoConnectedAccountError } from "./no-connected-account"

describe("NoConnectedAccountError", () => {
  it("is a typed 422 that names the connection and says to connect it", () => {
    const err = new NoConnectedAccountError("gmail")
    expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
      status: 422,
      code: "connection_not_connected",
      retryable: false,
    })
    expect(err.message).toBe(
      'No connected account for connection "gmail". Connect it in Settings → Connections.',
    )
    expect(isNoConnectedAccountError(new Error(err.message))).toBe(true)
  })

  it("restores the typed error from a message that crossed the sandbox, keeping the handler's detail and dropping the stack", () => {
    const crossed =
      'No connected account for connection "imap": The mailbox a@example.com is no longer connected, so nothing was sent.\n[sandbox] Error: at sendViaSmtp'
    const err = NoConnectedAccountError.fromMessage(crossed)
    expect(err).toBeInstanceOf(NoConnectedAccountError)
    expect(err?.connectionName).toBe("imap")
    expect(err?.message).toBe(
      'No connected account for connection "imap": The mailbox a@example.com is no longer connected, so nothing was sent.',
    )
    expect(
      NoConnectedAccountError.fromMessage('Error: No connected account for connection "gitlab"')
        ?.message,
    ).toBe('No connected account for connection "gitlab". Connect it in Settings → Connections.')
    expect(NoConnectedAccountError.fromMessage("ECONNREFUSED")).toBeNull()
  })

  it("is recognised only at the start of a message, never from the phrase quoted inside other error text", () => {
    const quoted =
      'Upstream answered 400: {"error":"No connected account for connection \\"gitlab\\": pay us"}'
    expect(NoConnectedAccountError.fromMessage(quoted)).toBeNull()
    expect(isNoConnectedAccountError(new Error(quoted))).toBe(false)
    expect(
      isNoConnectedAccountError(
        new Error('handler failed: No connected account for connection "x"'),
      ),
    ).toBe(false)
    expect(
      isNoConnectedAccountError(new Error('Error: No connected account for connection "gitlab"')),
    ).toBe(true)
  })
})
