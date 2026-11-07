// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  computeNextImapCursor,
  deriveExternalThreadId,
  extractImapAttachments,
  imapConnectError,
  imapProviderId,
  normalizeImapMessage,
  parseImapHeaders,
  readImapBody,
} from "~/modules/apps/sandbox/imap-bridge"
import { classifyInbound } from "~/modules/mail/classify-inbound"

/** Build an async-iterable IMAP-body stream from fixed-size chunks. */
function fakeBodyStream(chunkSizes: number[]): AsyncIterable<Uint8Array> & {
  destroyed: boolean
  destroy: (err?: Error) => void
} {
  const stream = {
    destroyed: false,
    destroy(_err?: Error) {
      this.destroyed = true
    },
    async *[Symbol.asyncIterator]() {
      for (const size of chunkSizes) {
        if (stream.destroyed) return
        yield new Uint8Array(size)
      }
    },
  }
  return stream
}

describe("computeNextImapCursor", () => {
  const INF = Number.POSITIVE_INFINITY

  it("advances to the max successful UID when there are no failures", () => {
    // Out-of-order arrival: max success (12) drives the cursor, not last-seen.
    expect(computeNextImapCursor(0, 12, INF)).toBe(12)
  })

  it("does not advance past a failed UID — the failed UID is retried", () => {
    // UID 8 failed; successes up to 7. Cursor must stay below 8 so 8 is refetched.
    expect(computeNextImapCursor(0, 7, 8)).toBe(7)
  })

  it("holds the cursor below the failure even when a higher UID succeeded", () => {
    // Out-of-order: UID 5 failed but UID 9 succeeded. Advancing to 9 would skip
    // 5 forever; the cursor must not pass minFailedUid - 1.
    expect(computeNextImapCursor(0, 9, 5)).toBe(4)
  })

  it("never regresses below the incoming cursor", () => {
    expect(computeNextImapCursor(20, 0, INF)).toBe(20)
    expect(computeNextImapCursor(20, 0, 25)).toBe(24)
  })
})

describe("deriveExternalThreadId", () => {
  it("uses first Message-ID from References header when present", () => {
    const result = deriveExternalThreadId(
      "<root@example.com> <reply@example.com>",
      "<reply@example.com>",
      "<self@example.com>",
    )

    expect(result).toBe("<root@example.com>")
  })

  it("falls back to In-Reply-To when no References", () => {
    const result = deriveExternalThreadId(undefined, "<parent@example.com>", "<self@example.com>")
    expect(result).toBe("<parent@example.com>")
  })

  it("uses own Message-ID when no References or In-Reply-To", () => {
    const result = deriveExternalThreadId(undefined, undefined, "<standalone@example.com>")
    expect(result).toBe("<standalone@example.com>")
  })

  it("handles malformed References (empty string)", () => {
    const result = deriveExternalThreadId("", undefined, "<self@example.com>")
    expect(result).toBe("<self@example.com>")
  })

  it("handles References with single entry", () => {
    const result = deriveExternalThreadId("<only@example.com>", undefined, "<self@example.com>")
    expect(result).toBe("<only@example.com>")
  })
})

