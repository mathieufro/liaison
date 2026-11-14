// SPDX-License-Identifier: FSL-1.1-ALv2
import { normalizeAppPassword } from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import { validateExternalHost } from "~/modules/apps/sandbox/host-validation"

const log = rootLogger.child({ module: "smtp-bridge" })
const SMTP_SEND_TIMEOUT_MS = 30_000

/** Recipient shape accepted by `buildSmtpMessage`. We accept either a bare
 *  email string OR the `{ name, email }` shape that mail.* tools produce when
 *  reading rows out of `app_mail.messages.from_address` / `to_addresses`. The
 *  latter must be normalized to nodemailer's `{ name, address }` form before
 *  it reaches the transport — otherwise nodemailer JSON-stringifies the object
 *  and the resulting envelope address ends up looking like `<email}>`. */
export type SmtpAddress = string | { name?: string; email: string }

export interface SmtpSendParams {
  from: string
  to: SmtpAddress[]
  cc?: SmtpAddress[]
  bcc?: SmtpAddress[]
  /** RFC5322 Reply-To address. Tickets uses this to embed the per-ticket
   *  `<localpart>+tkt_<token>@<domain>` reply-token so customer responses
   *  route back to the ticket via the inbound matcher (spec SC2). */
  replyTo?: SmtpAddress
  subject: string
  htmlBody: string
  textBody: string
  /** RFC5322 Message-Id, e.g. `<tkt-…@org.test>`. If omitted, nodemailer
   *  generates one. Tickets supplies its own so the row's
   *  `external_message_id` matches what was actually sent. */
  messageId?: string
  inReplyTo?: string
  references?: string[]
  /** Extra headers: only a commercial mail's `List-Unsubscribe` and
   *  `List-Unsubscribe-Post` pass; any other name is dropped. */
  headers?: Record<string, string>
  /** Outbound attachments — base64 bytes, forwarded to nodemailer. */
  attachments?: Array<{
    filename: string
    mimeType: string
    bytesBase64: string
    disposition?: "inline" | "attachment"
    contentId?: string
  }>
}

function normalizeRecipient(addr: SmtpAddress): string | { name?: string; address: string } {
  if (typeof addr === "string") return addr
  if (!addr || typeof addr.email !== "string") {
    throw new Error("SMTP recipient missing required `email` field")
  }
  return addr.name ? { name: addr.name, address: addr.email } : addr.email
}

function normalizeRecipients(addrs: SmtpAddress[] | undefined) {
  return addrs?.map(normalizeRecipient) ?? []
}

/** The extra headers an app's send may set on this transport. */
const SMTP_EXTRA_HEADERS = ["List-Unsubscribe", "List-Unsubscribe-Post"] as const

export function buildSmtpMessage(params: SmtpSendParams) {
  const message: Record<string, any> = {
    from: params.from,
    to: normalizeRecipients(params.to),
    subject: params.subject,
    html: params.htmlBody,
    text: params.textBody,
  }

  const cc = normalizeRecipients(params.cc)
  const bcc = normalizeRecipients(params.bcc)
  if (cc.length) message.cc = cc
  if (bcc.length) message.bcc = bcc
  if (params.replyTo) message.replyTo = normalizeRecipient(params.replyTo)
  if (params.messageId) message.messageId = params.messageId
  if (params.inReplyTo) message.inReplyTo = params.inReplyTo
  if (params.references?.length) message.references = params.references.join(" ")
  const headers: Record<string, string> = {}
  for (const name of SMTP_EXTRA_HEADERS) {
    const value = params.headers?.[name]
    if (typeof value === "string" && value.trim() !== "") {
      headers[name] = value.replace(/[\r\n]+/g, " ").trim()
    }
  }
  if (Object.keys(headers).length > 0) message.headers = headers

  if (params.attachments?.length) {
    // nodemailer owns header encoding on this transport path: it RFC 2231-
    // encodes non-ASCII `filename`s and escapes the Content-Disposition header,
    // so the raw (attacker-controllable) filename is safe to hand over here.
    // The denylist + CR/LF stripping already ran upstream in `attachFileToParent`
    // / `isBlockedFileType`. (The non-nodemailer path encodes via `toRfc2822`.)
    message.attachments = params.attachments.map((a) => ({
      filename: a.filename,
      content: a.bytesBase64,
      encoding: "base64",
      contentType: a.mimeType,
      ...(a.disposition === "inline" && a.contentId ? { cid: a.contentId } : {}),
    }))
  }

  return message
}

/**
 * The RFC 5322 bytes of a message as it was sent (same Message-ID, Bcc kept),
 * for the copy filed in the mailbox's Sent folder.
 */
export async function buildRawSentMessage(
  params: SmtpSendParams,
  messageId: string,
): Promise<Buffer> {
  const { default: MailComposer } = await import("nodemailer/lib/mail-composer")
  const node = new MailComposer({ ...buildSmtpMessage(params), messageId }).compile()
  ;(node as unknown as { keepBcc: boolean }).keepBcc = true
  return node.build()
}

