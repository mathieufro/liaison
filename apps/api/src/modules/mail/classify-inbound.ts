// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What an inbound mail says about a send that is waiting: a person answered, the
 * address failed, a machine answered for someone away, or nothing at all. Pure
 * and free of imports, so the send check can call it on a privileged read.
 *
 * The rules start from `isBulkMessage` (page-write.ts) and `detectAutoResponder`
 * (apps/tickets/inbound-auto-responder.ts) and differ where those two ask another
 * question. `multipart/report` also covers read receipts and delay notices, and
 * Outlook sets `x-auto-response-suppress` on mail a person typed.
 *
 * A sealed mailbox stores no subject and no body but keeps `auto-submitted`,
 * `precedence`, `list-*`, `content-type` and `in-reply-to` in clear (the header
 * allowlist). So a sealed auto-reply still reads as one, and a sealed mail with
 * none of them reads as a reply, which stops the send: the safe side.
 */

export type InboundKind = "reply" | "bounce" | "auto_reply" | "ignored"

const AUTO_REPLY_SUBJECT =
  /^(?:out of office|automatic reply|auto.?reply|absence|réponse automatique|absent)(?![\p{L}\p{N}])/iu

const BOUNCE_SENDERS = new Set(["mailer-daemon", "postmaster"])

const ACTION_FIELD = /^[ \t]*action[ \t]*:[ \t]*([a-z-]+)/gim

/** The delivery report actions that do not say the mail failed (RFC 3464). */
const NOT_A_FAILURE = new Set(["delayed", "delivered", "relayed", "expanded"])

/**
 * Gmail mail stores only the text and HTML parts, so a delivery report arrives
 * here without its `Action:` field. Only the wording of the common mail servers
 * is left to tell a delay from a failure, in English and French. Anything not
 * named, in any language, reads as a failure, which stops the send.
 */
const DELAY_SUBJECT =
  /^(?:delivery status notification \(delay\)|delayed mail\b|delivery delayed\b|warning: (?:message .*delayed|could not send message)|remise (?:différée|retardée)|distribution retardée|retard de (?:remise|distribution)|retardée? ?:)/i
const DELAY_BODY =
  /\b(?:this is a warning only|will retry for \d|still being retried|delivery is delayed to these recipients)\b|ceci est un simple avertissement|(?:la remise|l'envoi|la distribution) (?:de ce message )?(?:a été|est) (?:retardée?|différée?)|nouvelles? tentatives? (?:de remise|d'envoi|de distribution)/i

function headerValues(raw: unknown, name: string): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (key.toLowerCase() !== name) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string") out.push(...unpackSealedList(item))
    }
  }
  return out.map((value) => value.trim()).filter((value) => value !== "")
}

/** Sealing writes a retained header that was a list as its JSON text. */
function unpackSealedList(value: string): string[] {
  if (!value.startsWith("[")) return [value]
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string")
  } catch {
    // Not JSON: an ordinary value that happens to start with a bracket.
  }
  return [value]
}

function senderLocalPart(sender: string): string {
  const address = /<([^>]*)>\s*$/.exec(sender)?.[1] ?? sender
  return (address.split("@")[0] ?? "").trim().replace(/^"|"$/g, "").toLowerCase()
}

/** A delivery report that says nothing failed yet: delayed, delivered or relayed. */
function isNoFailureNotice(subject: string | null, textBody: string | null): boolean {
  const actions = [...(textBody ?? "").matchAll(ACTION_FIELD)].map((m) => m[1]?.toLowerCase())
  if (actions.length > 0) return actions.every((action) => NOT_A_FAILURE.has(action ?? ""))
  return DELAY_SUBJECT.test(subject ?? "") || DELAY_BODY.test(textBody ?? "")
}

/**
 * @param headers the stored header map, whatever shape it holds; `{}` when none
 * @param subject null on a sealed mailbox
 * @param textBody null on a sealed mailbox, and when the mail has no text part
 * @param sender the envelope sender, read from the `from` header when not given
 */
export function classifyInbound(
  headers: unknown,
  subject: string | null,
  textBody: string | null,
  sender?: string | null,
): InboundKind {
  const header = (name: string) => headerValues(headers, name)
  const contentType = header("content-type")[0] ?? ""

  // Reports first: a mail server sets `auto-submitted` on them, and sends them
  // from `mailer-daemon`, so the rules below would read them wrongly.
  if (/^multipart\/report\b/i.test(contentType)) {
    const reportType = /;\s*report-type\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1]?.toLowerCase()
    if (reportType === "disposition-notification") return "ignored"
    if (reportType === "delivery-status") {
      return isNoFailureNotice(subject, textBody) ? "ignored" : "bounce"
    }
  }

  const senderName = sender || (header("from")[0] ?? "")
  if (BOUNCE_SENDERS.has(senderLocalPart(senderName))) {
    return isNoFailureNotice(subject, textBody) ? "ignored" : "bounce"
  }

  const precedence = header("precedence").map((value) => value.toLowerCase())
  const autoSubmitted = header("auto-submitted").some(
    (value) => value.split(/[;,\s]/)[0]?.toLowerCase() !== "no",
  )
  if (
    autoSubmitted ||
    precedence.includes("auto_reply") ||
    header("x-autoreply").length > 0 ||
    header("x-autorespond").length > 0 ||
    (header("x-auto-response-suppress").length > 0 && header("in-reply-to").length === 0) ||
    AUTO_REPLY_SUBJECT.test((subject ?? "").normalize("NFC").trim())
  ) {
    return "auto_reply"
  }

  if (
    header("list-id").length > 0 ||
    header("list-unsubscribe").length > 0 ||
    precedence.some((value) => value === "bulk" || value === "junk" || value === "list")
  ) {
    return "ignored"
  }

  return "reply"
}
