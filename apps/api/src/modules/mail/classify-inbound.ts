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

/**
 * A delivery report that says nothing failed yet: only `Action: failed` (RFC 3464) is a
 * failure, so delayed, delivered, relayed and any other action are not.
 */
function isNoFailureNotice(subject: string | null, textBody: string | null): boolean {
  const actions = [...(textBody ?? "").matchAll(ACTION_FIELD)].map((m) => m[1]?.toLowerCase())
  if (actions.length > 0) return !actions.includes("failed")
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

/** An address as it appears in a report's text: a trailing full stop is punctuation. */
const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi

/** Where a report starts quoting the mail it is about. Nothing past it names a failed address. */
const ORIGINAL_MESSAGE =
  /^[ \t>*-]*(?:original message|message d'origine|message original|forwarded message|(?:below this line is |this is )?a copy of the (?:original )?message|original headers|en-têtes? du message)\b|^[ \t>]*(?:to|cc|bcc|from|de|à|subject|objet|date|received|return-path|message-id|dkim-signature|content-type)[ \t]*:/im

const RECIPIENT_FIELD = /^[ \t]*(?:final|original)-recipient[ \t]*:(.*)$/gim

/**
 * A report's HTML as plain text, for a report that has no text part. The result is only read
 * by these rules, never shown, and holds no `<` or `>` at all: tags go, and any bracket left
 * over (or written as an entity) becomes a space.
 */
export function htmlAsText(html: string | null): string | null {
  if (html === null) return null
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/&nbsp;|&#160;|&lt;|&gt;/gi, " ")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
}

/** The text a report reads by: its text part, or its HTML part when it has no text. */
export function reportText(textBody: string | null, htmlBody: string | null): string | null {
  if (textBody !== null && textBody.trim() !== "") return textBody
  return htmlAsText(htmlBody) ?? textBody
}

function addressesIn(text: string): string[] {
  return [...text.matchAll(ADDRESS)].map((m) => m[0].toLowerCase())
}

/**
 * The addresses a delivery report says failed. The machine part (`Final-Recipient` or
 * `Original-Recipient`, one group per recipient) wins when the text carries it, and a group
 * whose `Action` is not `failed` is left out. Without it, the addresses the report names
 * before it starts quoting the original mail. Quoted headers never name a failed address:
 * they list everyone the original went to. Empty when the report names none.
 */
export function failedRecipients(textBody: string | null, htmlBody: string | null): string[] {
  const text = reportText(textBody, htmlBody) ?? ""
  const failed = new Set<string>()
  let machine = false
  for (const group of text.split(/\r?\n[ \t]*\r?\n/)) {
    const fields = [...group.matchAll(RECIPIENT_FIELD)]
    if (fields.length === 0) continue
    machine = true
    const action = [...group.matchAll(ACTION_FIELD)][0]?.[1]?.toLowerCase()
    if (action !== undefined && action !== "failed") continue
    for (const field of fields) for (const a of addressesIn(field[1] ?? "")) failed.add(a)
  }
  if (machine) return [...failed]
  const marker = ORIGINAL_MESSAGE.exec(text)
  return [...new Set(addressesIn(marker ? text.slice(0, marker.index) : text))]
}

/**
 * Whether a delivery failure is about a draft to these addresses. The failed address must
 * be one of them. A report that names none (a sealed one, or one with no readable text) is
 * about them only when the mail it answers went to exactly one address, and that address
 * is one of them: a failure for one recipient of a group mail says nothing of the others.
 *
 * @param answered everyone the mail the report answers went to, or null when it answers
 *   none of ours
 */
export function reportConcerns(input: {
  textBody: string | null
  htmlBody: string | null
  answered: readonly string[] | null
  addresses: readonly string[]
}): boolean {
  const mine = new Set(input.addresses.map((a) => a.toLowerCase()))
  const failed = failedRecipients(input.textBody, input.htmlBody)
  if (failed.length > 0) return failed.some((a) => mine.has(a))
  const answered = [...new Set((input.answered ?? []).map((a) => a.toLowerCase()))]
  return answered.length === 1 && mine.has(answered[0] as string)
}