export type SmtpDeliveryState = "delivered" | "ambiguous" | "rejected" | "unknown"

/**
 * Classify the true delivery state from nodemailer's per-recipient envelope
 * result. A partial rejection (some recipients refused) must surface as
 * `ambiguous`, and a total rejection (no recipient accepted) as `rejected` —
 * never as a blanket `delivered`, which would silently hide undelivered mail.
 */
export function classifyDeliveryState(
  accepted: readonly unknown[],
  rejected: readonly unknown[],
): SmtpDeliveryState {
  if (accepted.length === 0) return "rejected"
  if (rejected.length > 0) return "ambiguous"
  return "delivered"
}

export type SmtpSendResult = {
  messageId: string
  deliveryState: SmtpDeliveryState
  /**
   * True when the send was recorded in place and never put on the wire: a demo
   * workspace's mail to its fictional recipients. Nobody received it.
   */
  captured?: true
}

export async function smtpSend(
  credentials: { host: string; port: number; username: string; password: string },
  params: SmtpSendParams,
): Promise<SmtpSendResult> {
  const validatedHost = await validateExternalHost(credentials.host, "SMTP")

  // Dev/test escape hatch — when ALLOW_PRIVATE_MAIL_HOSTS=true (non-prod only),
  // allow plaintext SMTP so tests can drive in-process fixtures without TLS certs.
  // The host validator already restricts this flag to non-production environments.
  const allowPlaintext =
    process.env.NODE_ENV !== "production" && process.env.ALLOW_PRIVATE_MAIL_HOSTS === "true"

  const nodemailer = await import("nodemailer")
  const transport = nodemailer.createTransport({
    host: validatedHost.address,
    port: credentials.port,
    secure: credentials.port === 465,
    auth: { user: credentials.username, pass: normalizeAppPassword(credentials.password) },
    connectionTimeout: SMTP_SEND_TIMEOUT_MS,
    socketTimeout: SMTP_SEND_TIMEOUT_MS,
    requireTLS: !allowPlaintext && credentials.port !== 465,
    ignoreTLS: allowPlaintext,
    tls: validatedHost.servername
      ? { servername: validatedHost.servername, minVersion: "TLSv1.2" }
      : { minVersion: "TLSv1.2" },
  })

  try {
    const info = await transport.sendMail(buildSmtpMessage(params))
    // nodemailer reports per-recipient results in `accepted`/`rejected`. A
    // partial rejection (some recipients refused) must NOT be reported as a
    // full `delivered` — that silently loses the fact the message never reached
    // some intended recipients. Derive the true state from the envelope result.
    const accepted = Array.isArray((info as { accepted?: unknown }).accepted)
      ? (info as { accepted: unknown[] }).accepted
      : []
    const rejected = Array.isArray((info as { rejected?: unknown }).rejected)
      ? (info as { rejected: unknown[] }).rejected
      : []
    const deliveryState = classifyDeliveryState(accepted, rejected)
    if (deliveryState !== "delivered") {
      log.warn(
        { messageId: info.messageId, accepted: accepted.length, rejected: rejected.length },
        "SMTP partial/total recipient rejection",
      )
    }
    return { messageId: info.messageId, deliveryState }
  } catch (err: unknown) {
    const e = err as {
      message?: string
      code?: string
      responseCode?: number
      response?: string
    }
    if (e.code === "EAUTH") {
      const error = new Error("SMTP authentication failed") as Error & {
        deliveryState?: SmtpDeliveryState
      }
      error.deliveryState = "rejected"
      throw error
    }
    if (e.code === "ECONNREFUSED" || e.code === "ETIMEDOUT" || e.code === "ESOCKET") {
      const error = new Error(`SMTP connection failed: ${e.message ?? e.code}`) as Error & {
        deliveryState?: SmtpDeliveryState
      }
      error.deliveryState = "unknown"
      throw error
    }
    if (e.responseCode && e.responseCode >= 500) {
      const error = new Error(`SMTP rejected recipient: ${e.response ?? e.message}`) as Error & {
        deliveryState?: SmtpDeliveryState
      }
      error.deliveryState = "rejected"
      throw error
    }
    if (e.responseCode && e.responseCode >= 400 && e.responseCode < 500) {
      const error = new Error(
        `SMTP transient failure (${e.responseCode}): ${e.response ?? e.message}`,
      ) as Error & { deliveryState?: SmtpDeliveryState }
      error.deliveryState = "unknown"
      throw error
    }
    const error = new Error(`SMTP send failed: ${e.message}`) as Error & {
      deliveryState?: SmtpDeliveryState
    }
    error.deliveryState = "unknown"
    throw error
  } finally {
    try {
      transport.close()
    } catch (err) {
      log.debug({ err }, "SMTP transport close failed")
    }
  }
}