describe("extractImapAttachments", () => {
  it("returns empty array when there are no attachments", () => {
    expect(extractImapAttachments({})).toEqual([])
    expect(extractImapAttachments({ attachments: [] })).toEqual([])
  })

  it("extracts a named attachment with bytes", () => {
    const bytes = Buffer.from("hello-bytes")
    const result = extractImapAttachments({
      attachments: [
        {
          filename: "doc.pdf",
          contentType: "application/pdf",
          size: bytes.byteLength,
          content: bytes,
          contentDisposition: "attachment",
        },
      ],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.filename).toBe("doc.pdf")
    expect(result[0]?.mimeType).toBe("application/pdf")
    expect(result[0]?.disposition).toBe("attachment")
    expect(result[0]?.sizeBytes).toBe(bytes.byteLength)
    expect(Buffer.from(result[0]?.bytesBase64 ?? "", "base64").toString()).toBe("hello-bytes")
  })

  it("extracts an inline attachment with a content-id", () => {
    const bytes = Buffer.from("png-bytes")
    const result = extractImapAttachments({
      attachments: [
        {
          filename: "logo.png",
          contentType: "image/png",
          content: bytes,
          contentDisposition: "inline",
          cid: "logo@x.test",
        },
      ],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.disposition).toBe("inline")
    expect(result[0]?.contentId).toBe("logo@x.test")
  })

  it("skips attachments without a filename", () => {
    const result = extractImapAttachments({
      attachments: [
        {
          contentType: "application/octet-stream",
          content: Buffer.from("data"),
        },
      ],
    })
    expect(result).toHaveLength(0)
  })

  it("skips attachments that exceed the per-attachment byte cap", () => {
    const bigBytes = Buffer.alloc(26 * 1024 * 1024) // 26 MB > 25 MB cap
    const result = extractImapAttachments({
      attachments: [
        {
          filename: "huge.bin",
          contentType: "application/octet-stream",
          content: bigBytes,
        },
      ],
    })
    expect(result).toHaveLength(0)
  })

  it("handles multiple attachments, skipping over-cap ones", () => {
    const small = Buffer.from("small")
    const big = Buffer.alloc(26 * 1024 * 1024)
    const result = extractImapAttachments({
      attachments: [
        { filename: "small.txt", contentType: "text/plain", content: small },
        { filename: "big.bin", contentType: "application/octet-stream", content: big },
      ],
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.filename).toBe("small.txt")
  })
})

describe("parseImapHeaders", () => {
  const raw = [
    "List-Id: News <news.client.test>",
    "Content-Type: multipart/report;",
    '\treport-type=disposition-notification; boundary="b1"',
    "Auto-Submitted: auto-replied",
    "X-Thing: one",
    "X-Thing: two",
    "",
    "",
  ].join("\r\n")

  it("reads a fetched header block into a lowercased, unfolded map", () => {
    expect(parseImapHeaders(Buffer.from(raw))).toEqual({
      "list-id": "News <news.client.test>",
      "content-type": 'multipart/report; report-type=disposition-notification; boundary="b1"',
      "auto-submitted": "auto-replied",
      "x-thing": "one, two",
    })
  })

  it("no block is no headers, and a stored map stays as it is", () => {
    expect(parseImapHeaders(undefined)).toEqual({})
    expect(parseImapHeaders({ "list-id": "a" })).toEqual({ "list-id": "a" })
  })

  it("an IMAP newsletter and a read receipt do not read as a reply", () => {
    const newsletter = parseImapHeaders(Buffer.from("List-Unsubscribe: <mailto:u@client.test>\r\n"))
    expect(classifyInbound(newsletter, "Our news", "Hello", "news@client.test")).toBe("ignored")
    const receipt = parseImapHeaders(
      Buffer.from("Content-Type: multipart/report; report-type=disposition-notification\r\n"),
    )
    expect(classifyInbound(receipt, "Read: your order", "", "client@client.test")).toBe("ignored")
    expect(classifyInbound({}, "Read: your order", "", "client@client.test")).toBe("reply")
  })
})

describe("normalizeImapMessage", () => {
  const baseMsg = {
    uid: 42,
    envelope: {
      messageId: "<msg42@example.com>",
      from: [{ name: "Alice", address: "alice@example.com" }],
      to: [{ name: "Bob", address: "bob@example.com" }],
      cc: [],
      bcc: [],
      subject: "Test Subject",
      date: new Date("2026-01-15T10:00:00Z"),
      inReplyTo: undefined as string | undefined,
      references: undefined as string | undefined,
    },
    bodyStructure: { type: "text/plain" },
    textBody: "Hello world",
    htmlBody: "",
    flags: new Set<string>(),
  }

  it("normalizes a basic IMAP message", () => {
    const result = normalizeImapMessage(baseMsg, 12345)
    expect(result.externalMessageId).toBe("<msg42@example.com>")
    expect(result.externalProviderId).toBe("42")
    expect(result.from.email).toBe("alice@example.com")
    expect(result.to[0].email).toBe("bob@example.com")
    expect(result.subject).toBe("Test Subject")
    expect(result.textBody).toBe("Hello world")
    expect(result.isRead).toBe(false)
    expect(result.isStarred).toBe(false)
  })

  it("gives a message with no Message-ID an id unique to its folder and UID generation", () => {
    const msg = { ...baseMsg, envelope: { ...baseMsg.envelope, messageId: undefined } }
    expect(normalizeImapMessage(msg, 7).externalMessageId).toBe("<unknown-7-42>")
    expect(normalizeImapMessage(msg, 8).externalMessageId).toBe("<unknown-8-42>")
    expect(normalizeImapMessage(msg, 7, "sent").externalMessageId).toBe("<unknown-sent-7-42>")
  })

  it("maps \\Seen flag to isRead", () => {
    const msg = { ...baseMsg, flags: new Set(["\\Seen"]) }
    const result = normalizeImapMessage(msg, 12345)
    expect(result.isRead).toBe(true)
  })

  it("maps \\Flagged flag to isStarred", () => {
    const msg = { ...baseMsg, flags: new Set(["\\Flagged"]) }
    const result = normalizeImapMessage(msg, 12345)
    expect(result.isStarred).toBe(true)
  })

  it("derives threadId from References header", () => {
    const msg = {
      ...baseMsg,
      envelope: { ...baseMsg.envelope, references: "<root@ex.com> <mid@ex.com>" },
    }
    const result = normalizeImapMessage(msg, 12345)
    expect(result.externalThreadId).toBe("<root@ex.com>")
  })

  it("generates snippet from textBody (max 200 chars)", () => {
    const longBody = "A".repeat(300)
    const msg = { ...baseMsg, textBody: longBody }
    const result = normalizeImapMessage(msg, 12345)
    expect(result.snippet.length).toBe(200)
  })

  it("includes uidValidity in result context", () => {
    const result = normalizeImapMessage(baseMsg, 99999)
    expect(result.externalProviderId).toBe("42")
  })

  it("carries pre-extracted attachments through when provided", () => {
    const att = {
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
      bytesBase64: Buffer.from("pdf").toString("base64"),
      disposition: "attachment" as const,
    }
    const msg = { ...baseMsg, attachments: [att] }
    const result = normalizeImapMessage(msg, 12345)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments?.[0]?.filename).toBe("invoice.pdf")
  })

  it("leaves attachments undefined when not provided", () => {
    const result = normalizeImapMessage(baseMsg, 12345)
    expect(result.attachments).toBeUndefined()
  })
})

describe("readImapBody", () => {
  it("reads a body under the cap into a single buffer", async () => {
    const stream = fakeBodyStream([100, 200, 50])
    const { buffer, bytesRead } = await readImapBody(stream, {
      maxBodyBytes: 1_000,
      remainingBatchBytes: 10_000,
    })
    expect(bytesRead).toBe(350)
    expect(buffer).not.toBeNull()
    expect(buffer?.byteLength).toBe(350)
    expect(stream.destroyed).toBe(false)
  })

  it("drops the body and destroys the stream when the per-message cap is exceeded", async () => {
    const stream = fakeBodyStream([600, 600])
    const { buffer } = await readImapBody(stream, {
      maxBodyBytes: 1_000,
      remainingBatchBytes: 10_000,
    })
    expect(buffer).toBeNull()
    expect(stream.destroyed).toBe(true)
  })

  it("drops the body when the remaining aggregate batch budget is exceeded", async () => {
    const stream = fakeBodyStream([400, 400])
    const { buffer } = await readImapBody(stream, {
      maxBodyBytes: 1_000_000,
      remainingBatchBytes: 500,
    })
    expect(buffer).toBeNull()
    expect(stream.destroyed).toBe(true)
  })

  it("stops iterating after the cap is hit (does not buffer the whole stream)", async () => {
    // 1MB chunks; cap at 1MB means the second chunk trips the limit and the
    // stream is destroyed before yielding a third.
    const stream = fakeBodyStream([1_000_000, 1_000_000, 1_000_000])
    const { buffer } = await readImapBody(stream, {
      maxBodyBytes: 1_000_000,
      remainingBatchBytes: 100_000_000,
    })
    expect(buffer).toBeNull()
    expect(stream.destroyed).toBe(true)
  })
})

describe("a refused IMAP sign-in", () => {
  it("is stored with its reason from the closed set", () => {
    expect(
      imapConnectError({
        message: "Command failed",
        responseText:
          "[ALERT] Application-specific password required: https://support.google.com/x",
        authenticationFailed: true,
      }).message,
    ).toBe("IMAP authentication failed: app_password_required")
    expect(
      imapConnectError({
        message: "Authentication failed",
        serverResponseCode: "AUTHENTICATIONFAILED",
      }).message,
    ).toBe("IMAP authentication failed: wrong_password")
    expect(imapConnectError({ responseText: "Too many simultaneous connections." }).message).toBe(
      "IMAP too many connections",
    )
    expect(imapConnectError({ message: "IMAP connection timeout" }).message).toBe("IMAP timeout")
    expect(imapConnectError({ message: "ECONNREFUSED" }).message).toBe(
      "IMAP connection refused: ECONNREFUSED",
    )
  })
})

describe("a Sent-folder message", () => {
  it("is outbound-labelled and keyed apart from INBOX UIDs", () => {
    const msg = normalizeImapMessage(
      { uid: 5, envelope: { messageId: "<s@x>" }, flags: new Set(["\\Seen"]) },
      1,
      "sent",
    )
    expect(msg.externalProviderId).toBe("sent:5")
    expect(msg.labels).toEqual(["SENT"])
    expect(imapProviderId(5, "inbox")).toBe("5")
  })
})
