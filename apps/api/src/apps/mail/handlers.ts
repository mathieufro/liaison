// SPDX-License-Identifier: FSL-1.1-ALv2
// Mail app handler bundle — TypeScript source, transpiled at load time for QuickJS
// Each export is an async function that receives (params/event, ctx)
// No imports allowed — bridge methods are injected via ctx at runtime
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

interface MailCtx {
  getUserId(): string
  getOrgId(): string
  db_findMany(entity: string, optsJson: string): Promise<string>
  db_findOne(entity: string, id: string): Promise<string>
  db_insert(entity: string, dataJson: string): Promise<string>
  db_update(entity: string, id: string, dataJson: string): Promise<void>
  db_updateMany(entity: string, optsJson: string): Promise<string>
  db_delete(entity: string, id: string): Promise<void>
  db_count(entity: string, optsJson: string): Promise<string>
  kernel_findOne(entity: string, id: string): Promise<string>
  emit(eventJson: string): Promise<void>
  enqueueJob(jobName: string, payloadJson: string, optsJson?: string): Promise<void>
  connections_getToken(connectionName: string, identifier?: string): Promise<string>
  connections_getAccounts(connectionName: string): Promise<string>
  /** `noticeJson`: `{ reason: "connect_refused", summary }`, told to the person who connected it. */
  connections_disconnect(connectionId: string, noticeJson?: string): Promise<void>
  hasScope(scope: string): Promise<boolean>
  /** Write one sync page in one host transaction (modules/mail/page-write.ts). */
  mail_writePage(paramsJson: string): Promise<string>
  /** The send check's value for a staged send (modules/mail/send-guard.ts). */
  mail_buildSendGuard(paramsJson: string): Promise<string>
  /** The send check on the payload as it stands, before anything leaves. */
  mail_checkSendGuard(paramsJson: string): Promise<string>
  /** Clear `ingest_pending` on messages whose post-commit work is done. */
  mail_completeIngest(paramsJson: string): Promise<string>
  /** Delete a disconnected mailbox's imported content (modules/mail/purge-account.ts). */
  mail_purgeDisconnectedAccount(accountId: string): Promise<string>
  /** Release another owner's stale mailbox row for a new connection (purge-account.ts). */
  mail_releaseForeignAccount(paramsJson: string): Promise<string>
  /** The workspace's mailbox providers, `{ gmail: boolean }` (modules/mail/provider-settings.ts). */
  mail_providersGet(): Promise<string>
  mail_providersSet(paramsJson: string): Promise<string>
  /** Apply label operations to a conversation's stored labels as one delta. */
  mail_applyLabelDelta(paramsJson: string): Promise<string>
  executeTool(toolName: string, paramsJson: string): Promise<string>
  mail_conversion_readConversation(conversationId: string): Promise<string>
  mail_conversion_markConverted(
    conversationId: string,
    ticketId: string,
    ticketHandle: string,
  ): Promise<string>
  mail_createFromTicket(paramsJson: string): Promise<string>
  mail_appendInboundMessage(
    conversationId: string,
    messageJson: string,
    idempotencyKey?: string,
  ): Promise<string>
  fetch(url: string, optsJson: string): Promise<string>
  mail_search(paramsJson: string): Promise<string>
  imap_fetch(connectionName: string, identifier: string, optsJson: string): Promise<string>
  /** Write a conversation's read / star / archive / trash state back over IMAP. */
  imap_writeBack?(connectionName: string, identifier: string, inputJson: string): Promise<string>
  smtp_send(connectionName: string, identifier: string, messageJson: string): Promise<string>
  hasOnlineUsers(accountId: string): Promise<string>
  /** Seal one plaintext to the mailbox owner's active identity key. The acting
   *  identity is NEVER a parameter: the host resolves it from the captured
   *  execution context and refuses when the account's owner is someone else.
   *  There is deliberately no counterpart that unseals. */
  mailbox_seal(paramsJson: string): Promise<string>
  /** Mint the row id, seal every named field under ONE content key with that id
   *  in the AAD, and insert, atomically. The only way a sealed row is created:
   *  the AAD must bind an id that exists, and the sandbox cannot supply one. */
  mailbox_sealAndInsert(paramsJson: string): Promise<string>
  /** Queue envelope-only headless work for the browser to run when the user is
   *  next online. Never carries a body, a subject or an excerpt. */
  mailbox_enqueueClientJob(paramsJson: string): Promise<string>
  config_get?(key: string): Promise<unknown>
  log_info(msg: string, dataJson?: string): void
  log_warn(msg: string, dataJson?: string): void
  log_error(msg: string, dataJson?: string): void
  log_debug(msg: string, dataJson?: string): void
  approval_recordStarted(toolName: string): Promise<void>
  approval_recordSucceeded(toolName: string, externalRefJson?: string): Promise<void>
  /** The provider accepted the send: durable before any post-send work, so a
   *  handler cut off afterwards is recorded as sent, never re-sent. */
  approval_recordEffectLanded?(toolName: string, externalRefJson: string): Promise<void>
  approval_recordFailedNoEffect(toolName: string, errJson: string): Promise<void>
  approval_recordAmbiguous(toolName: string, errJson: string): Promise<void>
  files_attachToParent?(argsJson: string): Promise<string>
  files_getAttachmentBytes?(argsJson: string): Promise<string>
  files_reparent?(argsJson: string): Promise<string>
  files_importAttachment?(argsJson: string): Promise<string>
  files_importFromUrl?(argsJson: string): Promise<string>
  files_listAttachments?(parentJson: string): Promise<string>
  approvals_pendingFor?(payloadKey: string, toolNamesJson?: string): Promise<string>
  codec_base64UrlEncodeUtf8?(text: string): Promise<string>
  codec_base64EncodeUtf8?(text: string): Promise<string>
  codec_markdownToEmail?(markdown: string): Promise<string>
}

interface MailAttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  disposition: "inline" | "attachment"
  contentId?: string | null
  analysisStatus?: string | null
  analysisSummary?: string | null
}

// Enumerate the kernel.files rows parented to a single mail message (the
// attachment store mail ingest writes into via files_importAttachment). Returns
// [] when the bridge is unavailable or the message has none — never throws, so a
// read of an attachment-less conversation degrades to an empty list rather than
// failing the whole read. Used to surface attachment file ids INSIDE mail:read
// so the agent can "pull the PDF" without guessing the (app, entityType,
// entityId) tuple for the generic files_list tool.
async function listMessageAttachments(
  messageId: string,
  ctx: MailCtx,
): Promise<MailAttachmentSummary[]> {
  if (!ctx.files_listAttachments) return []
  try {
    const raw = await ctx.files_listAttachments(
      JSON.stringify({ app: "mail", entityType: "message", entityId: messageId }),
    )
    const rows = JSON.parse(raw) as Array<{
      id: string
      filename: string
      mimeType: string
      sizeBytes: number
      disposition: "inline" | "attachment"
      contentId?: string | null
      analysisStatus?: string | null
      analysisSummary?: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      disposition: r.disposition,
      contentId: r.contentId ?? null,
      analysisStatus: r.analysisStatus ?? null,
      analysisSummary: r.analysisSummary ?? null,
    }))
  } catch (err) {
    ctx.log_warn(
      "mail.read attachment listing failed",
      JSON.stringify({ messageId, err: String(err) }),
    )
    return []
  }
}

interface PendingMailReplyDraft {
  approvalId: string
  textBody: string
  to: string[] | null
  cc: string[] | null
  createdAt: string
}

// The reply drafts still waiting for approval on this conversation. mail:reply keeps one per
// conversation: the agent edits the waiting one (kernel__approval_update_payload) instead of
// drafting another, so it must see it on mail:read first.
async function listPendingReplyDrafts(
  conversationId: string,
  ctx: MailCtx,
): Promise<PendingMailReplyDraft[]> {
  if (!ctx.approvals_pendingFor) return []
  try {
    const rows = JSON.parse(
      await ctx.approvals_pendingFor("conversationId", JSON.stringify(["mail:reply"])),
    ) as Array<{ id: string; target_id: string; payload: any; created_at: string }>
    return rows
      .filter((r) => r.target_id === conversationId)
      .reverse()
      .map((r) => ({
        approvalId: r.id,
        textBody: typeof r.payload?.textBody === "string" ? r.payload.textBody : "",
        to: Array.isArray(r.payload?.to) ? r.payload.to : null,
        cc: Array.isArray(r.payload?.cc) ? r.payload.cc : null,
        createdAt: r.created_at,
      }))
  } catch (err) {
    ctx.log_warn(
      "mail.read pending reply drafts lookup failed",
      JSON.stringify({ conversationId, err: String(err) }),
    )
    return []
  }
}

interface MailKernelConnectionEvent {
  orgId: string
  actorId: string
  data: {
    id: string
    appName: string
    ownerType: string
    ownerId: string | null
    identifier: string
    connectionName: string
  }
}

interface MailKernelDisconnectEvent {
  orgId: string
  data: { id: string; appName: string }
}

interface AccountRow {
  id: string
  connected_account_id: string
  owner_type: string
  owner_id: string | null
  provider: string
  email_address: string
  display_name: string | null
  sync_status: string
  sync_state?: any
  last_sync_at: string | null
  last_sync_error: string | null
  disconnected_at: string | null
  /** Mailbox encryption state. Absent on a row read before the column existed. */
  encryption_state?: string
}

interface KernelAccount {
  id: string
  displayName: string | null
  status: string
}

// Wrap externally-authored email text (an inbound message body / snippet the
// customer wrote) so the agent reads it as DATA, not instructions — the same
// untrusted-content fence web_search/web_fetch apply to fetched page text
// (modules/agent/tools/web-tools.ts `wrapExternalContent`). The mail handler bundle
// runs in QuickJS with NO imports allowed, so the helper is inlined here rather
// than imported. Pairs with the mail:read/mail:search `taintSource: true`
// manifest flag (the flag marks the thread tainted; this fences the content).
function wrapExternalContent(content: string): string {
  // A closing (or opening) fence tag inside the content is escaped, so the text
  // cannot end its own fence. Byte-identical to lib/external-content.ts.
  const safe = content.replace(/<(\s*\/?\s*external-content)/gi, "&lt;$1")
  return `<external-content source="untrusted">\n${safe}\n</external-content>`
}

// ── Quoted-history stripper (mail-private copy) ─────────────────────────────
// BYTE-IDENTICAL copy of `apps/api/src/lib/email/strip-quoted.ts`
// `stripQuotedHistory` (this bundle runs in QuickJS with NO host imports —
// same rule as `buildRfc2822Message`). Change one copy, change both.
const QUOTE_MARKERS: RegExp[] = [
  /^On .{4,300}? wrote:\s*$/ms,
  /^Le .{4,300}? a écrit\s?:\s*$/ms,
  /^Am .{4,300}? schrieb .{0,200}?:\s*$/ms,
  /^El .{4,300}? escribió:\s*$/ms,
  /^Il .{4,300}? ha scritto:\s*$/ms,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^-{2,}\s*Message d'origine\s*-{2,}\s*$/im,
  /^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^(?:From|Von|De)\s?: .+\r?\n(?:.*\r?\n)?(?:Sent|Date|Gesendet|Envoyé)\s?:/m,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
]

function findQuotePyramidStart(text: string): number {
  const lines = text.split("\n")
  let runStart = -1
  let quotedLines = 0
  let offset = 0
  const offsets: number[] = []
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }
  for (let i = 0; i < lines.length; i++) {
    const isQuoted = /^\s*>/.test(lines[i])
    const isBlank = lines[i].trim() === ""
    if (isQuoted) {
      if (runStart === -1) runStart = i
      quotedLines++
    } else if (!isBlank) {
      runStart = -1
      quotedLines = 0
    }
  }
  if (runStart !== -1 && quotedLines >= 3) return offsets[runStart]
  return -1
}

function stripQuotedHistory(text: string): { text: string; trimmedChars: number } {
  if (!text) return { text, trimmedChars: 0 }
  let cut = -1
  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(text)
    if (m && m.index >= 0 && (cut === -1 || m.index < cut)) cut = m.index
  }
  const pyramid = findQuotePyramidStart(text)
  if (pyramid !== -1 && (cut === -1 || pyramid < cut)) cut = pyramid
  if (cut === -1) return { text, trimmedChars: 0 }
  let head = text.slice(0, cut).replace(/\s+$/, "")
  if (head.length === 0) {
    head = text.slice(0, 400).replace(/\s+$/, "")
  }
  const trimmedChars = text.length - head.length
  if (trimmedChars <= 0) return { text, trimmedChars: 0 }
  return {
    text: `${head}\n[quoted history trimmed: ${trimmedChars} chars — re-read this message via messageId if you need the full chain]`,
    trimmedChars,
  }
}

function decodeBase64Binary(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4)
  if (typeof atob === "function") return atob(padded)

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
  let output = ""
  let index = 0

  while (index < padded.length) {
    const enc1 = chars.indexOf(padded.charAt(index++))
    const enc2 = chars.indexOf(padded.charAt(index++))
    const enc3 = chars.indexOf(padded.charAt(index++))
    const enc4 = chars.indexOf(padded.charAt(index++))

    const chr1 = (enc1 << 2) | (enc2 >> 4)
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2)
    const chr3 = ((enc3 & 3) << 6) | enc4

    output += String.fromCharCode(chr1)
    if (enc3 !== 64) output += String.fromCharCode(chr2)
    if (enc4 !== 64) output += String.fromCharCode(chr3)
  }

  return output
}

function decodeUtf8Binary(binary: string): string {
  let escaped = ""
  for (let index = 0; index < binary.length; index++) {
    escaped += `%${binary.charCodeAt(index).toString(16).padStart(2, "0")}`
  }
  return decodeURIComponent(escaped)
}

function decodeBase64(input: string, charset = "utf-8"): string {
  const binary = decodeBase64Binary(input)
  if (/^(?:utf-?8|unicode-1-1-utf-8)$/i.test(charset)) {
    try {
      return decodeUtf8Binary(binary)
    } catch {
      return binary
    }
  }
  return binary
}

function encodeUtf8Bytes(input: string): number[] {
  const encoded = encodeURIComponent(input)
  const bytes: number[] = []

  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === "%") {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }

    bytes.push(encoded.charCodeAt(index))
  }

  return bytes
}

function encodeBase64Url(input: string): string {
  const bytes = encodeUtf8Bytes(input)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let output = ""

  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index] ?? 0
    const byte2 = bytes[index + 1] ?? 0
    const byte3 = bytes[index + 2] ?? 0

    const triplet = (byte1 << 16) | (byte2 << 8) | byte3
    output += chars[(triplet >> 18) & 63]
    output += chars[(triplet >> 12) & 63]
    output += index + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "="
    output += index + 2 < bytes.length ? chars[triplet & 63] : "="
  }

  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

// Standard RFC-4648 base64 (alphabet +/, "=" padding) over a UTF-8 string. Used
// by the mail export tool to hand bytes to the files bridge, which decodes with
// Buffer.from(bytesBase64, "base64"). Distinct from encodeBase64Url (URL-safe
// alphabet, no padding) which the bridge would mis-decode. No imports in the
// QuickJS bundle, so the encoder is inlined.
function encodeBase64Std(input: string): string {
  const bytes = encodeUtf8Bytes(input)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index] ?? 0
    const byte2 = bytes[index + 1] ?? 0
    const byte3 = bytes[index + 2] ?? 0
    const triplet = (byte1 << 16) | (byte2 << 8) | byte3
    output += chars[(triplet >> 18) & 63]
    output += chars[(triplet >> 12) & 63]
    output += index + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "="
    output += index + 2 < bytes.length ? chars[triplet & 63] : "="
  }
  return output
}

function sanitizeHeaderValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

// --- RFC 2047 header encoding: inlined copy of apps/api/src/lib/email/header-encoding.ts
// (this QuickJS bundle cannot import). handlers.test.ts asserts both copies give
// identical output; change them together.
const HEADER_BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// 39 bytes → 52 base64 chars → a 64-char encoded word, so even the first line
// ("Subject: " + word) stays under RFC 2047's 76-char line limit, and every
// word stays well under its 75-char cap.
const MAX_ENCODED_WORD_BYTES = 39

function codePointUtf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) return [codePoint]
  if (codePoint < 0x800) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 63)]
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 63), 0x80 | (codePoint & 63)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 63),
    0x80 | ((codePoint >> 6) & 63),
    0x80 | (codePoint & 63),
  ]
}

function base64Bytes(bytes: number[]): string {
  let output = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index] ?? 0
    const byte2 = bytes[index + 1] ?? 0
    const byte3 = bytes[index + 2] ?? 0
    const triplet = (byte1 << 16) | (byte2 << 8) | byte3
    output += HEADER_BASE64_CHARS[(triplet >> 18) & 63]
    output += HEADER_BASE64_CHARS[(triplet >> 12) & 63]
    output += index + 1 < bytes.length ? HEADER_BASE64_CHARS[(triplet >> 6) & 63] : "="
    output += index + 2 < bytes.length ? HEADER_BASE64_CHARS[triplet & 63] : "="
  }
  return output
}

function isAsciiHeaderText(value: string): boolean {
  return !/[\u0080-\uffff]/.test(value)
}

/**
 * Encode an already-sanitized string as RFC 2047 B encoded words, never
 * splitting a UTF-8 sequence across words, folded with CRLF + space.
 */
function toEncodedWords(value: string): string {
  const words: string[] = []
  let chunk: number[] = []
  for (const char of value) {
    const bytes = codePointUtf8Bytes(char.codePointAt(0) ?? 0)
    if (chunk.length > 0 && chunk.length + bytes.length > MAX_ENCODED_WORD_BYTES) {
      words.push(`=?UTF-8?B?${base64Bytes(chunk)}?=`)
      chunk = []
    }
    chunk.push(...bytes)
  }
  if (chunk.length > 0) words.push(`=?UTF-8?B?${base64Bytes(chunk)}?=`)
  return words.join("\r\n ")
}

/**
 * An unstructured header value (Subject): CR/LF stripped, then RFC 2047
 * encoded only when it holds non-ASCII. ASCII values are returned as-is.
 */
function encodeHeaderValue(value: unknown): string {
  const sanitized = sanitizeHeaderValue(value)
  if (isAsciiHeaderText(sanitized)) return sanitized
  return toEncodedWords(sanitized)
}

/**
 * A mailbox display name: RFC 2047 when non-ASCII, a quoted-string when it
 * holds RFC 5322 specials (a period is allowed bare, as obs-phrase permits), otherwise the bare name.
 */
function encodeDisplayName(name: unknown): string {
  const sanitized = sanitizeHeaderValue(name)
  if (!isAsciiHeaderText(sanitized)) return toEncodedWords(sanitized)
  if (/[()<>[\]:;@\\,"]/.test(sanitized)) {
    return `"${sanitized.replace(/[\\"]/g, "\\$&")}"`
  }
  return sanitized
}

/** `Name <addr>` (or the bare addr-spec when there is no name). The addr-spec is never encoded. */
function formatMailbox(name: unknown, email: unknown): string {
  const address = sanitizeHeaderValue(email)
  const display = sanitizeHeaderValue(name)
  if (!display) return address
  return `${encodeDisplayName(display)} <${address}>`
}

/**
 * A pre-formatted address string ("Élodie <e@x.test>"). ASCII strings pass
 * through unchanged; a non-ASCII display name in the `name <addr>` form is
 * re-encoded. Anything else is returned sanitized (a non-ASCII addr-spec needs
 * SMTPUTF8 and cannot be fixed by header encoding).
 */
function encodeAddressString(value: unknown): string {
  const sanitized = sanitizeHeaderValue(value)
  if (isAsciiHeaderText(sanitized)) return sanitized
  const match = /^(.*?)\s*<([^<>\s]+)>$/.exec(sanitized)
  if (!match) return sanitized
  const name = (match[1] ?? "").trim().replace(/^"(.*)"$/, "$1")
  return formatMailbox(name, match[2])
}
// --- end RFC 2047 header encoding

/**
 * Sanitize a value that will be interpolated into a MIME header parameter
 * (e.g. `filename="..."` or `Content-ID: <...>`). Strips CR/LF and quote
 * characters to prevent header smuggling, plus any `<` / `>` so a value can't
 * close out a Content-ID enclosure or inject one of its own. Also trims and
 * caps length to keep generated MIME well-formed.
 */
function escapeMimeHeaderParam(value: unknown): string {
  return String(value ?? "")
    .replace(/[\r\n"<>]+/g, "")
    .trim()
    .slice(0, 200)
}

/**
 * Sanitize a Content-ID value. Per RFC 5322 a `msg-id` is a dot-atom inside
 * angle brackets — only printable ASCII and a narrow set of punctuation. We
 * accept the dot-atom subset only; anything else is dropped.
 */
function escapeMimeContentId(value: unknown): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._@!#$%&'*+\-/=?^_`{|}~]/g, "")
    .slice(0, 200)
}

function buildQueryString(params: Record<string, string | number | null | undefined>): string {
  const entries: string[] = []

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue
    entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }

  return entries.length > 0 ? `?${entries.join("&")}` : ""
}

function ensureMailString(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`${name} required`)
  return v
}

function combineReferences(
  references: string[] | undefined,
  inReplyTo: string | null | undefined,
): string[] {
  const merged = [...(references ?? [])]
  if (inReplyTo) merged.push(inReplyTo)
  return [...new Set(merged.map((value) => sanitizeHeaderValue(value)).filter(Boolean))]
}

interface OutboundAttachmentPart {
  filename: string
  mimeType: string
  bytesBase64: string
  disposition: "inline" | "attachment"
  contentId?: string
}

function foldBase64(base64: string): string {
  // RFC 2045 — 76 columns.
  return base64.replace(/(.{76})/g, "$1\r\n")
}

/**
 * Format a stored address value into an RFC 5322 mailbox string. Message rows
 * persist from_address as a JSON object ({name,email}); interpolating that
 * object into the To header produced "[object Object]" and Gmail rejected the
 * send with 400 "Invalid To header" (prod, 2026-07-24). The display name goes
 * through formatMailbox: RFC 2047 when non-ASCII, quoted when it holds specials.
 */
function formatMailAddress(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (value && typeof value === "object") {
    const a = value as { email?: unknown; name?: unknown }
    const email = typeof a.email === "string" ? a.email.trim() : ""
    const name = typeof a.name === "string" ? a.name.trim() : ""
    if (!email) return ""
    return formatMailbox(name, email)
  }
  return ""
}

// Recipients reach the send as plain addresses or as {name,email} objects (the
// compose tool accepts both). Header-building stringified an object into
// "[object Object]" and Gmail refused the whole send with 400 "Invalid To
// header" (Fabrikam, 2026-10-01), so every list is formatted here, once.
function formatMailAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.map(formatMailAddress).filter(Boolean)
}

function buildRfc2822Message(params: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  htmlBody: string
  textBody: string
  inReplyTo?: string | null
  references?: string[]
  attachments?: OutboundAttachmentPart[]
}) {
  const ts = Date.now()
  const altBoundary = `----=_Liaison_alt_${ts}`
  const relBoundary = `----=_Liaison_rel_${ts}`
  const mixBoundary = `----=_Liaison_mix_${ts}`
  const lines = [
    `From: ${encodeAddressString(params.from)}`,
    `To: ${params.to.map((value) => encodeAddressString(value)).join(", ")}`,
    `Subject: ${encodeHeaderValue(params.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ]

  if (params.cc?.length) {
    lines.push(`Cc: ${params.cc.map((value) => encodeAddressString(value)).join(", ")}`)
  }
  if (params.bcc?.length) {
    lines.push(`Bcc: ${params.bcc.map((value) => encodeAddressString(value)).join(", ")}`)
  }
  if (params.inReplyTo) {
    lines.push(`In-Reply-To: ${sanitizeHeaderValue(params.inReplyTo)}`)
  }
  if (params.references?.length) {
    lines.push(
      `References: ${params.references.map((value) => sanitizeHeaderValue(value)).join(" ")}`,
    )
  }

  const hasText = params.textBody.length > 0
  const hasHtml = params.htmlBody.length > 0
  const inlineAtt = (params.attachments ?? []).filter((a) => a.disposition === "inline")
  const normalAtt = (params.attachments ?? []).filter((a) => a.disposition === "attachment")

  function appendAttachmentPart(boundary: string, att: OutboundAttachmentPart): void {
    const safeName = escapeMimeHeaderParam(att.filename)
    const safeMime = escapeMimeHeaderParam(att.mimeType) || "application/octet-stream"
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: ${safeMime}; name="${safeName}"`)
    lines.push("Content-Transfer-Encoding: base64")
    if (att.disposition === "inline" && att.contentId) {
      const safeCid = escapeMimeContentId(att.contentId)
      if (safeCid) lines.push(`Content-ID: <${safeCid}>`)
      lines.push(`Content-Disposition: inline; filename="${safeName}"`)
    } else {
      lines.push(`Content-Disposition: attachment; filename="${safeName}"`)
    }
    lines.push("")
    lines.push(foldBase64(att.bytesBase64))
  }

  function appendBodyAsAlternative(boundary: string): void {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    lines.push("")
    if (hasText) {
      lines.push(`--${boundary}`)
      lines.push('Content-Type: text/plain; charset="UTF-8"')
      lines.push("Content-Transfer-Encoding: 8bit")
      lines.push("")
      lines.push(params.textBody)
    }
    if (hasHtml) {
      lines.push(`--${boundary}`)
      lines.push('Content-Type: text/html; charset="UTF-8"')
      lines.push("Content-Transfer-Encoding: 8bit")
      lines.push("")
      lines.push(params.htmlBody)
    }
    lines.push(`--${boundary}--`)
  }

  function appendBodyAsSingle(): void {
    lines.push(`Content-Type: ${hasHtml ? "text/html" : "text/plain"}; charset="UTF-8"`)
    lines.push("Content-Transfer-Encoding: 8bit")
    lines.push("")
    lines.push(hasHtml ? params.htmlBody : params.textBody)
  }

  // ---- No attachments: simple multipart/alternative or single body ----
  if (inlineAtt.length === 0 && normalAtt.length === 0) {
    if (hasText && hasHtml) {
      appendBodyAsAlternative(altBoundary)
    } else {
      appendBodyAsSingle()
    }
    lines.push("")
    return lines.join("\r\n")
  }

  // ---- Has attachments: wrap in multipart/mixed ----
  lines.push(`Content-Type: multipart/mixed; boundary="${mixBoundary}"`)
  lines.push("")

  // Body part: either multipart/related (inline images + html/alt) or just alternative/single.
  if (inlineAtt.length > 0) {
    lines.push(`--${mixBoundary}`)
    lines.push(`Content-Type: multipart/related; boundary="${relBoundary}"`)
    lines.push("")
    lines.push(`--${relBoundary}`)
    if (hasText && hasHtml) appendBodyAsAlternative(altBoundary)
    else appendBodyAsSingle()
    for (const att of inlineAtt) appendAttachmentPart(relBoundary, att)
    lines.push(`--${relBoundary}--`)
  } else {
    lines.push(`--${mixBoundary}`)
    if (hasText && hasHtml) appendBodyAsAlternative(altBoundary)
    else appendBodyAsSingle()
  }

  for (const att of normalAtt) appendAttachmentPart(mixBoundary, att)
  lines.push(`--${mixBoundary}--`)
  lines.push("")
  return lines.join("\r\n")
}

function parseEmailAddress(raw: string): { name?: string; email: string } {
  const trimmed = raw.trim()
  const match = trimmed.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+@[^>]+)>$/)
  if (match) {
    return { name: match[1]?.trim() || undefined, email: match[2].trim().toLowerCase() }
  }
  return { email: trimmed.toLowerCase() }
}

function parseEmailAddressList(raw: string): Array<{ name?: string; email: string }> {
  if (!raw.trim()) return []
  return raw
    .split(",")
    .map((entry) => parseEmailAddress(entry.trim()))
    .filter((entry) => entry.email)
}

function getHeaderValue(part: any, headerName: string): string | undefined {
  const header = (part.headers ?? []).find(
    (entry: any) => String(entry.name).toLowerCase() === headerName.toLowerCase(),
  )
  return header?.value
}

function getPartCharset(part: any): string {
  const contentType = getHeaderValue(part, "content-type") ?? ""
  return contentType.match(/charset=["']?([^"';\s]+)/i)?.[1] ?? "utf-8"
}

/**
 * The message's own text and HTML, read from the Gmail MIME tree.
 *
 * Every text part used to count, the last one winning: a `.txt` or `.html`
 * file attached after the body, or the body of a forwarded `.eml`, replaced
 * the message, and an HTML body split around an inline attachment (Apple Mail
 * does this) kept only its closing fragment. The reader then saw the
 * attachment where the email should be. Now a part carrying a filename or an
 * `attachment` disposition is a file, a `message/rfc822` part is a message of
 * its own (shown as its attachment), the alternatives of a
 * `multipart/alternative` are not added together, and the fragments of any
 * other multipart are joined in order.
 *
 * A named text part with no `attachment` disposition is still the body when the
 * message has no unnamed one: some senders ship the body as an inline
 * `text/plain; name="message.txt"`. It never joins a message that has its own.
 */
function extractBody(part: any): { text: string; html: string } {
  const strict = extractBodyParts(part, false)
  if (strict.text || strict.html) return strict
  return extractBodyParts(part, true)
}

function extractBodyParts(part: any, allowNamedInline: boolean): { text: string; html: string } {
  const out = { text: "", html: "" }
  if (!part) return out
  const mime = String(part.mimeType ?? "").toLowerCase()
  if (mime === "message/rfc822") return out
  if (Array.isArray(part.parts) && part.parts.length > 0) {
    const alternative = mime === "multipart/alternative"
    for (const subPart of part.parts) {
      const sub = extractBodyParts(subPart, allowNamedInline)
      if (alternative) {
        if (!out.text) out.text = sub.text
        if (!out.html) out.html = sub.html
      } else {
        out.text += sub.text
        out.html += sub.html
      }
    }
    return out
  }
  if (!part.body?.data) return out
  const disposition = (getHeaderValue(part, "content-disposition") ?? "").toLowerCase()
  if (disposition.startsWith("attachment")) return out
  if (part.filename && part.filename.length > 0 && !allowNamedInline) return out
  // A single-part message may omit mimeType; it is plain text by default.
  const leafMime = mime || "text/plain"
  if (leafMime !== "text/plain" && leafMime !== "text/html") return out
  const data = decodeBase64(part.body.data, getPartCharset(part))
  if (leafMime === "text/plain") out.text = data
  else out.html = data
  return out
}

function extractAttachments(part: any, out: any[]) {
  if (!part) return
  const partFilename: string | undefined = part.filename
  const cidHeader = getHeaderValue(part, "content-id")
  const dispHeader = (getHeaderValue(part, "content-disposition") ?? "").toLowerCase()
  const isAttachment = !!(partFilename && partFilename.length > 0)
  if (isAttachment) {
    const contentId = cidHeader ? cidHeader.trim().replace(/^<+/, "").replace(/>+$/, "") : undefined
    const disposition: "inline" | "attachment" = dispHeader.startsWith("inline")
      ? "inline"
      : "attachment"
    out.push({
      filename: partFilename,
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size,
      providerAttachmentId: part.body?.attachmentId,
      disposition,
      contentId,
      originalContentId: cidHeader,
    })
  }
  if (part.parts) {
    for (const sub of part.parts) extractAttachments(sub, out)
  }
}

function normalizeGmailMessage(msg: any) {
  const headers: Record<string, string> = {}
  for (const header of msg.payload?.headers ?? []) {
    headers[String(header.name).toLowerCase()] = header.value
  }

  const from = parseEmailAddress(headers.from ?? "")
  const to = parseEmailAddressList(headers.to ?? "")
  const cc = parseEmailAddressList(headers.cc ?? "")
  const bcc = parseEmailAddressList(headers.bcc ?? "")

  const { text: textBody, html: htmlBody } = extractBody(msg.payload)

  const attachments: Array<{
    filename: string
    mimeType: string
    sizeBytes?: number
    providerAttachmentId?: string
    disposition: "inline" | "attachment"
    contentId?: string
    originalContentId?: string
  }> = []
  extractAttachments(msg.payload, attachments)

  const labels = msg.labelIds ?? []
  // Every Authentication-Results header, topmost (the receiving provider's) first:
  // the keyed map above keeps only the last one, which is the sender's to forge.
  const authenticationResults: string[] = []
  for (const header of msg.payload?.headers ?? []) {
    if (String(header.name).toLowerCase() === "authentication-results") {
      authenticationResults.push(String(header.value))
    }
  }
  return {
    authenticationResults,
    // Fetched through the Gmail API: Gmail's own authserv-id is trusted.
    receivedVia: "gmail_api",
    externalMessageId: headers["message-id"] ?? `<${msg.id}@mail.gmail.com>`,
    externalProviderId: msg.id,
    externalThreadId: msg.threadId,
    from,
    to,
    cc,
    bcc,
    subject: headers.subject ?? "",
    textBody,
    htmlBody,
    snippet: (textBody || htmlBody).slice(0, 200),
    headers,
    inReplyTo: headers["in-reply-to"] ?? null,
    references: (headers.references ?? "").split(/\s+/).filter(Boolean),
    labels,
    isRead: !labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    // Gmail's own receipt time (ms). Unlike the Date header it is not written
    // by the sender, so the new-email notification's freshness check reads it.
    internalDate: Number.isFinite(Number(msg.internalDate)) ? Number(msg.internalDate) : null,
    sentAt: headers.date
      ? new Date(headers.date).toISOString()
      : new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
    direction: labels.includes("SENT") ? "outbound" : "inbound",
    attachments,
  }
}

/** The only message columns the conversation roll-up reads. Projected
 *  explicitly: this runs on EVERY label change Gmail reports (reading one mail
 *  is a labelRemoved UNREAD record), and a `SELECT *` over a long thread hauls
 *  every body and its base64 ciphertext into the 32 MB sandbox heap. A 70
 *  message thread was 8+ MB in Postgres and OOMed the whole incremental sync
 *  on each tick, so the mailbox never advanced past that history record. */
const CONVERSATION_STATE_MESSAGE_FIELDS = [
  "id",
  "labels",
  "isRead",
  "isStarred",
  "sentAt",
  "snippet",
  "encVersion",
  "snippetCiphertext",
  "subjectCiphertext",
  "contentKeyWrapped",
  "contentKeyEpk",
  "encKeyId",
]

/**
 * A conversation's status after a Gmail label change, from its stored row
 * (status and labels BEFORE the change) and its messages' labels after it.
 *
 * Trash follows Gmail: every message in Trash trashes it, one leaving Trash
 * brings it back. Archive follows an INBOX TRANSITION: the thread leaving the
 * inbox archives it, entering it (moved back, or new mail) reopens it. A record
 * that does not move INBOX keeps the status the user set, so reading or
 * starring a thread in Gmail no longer reopens a conversation archived in
 * Liaison, and the history echo of Liaison's own write-back is a no-op.
 * `escalated` is Liaison's own (a ticket was opened from it) and stays.
 */
function rolledUpConversationStatus(
  current: { status?: unknown; labels?: unknown } | null,
  labels: string[],
  allTrashed: boolean,
): string {
  if (allTrashed) return "trashed"
  const status = typeof current?.status === "string" ? current.status : null
  if (status === null || status === "trashed") return "open"
  if (status === "escalated") return status
  if (!Array.isArray(current?.labels)) return status === "archived" ? status : "open"
  const hadInbox = (current.labels as string[]).includes("INBOX")
  const hasInbox = labels.includes("INBOX")
  if (hadInbox && !hasInbox) return "archived"
  if (!hadInbox && hasInbox) return "open"
  return status
}

async function recomputeConversationState(
  conversationId: string,
  account: { owner_type: string; encryption_state?: string },
  ctx: MailCtx,
  opts: { keepTrashed?: boolean } = {},
) {
  const messages = JSON.parse(
    await ctx.db_findMany(
      "messages",
      JSON.stringify({
        where: { conversationId },
        orderBy: { sentAt: "desc" },
        select: CONVERSATION_STATE_MESSAGE_FIELDS,
      }),
    ),
  )

  if (messages.length === 0) {
    // Both representations go together. Leaving a sealed snippet behind on a
    // conversation with no messages would leave content pointing at a row that
    // no longer exists.
    await ctx.db_update(
      "conversations",
      conversationId,
      JSON.stringify({
        status: "trashed",
        labels: ["TRASH"],
        isRead: true,
        isStarred: false,
        messageCount: 0,
        lastMessageAt: null,
        snippet: null,
        snippetCiphertext: null,
        snippetSourceMessageId: null,
      }),
    )
    return
  }

  const latest = messages[0]
  const labels = [
    ...new Set<string>(messages.flatMap((message: any): string[] => message.labels ?? [])),
  ]
  const anyUnread = messages.some((message: any) => !(message.is_read ?? message.isRead))
  const anyStarred = messages.some((message: any) => message.is_starred ?? message.isStarred)
  const allTrashed = messages.every((message: any) => (message.labels ?? []).includes("TRASH"))
  const current = JSON.parse(await ctx.db_findOne("conversations", conversationId))
  // The IMAP read-back keeps a conversation trashed in Liaison trashed: its
  // messages carry TRASH only once the server confirmed the move (and never on
  // a server with no Trash folder), so a flag or INBOX change seen meanwhile
  // must not reopen it, nor lead the write-back to move it out of Trash.
  const status =
    opts.keepTrashed && current?.status === "trashed"
      ? "trashed"
      : rolledUpConversationStatus(current, labels, allTrashed)

  // THE SUBTLEST BUG IN THIS FEATURE, and the reason this branch exists.
  //
  // This function is called from ordinary operations long after ingest
  // (archive, relabel), with NO key material anywhere in reach. Under
  // encryption `latest.snippet` is NULL, so the pre-encryption code below would
  // have silently blanked the conversation's sealed snippet on every archive.
  //
  // For a sealed conversation the derived fields are POINTERS: the latest
  // message's ciphertext and key material are copied verbatim, and
  // `snippetSourceMessageId` records which message, so the client knows the AAD
  // to rebuild is `mail.message:snippet:<messageId>`, not a conversation
  // context. The plaintext `snippet` column is never written.
  //
  // The second half of the same bug: a mailbox that has JUST enrolled still
  // holds messages ingested before enrollment, plaintext rows the hourly
  // backfill has not sealed yet. The owner's identity is already active, so the
  // database trigger is armed, and writing that plaintext snippet back raised
  // `mailbox_plaintext_forbidden`, which failed the whole incremental tick.
  // Every tick that touched an old thread died the same way until the backfill
  // caught up (prod 2026-09-14: twenty-four minutes of "sync error" right after
  // a user finished the setup the banner asked for). For a sealing mailbox the
  // plaintext snippet is left exactly as it is: the backfill seals and the
  // purge clears it, and neither needs this roll-up to touch it.
  // Version 1 (private) and 2 (server-managed) are both sealed: the
  // conversation carries a copy of the latest message's ciphertext either way.
  const latestEncVersion = Number(latest.enc_version ?? latest.encVersion ?? 0)
  const encrypted = latestEncVersion >= 1
  const derived = encrypted
    ? {
        snippetCiphertext: latest.snippet_ciphertext ?? null,
        subjectCiphertext: latest.subject_ciphertext ?? null,
        contentKeyWrapped: latest.content_key_wrapped ?? null,
        contentKeyEpk: latest.content_key_epk ?? null,
        encKeyId: latest.enc_key_id ?? null,
        encVersion: latestEncVersion,
        snippetSourceMessageId: latest.id,
      }
    : mailAccountRequiresSealing(account)
      ? {}
      : { snippet: latest.snippet ?? null }

  await ctx.db_update(
    "conversations",
    conversationId,
    JSON.stringify({
      status,
      labels,
      isRead: !anyUnread,
      isStarred: anyStarred,
      messageCount: messages.length,
      lastMessageAt: latest.sent_at ?? latest.sentAt,
      ...derived,
    }),
  )
  // The roll-up's read state rides on the event. Without it an open mail list
  // patched the row with nothing and kept a conversation read in Gmail unread
  // until a reload; sealed rows refetch anyway, plain ones never did. Metadata
  // only: no subject or snippet, which a sealed mailbox cannot carry here.
  await ctx.emit(
    JSON.stringify({
      entity: "conversation",
      action: "update",
      entityId: conversationId,
      data: {
        id: conversationId,
        accountId: messages[0]?.account_id ?? messages[0]?.accountId,
        isRead: !anyUnread,
        isStarred: anyStarred,
        messageCount: messages.length,
        lastMessageAt: latest.sent_at ?? latest.sentAt,
      },
    }),
  )
}

/**
 * True when this mailbox's content must be sealed before it touches the
 * database. `ready` seals. `blocked` and `paused` are personal mailboxes that
 * stay ARMED in the database but have no usable seal path, so their writers
 * refuse (see `assertMailWritable`) rather than fall back to plaintext.
 */
function mailAccountRequiresSealing(account: {
  owner_type: string
  encryption_state?: string
}): boolean {
  return (
    account.owner_type === "user" &&
    (account.encryption_state === "ready" || account.encryption_state === "managed")
  )
}

/**
 * Invariant K, in the app bundle: may anything derived from this mailbox carry
 * content?
 *
 * `blocked` and `paused` count as encrypted. They are where a mailbox lands on a
 * seal failure or an elapsed grace window, the historical plaintext columns are
 * still populated until the Phase 12 purge, and keying on `ready` alone meant one
 * seal failure switched content suppression back off for the whole dual-read
 * window. This mirrors `mailAccountSuppressedSql` on the host side, minus the
 * armed check, which needs a SECURITY DEFINER call the sandbox cannot make.
 */
function mailAccountContentSuppressed(
  account:
    | {
        owner_type?: string | null
        encryption_state?: string | null
      }
    | null
    | undefined,
): boolean {
  return (
    account?.owner_type === "user" &&
    (account.encryption_state === "ready" ||
      account.encryption_state === "blocked" ||
      account.encryption_state === "paused" ||
      account.encryption_state === "managed")
  )
}

/**
 * Refuse a content write that cannot be sealed, instead of writing plaintext.
 *
 * This is what makes the trigger's arming decision safe: the trigger stays
 * armed while the account is `blocked` or `paused`, and the application layer
 * agrees with it instead of trying to write around it. A writer that cannot
 * seal fails the operation and writes nothing, never a partial row.
 */
function assertMailWritable(
  account: { id: string; owner_type: string; encryption_state?: string },
  operation: string,
): void {
  if (account.owner_type !== "user") return
  const state = account.encryption_state
  if (state === "blocked" || state === "paused") {
    throw new Error(
      `MAILBOX_ENCRYPTION_NOT_READY: ${operation} refused, mailbox ${account.id} is "${state}" ` +
        "and cannot be sealed to. Writing plaintext instead is forbidden.",
    )
  }
}

/** The seal failures that mean "this mailbox cannot receive mail until its
 *  owner's keys are fixed", so the account moves to `blocked`. */
const MAILBOX_BLOCKING_SEAL_ERRORS = [
  "NO_ACTIVE_IDENTITY_KEY",
  "MULTIPLE_ACTIVE_IDENTITY_KEYS",
  "USER_NOT_ENROLLED",
  // A mismatch here means the sync cannot work out who to seal to. Left out of
  // this set it is retried forever with no diagnosis, which is exactly how a
  // mailbox stopped ingesting mail silently: a blocked mailbox is visible, an
  // infinitely retrying job is not.
  "RECIPIENT_MISMATCH",
]

/**
 * Run a sealing write. On an identity failure the message is NOT written, the
 * account moves to `blocked`, and the error propagates so the sync job fails
 * loudly. Silently falling back to plaintext is forbidden and there is no code
 * path here that could do it.
 */
async function withSealFailureBlocking<T>(
  accountId: string,
  ctx: MailCtx,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (MAILBOX_BLOCKING_SEAL_ERRORS.some((code) => message.includes(code))) {
      ctx.log_error(
        "Mailbox sealing failed: no usable identity key, blocking the mailbox",
        JSON.stringify({ accountId, error: message }),
      )
      await ctx.db_update("accounts", accountId, JSON.stringify({ encryptionState: "blocked" }))
    }
    throw err
  }
}

// --- Envelope-only triggers (spec section 5.3c, blueprint task 11.2) ---
//
// A server-side trigger on an encrypted mailbox may look at the ENVELOPE and
// nothing else: correspondents, labels, direction, dates, attachment counts and
// attachment filenames. Those are cleartext on the server by spec section 2.1.
// It may not look at a subject, a snippet or a body, because on a `ready`
// mailbox the server cannot read them at all. A rule that needed body text is
// not a rule that produces a smaller match here: it is a rule that no longer
// exists server-side, and becomes work the browser does after it decrypts.
//
// So the condition vocabulary below is CLOSED. A rule carrying any key that is
// not in it is dropped whole, with a warning, rather than being evaluated on the
// keys it happens to share. Silently ignoring an unknown `bodyContains` would
// turn "match messages whose body mentions X" into "match every message", which
// is both wrong and the exact failure this design is meant to make impossible.

/** The four read-mostly kinds. Write-capable work stays an in-session action. */
const CLIENT_JOB_KINDS = ["summarise", "triage_label", "index_backfill", "migration_verify"]

/** Every condition the trigger language has. Nothing else is accepted. */
const ENVELOPE_CONDITION_KEYS = [
  "fromEmail",
  "fromDomain",
  "toEmail",
  "anyLabel",
  "allLabels",
  "direction",
  "hasAttachment",
  "minAttachmentCount",
  "attachmentFilenameContains",
  "sentAfter",
  "sentBefore",
]

function envelopeStrings(value: any): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry: any) => typeof entry === "string")
    .map((entry: string) => entry.toLowerCase())
}

function isEnvelopeTriggerRule(rule: any, ctx: MailCtx): boolean {
  if (!rule || typeof rule !== "object") return false
  if (typeof rule.id !== "string" || !rule.id) return false
  if (!CLIENT_JOB_KINDS.includes(rule.kind)) {
    ctx.log_warn(
      "Envelope trigger rule dropped: unsupported job kind",
      JSON.stringify({ ruleId: rule.id, kind: rule.kind }),
    )
    return false
  }
  const when = rule.when
  if (!when || typeof when !== "object" || Array.isArray(when)) return false
  const unknown = Object.keys(when).filter((key) => !ENVELOPE_CONDITION_KEYS.includes(key))
  if (unknown.length > 0) {
    ctx.log_warn(
      "Envelope trigger rule dropped: it names conditions that are not envelope level",
      JSON.stringify({ ruleId: rule.id, unknown }),
    )
    return false
  }
  return true
}

/**
 * The rules for one account.
 *
 * There is no per-account rule COLUMN yet, so in a deployment this reads
 * nothing and no job is enqueued: the trigger path is wired and inert until the
 * configuration surface lands. That is deliberate. An enabled-by-default rule
 * would queue work for every message in every enrolled mailbox on the day the
 * feature ships, and the queue's whole contract is that the user knows what is
 * waiting for them.
 */
function resolveEnvelopeTriggerRules(account: any, ctx: MailCtx): any[] {
  const raw = account?.envelope_trigger_rules ?? account?.envelopeTriggerRules
  if (!Array.isArray(raw)) return []
  return raw.filter((rule: any) => isEnvelopeTriggerRule(rule, ctx))
}

/** The envelope of one ingested message, flattened once for every rule. */
function envelopeFacts(message: any, conversationId: string, accountId: string): any {
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  return {
    accountId,
    conversationId,
    fromEmail: String(message.from?.email ?? "").toLowerCase(),
    toEmails: (message.to ?? [])
      .map((entry: any) => String(entry?.email ?? entry ?? "").toLowerCase())
      .filter(Boolean),
    labels: Array.isArray(message.labels) ? message.labels : [],
    direction: message.direction ?? "inbound",
    sentAt: message.sentAt ?? null,
    attachmentCount: attachments.length,
    attachmentFilenames: attachments
      .slice(0, 20)
      .map((att: any) => String(att?.filename ?? "").slice(0, 200))
      .filter(Boolean),
  }
}

function matchesEnvelope(when: any, facts: any): boolean {
  const labels = facts.labels.map((label: string) => String(label).toLowerCase())
  const filenames = facts.attachmentFilenames.map((name: string) => name.toLowerCase())

  if (when.fromEmail !== undefined && !envelopeStrings(when.fromEmail).includes(facts.fromEmail)) {
    return false
  }
  if (when.fromDomain !== undefined) {
    const domain = facts.fromEmail.split("@")[1] ?? ""
    if (!envelopeStrings(when.fromDomain).includes(domain)) return false
  }
  if (when.toEmail !== undefined) {
    const wanted = envelopeStrings(when.toEmail)
    if (!facts.toEmails.some((email: string) => wanted.includes(email))) return false
  }
  if (when.anyLabel !== undefined) {
    const wanted = envelopeStrings(when.anyLabel)
    if (!labels.some((label: string) => wanted.includes(label))) return false
  }
  if (when.allLabels !== undefined) {
    const wanted = envelopeStrings(when.allLabels)
    if (!wanted.every((label: string) => labels.includes(label))) return false
  }
  if (when.direction !== undefined && when.direction !== facts.direction) return false
  if (when.hasAttachment !== undefined && when.hasAttachment !== facts.attachmentCount > 0) {
    return false
  }
  if (
    typeof when.minAttachmentCount === "number" &&
    facts.attachmentCount < when.minAttachmentCount
  ) {
    return false
  }
  if (when.attachmentFilenameContains !== undefined) {
    const wanted = envelopeStrings(when.attachmentFilenameContains)
    if (!filenames.some((name: string) => wanted.some((needle: string) => name.includes(needle)))) {
      return false
    }
  }
  if (typeof when.sentAfter === "string") {
    if (!facts.sentAt || Date.parse(facts.sentAt) <= Date.parse(when.sentAfter)) return false
  }
  if (typeof when.sentBefore === "string") {
    if (!facts.sentAt || Date.parse(facts.sentAt) >= Date.parse(when.sentBefore)) return false
  }
  return true
}

/**
 * Evaluate every rule against one freshly ingested message and enqueue a client
 * job per match. The payload is BUILT from the envelope facts rather than
 * copied from the message, so there is no field a future edit could carry
 * across by accident; the host re-checks it anyway before the row is written.
 */
async function enqueueEnvelopeTriggeredJobs(
  rules: any[],
  message: any,
  messageId: string,
  conversationId: string,
  accountId: string,
  ctx: MailCtx,
): Promise<void> {
  if (rules.length === 0) return
  const facts = envelopeFacts(message, conversationId, accountId)
  for (const rule of rules) {
    if (!matchesEnvelope(rule.when, facts)) continue
    try {
      await ctx.mailbox_enqueueClientJob(
        JSON.stringify({
          kind: rule.kind,
          accountId,
          // Once per message and rule: a resumed page re-runs its triggers.
          dedupe: true,
          payload: {
            ruleId: rule.id,
            accountId,
            conversationId,
            messageIds: [messageId],
            fromEmail: facts.fromEmail,
            toEmails: facts.toEmails,
            labels: facts.labels,
            direction: facts.direction,
            sentAt: facts.sentAt,
            attachmentCount: facts.attachmentCount,
            attachmentFilenames: facts.attachmentFilenames,
          },
        }),
      )
    } catch (err) {
      // A queue that refuses one job must not fail the sync that delivered the
      // mail. The message is already stored; the job is the optional half.
      ctx.log_warn(
        "Envelope trigger could not enqueue a client job",
        JSON.stringify({ ruleId: rule.id, reason: String((err as Error)?.message ?? err) }),
      )
    }
  }
}

/**
 * Which sync path stored a message (S16). The kernel's new-email producer
 * notifies only for `incremental` (Gmail history), so an initial import, a
 * historyExpired re-sync (which re-enters the initial import), an IMAP poll or
 * a message the user sent can never raise a banner. `reset` is reserved for a
 * re-import after a mailbox reset; no call site passes it today (a reset
 * mailbox goes back to `pending_enrollment` and fetches nothing).
 */
type MailSyncOrigin = "initial" | "incremental" | "imap" | "sent" | "imap-sent" | "reset"

// --- Page writes -------------------------------------------------------------
//
// A sync delivers mail a PAGE at a time (a Gmail list page, a history page, an
// IMAP batch). The bundle fetches and normalizes it; the host writes it in ONE
// transaction through `mail_writePage` (modules/mail/page-write.ts): stored
// messages skipped, conversations created and rolled up, messages inserted (and
// sealed for an armed personal mailbox), senders resolved to contacts under the
// mailbox's policy, events queued. Nothing of a page is ever stored without
// being counted and announced.
//
// What stays here is the work that cannot sit in that transaction: importing
// attachments into object storage and queueing envelope-triggered client jobs.
// A message with such work is stored `ingest_pending` and cleared by
// `mail_completeIngest` once done; an interrupted run's retry gets the pending
// messages back from `mail_writePage` (`resumed`) and finishes them, and the
// Gmail loops re-fetch a pending message instead of skipping it as stored.

/** Messages per `mail_writePage` call (the host's bound). */
const PAGE_WRITE_MAX_MESSAGES = 100

/** Decoded bytes a page may hold in the QuickJS heap before it is written. A
 *  Gmail page is fetched message by message; buffering it whole must not
 *  bring back the multi-MB peaks that 32 MB heap cannot absorb. */
const PAGE_WRITE_BYTE_BUDGET = 2_000_000

/** A rough size of a decoded message in the heap, for the page byte budget. */
function messageHeapBytes(message: any): number {
  let bytes = String(message?.textBody ?? "").length + String(message?.htmlBody ?? "").length
  for (const att of Array.isArray(message?.attachments) ? message.attachments : []) {
    bytes += String(att?.bytesBase64 ?? "").length
  }
  return bytes
}

/** Attachments this bundle must import after the page commits: decoded bytes
 *  (IMAP), or a provider attachment id whose bytes the host downloads (Gmail
 *  hands every real attachment over as an `attachmentId`, never inline). */
function hasAttachmentsToImport(message: any): boolean {
  return (
    (message.direction ?? "inbound") === "inbound" &&
    Array.isArray(message.attachments) &&
    message.attachments.some((att: any) => att?.bytesBase64 || att?.providerAttachmentId)
  )
}

/** Largest attachment the files bridge stores (its per-call cap). A larger one
 *  is not downloaded at all. */
const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/** Where a provider-hosted attachment's bytes are downloaded from, host side. */
interface ProviderAttachmentSource {
  url(message: any, att: any): string | null
  authorization(): Promise<string | null>
}

/** Gmail's attachments endpoint, authorised with the mailbox's own token (read
 *  once per page). The host decodes the base64url `data` field it returns. */
function gmailAttachmentSource(accountEmail: string, ctx: MailCtx): ProviderAttachmentSource {
  let authorization: Promise<string | null> | null = null
  return {
    url: (message, att) =>
      message?.externalProviderId && att?.providerAttachmentId
        ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.externalProviderId)}/attachments/${encodeURIComponent(att.providerAttachmentId)}`
        : null,
    authorization: () => {
      authorization ??= ctx.connections_getToken("gmail", accountEmail).then(
        (token) => (token ? `Bearer ${token}` : null),
        (err) => {
          ctx.log_warn(
            "Gmail attachment download: no token",
            JSON.stringify({ reason: err instanceof Error ? err.message : String(err) }),
          )
          return null
        },
      )
      return authorization
    },
  }
}

/** The attachment source of an account, or null when its attachments always
 *  arrive with their bytes (IMAP). */
function attachmentSourceFor(
  account: { provider?: string; email_address?: string },
  ctx: MailCtx,
): ProviderAttachmentSource | null {
  if (account.provider === "gmail" && account.email_address) {
    return gmailAttachmentSource(account.email_address, ctx)
  }
  return null
}

/**
 * The provider ids among `providerIds` this account has FULLY ingested, in one
 * query. A retried page, an overlapping push or a history replay re-lists
 * messages already stored; knowing it before the fetch is what lets a retry
 * make progress instead of re-downloading the page. A message still
 * `ingest_pending` is not "stored": it is fetched again so its unfinished
 * post-commit work (attachments) can be completed.
 */
async function storedProviderIds(
  accountId: string,
  providerIds: string[],
  ctx: MailCtx,
): Promise<Set<string>> {
  const out = new Set<string>()
  const ids = [...new Set(providerIds.filter(Boolean))]
  for (let start = 0; start < ids.length; start += 500) {
    const rows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: {
            accountId,
            externalProviderId: { in: ids.slice(start, start + 500) },
            ingestPending: null,
          },
          select: ["externalProviderId"],
          limit: 1000,
        }),
      ),
    )
    for (const row of rows) out.add(row.external_provider_id ?? row.externalProviderId)
  }
  return out
}

/**
 * The stored messages among `providerIds`, keyed by provider id, in one query.
 * Labels and the conversation only: a label change or a deletion needs no body.
 */
async function messagesByProviderId(
  accountId: string,
  providerIds: string[],
  ctx: MailCtx,
): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  const ids = [...new Set(providerIds.filter(Boolean))]
  for (let start = 0; start < ids.length; start += 500) {
    const rows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: { accountId, externalProviderId: { in: ids.slice(start, start + 500) } },
          select: ["id", "labels", "conversationId", "externalProviderId", "isRead", "isStarred"],
          limit: 1000,
        }),
      ),
    )
    for (const row of rows) out.set(row.external_provider_id ?? row.externalProviderId, row)
  }
  return out
}

/**
 * Buffers fetched messages and writes them a page at a time, flushing early
 * when the decoded bytes reach the heap budget. The caller flushes before any
 * step that must see the buffered messages stored (a deletion or label change
 * in the same history page, a cursor checkpoint).
 */
function createPageWriter(
  account: {
    id: string
    owner_type: string
    owner_id: string | null
    encryption_state?: string
    provider?: string
    email_address?: string
  },
  ctx: MailCtx,
  origin: MailSyncOrigin,
) {
  let pending: any[] = []
  let bytes = 0
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return
    const page = pending
    pending = []
    bytes = 0
    await processMessages(page, account, ctx, origin)
  }
  return {
    add: async (message: any): Promise<void> => {
      pending.push(message)
      bytes += messageHeapBytes(message)
      if (bytes >= PAGE_WRITE_BYTE_BUDGET || pending.length >= PAGE_WRITE_MAX_MESSAGES) {
        await flush()
      }
    },
    flush,
  }
}

async function processMessages(
  messages: any[],
  account: {
    id: string
    owner_type: string
    owner_id: string | null
    encryption_state?: string
    provider?: string
    email_address?: string
  },
  ctx: MailCtx,
  origin: MailSyncOrigin,
) {
  assertMailWritable(account, "processMessages")
  // A caller that names no origin gets the one that never raises a new-mail
  // notification (S16): being silent is the safe mistake.
  const pageOrigin: MailSyncOrigin = origin ?? "initial"
  // Only a sealing mailbox needs the client-job queue: it is the one whose
  // bodies the server can no longer read. An org mailbox does its work in place.
  const triggerRules = mailAccountRequiresSealing(account)
    ? resolveEnvelopeTriggerRules(account, ctx)
    : []
  const attachmentSource = attachmentSourceFor(account, ctx)
  for (let start = 0; start < messages.length; start += PAGE_WRITE_MAX_MESSAGES) {
    await writePage(
      messages.slice(start, start + PAGE_WRITE_MAX_MESSAGES),
      account.id,
      triggerRules,
      ctx,
      pageOrigin,
      attachmentSource,
    )
  }
}

async function writePage(
  messages: any[],
  accountId: string,
  triggerRules: any[],
  ctx: MailCtx,
  origin: MailSyncOrigin,
  attachmentSource: ProviderAttachmentSource | null = null,
): Promise<void> {
  const byExternalId = new Map<string, any>()
  for (const message of messages) {
    if (message?.externalMessageId) byExternalId.set(message.externalMessageId, message)
  }
  if (byExternalId.size === 0) return
  const postSteps = (message: any) =>
    hasAttachmentsToImport(message) ||
    triggerRules.some((rule) => matchesEnvelope(rule.when, envelopeFacts(message, "", accountId)))
  // The plaintext of each message crosses to the host for exactly this call
  // and is never persisted by it unsealed on an armed mailbox, never logged,
  // never handed to a summariser. Attachment bytes stay here.
  const payload = [...byExternalId.values()].map((message) => {
    const { attachments: _attachments, ...rest } = message
    return { ...rest, postSteps: postSteps(message) }
  })
  const result = JSON.parse(
    await withSealFailureBlocking(accountId, ctx, () =>
      ctx.mail_writePage(JSON.stringify({ accountId, origin, messages: payload })),
    ),
  ) as {
    entries: Array<{
      messageId: string
      externalMessageId: string
      conversationId: string
      resumed: boolean
    }>
  }

  // Post-commit work, for the messages the host marked pending.
  const done: string[] = []
  for (const entry of result.entries) {
    const message = byExternalId.get(entry.externalMessageId)
    if (!message || !postSteps(message)) continue
    await enqueueEnvelopeTriggeredJobs(
      triggerRules,
      message,
      entry.messageId,
      entry.conversationId,
      accountId,
      ctx,
    )
    await importInboundAttachments(message, entry.messageId, entry.resumed, ctx, attachmentSource)
    done.push(entry.messageId)
  }
  if (done.length > 0) {
    await ctx.mail_completeIngest(JSON.stringify({ accountId, messageIds: done }))
  }
}

/**
 * Persist inbound attachments into the kernel files store so they are
 * accessible via the files bridge. An attachment carries either decoded bytes
 * (IMAP), stored through `files_importAttachment`, or a provider attachment id
 * (Gmail), downloaded and stored host side through `files_importFromUrl`; both
 * end as a kernel.files row parented to the message. Best-effort: a single failed
 * attachment must not abort the rest of message ingest. A RESUMED message (an
 * earlier run stored it and was interrupted) skips the ordinals it already has.
 */
async function importInboundAttachments(
  message: any,
  messageId: string,
  resumed: boolean,
  ctx: MailCtx,
  source: ProviderAttachmentSource | null = null,
): Promise<void> {
  if (!hasAttachmentsToImport(message)) return
  const already = new Set<number>()
  if (resumed && ctx.files_listAttachments) {
    const existing = JSON.parse(
      await ctx.files_listAttachments(
        JSON.stringify({ app: "mail", entityType: "message", entityId: messageId }),
      ),
    ) as Array<{ ordinal?: number }>
    for (const row of existing) if (typeof row.ordinal === "number") already.add(row.ordinal)
  }
  for (let ordinal = 0; ordinal < message.attachments.length; ordinal++) {
    const att = message.attachments[ordinal]
    if (!att || already.has(ordinal)) continue
    try {
      if (att.bytesBase64 && ctx.files_importAttachment) {
        await ctx.files_importAttachment(
          JSON.stringify({
            targetApp: "mail",
            targetEntityType: "message",
            targetEntityId: messageId,
            filename: att.filename || "attachment",
            mimeType: att.mimeType || "application/octet-stream",
            bytesBase64: att.bytesBase64,
            disposition: att.disposition ?? "attachment",
            contentId: att.contentId ?? null,
            ordinal,
          }),
        )
        continue
      }
      if (!att.providerAttachmentId || !source || !ctx.files_importFromUrl) continue
      if (typeof att.sizeBytes === "number" && att.sizeBytes > INBOUND_ATTACHMENT_MAX_BYTES) {
        ctx.log_warn(
          "Inbound attachment too large to store",
          JSON.stringify({ messageId, filename: att.filename, sizeBytes: att.sizeBytes }),
        )
        continue
      }
      const url = source.url(message, att)
      const authorization = url ? await source.authorization() : null
      if (!url || !authorization) continue
      // Downloaded and decoded host side: the bytes never cross the sandbox
      // heap or its fetch response cap.
      await ctx.files_importFromUrl(
        JSON.stringify({
          targetApp: "mail",
          targetEntityType: "message",
          targetEntityId: messageId,
          url,
          headers: { Authorization: authorization },
          jsonBase64Field: "data",
          filename: att.filename || "attachment",
          mimeType: att.mimeType || "application/octet-stream",
          disposition: att.disposition ?? "attachment",
          contentId: att.contentId ?? null,
          ordinal,
        }),
      )
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      ctx.log_warn(
        "Failed to persist inbound attachment",
        JSON.stringify({ messageId, filename: att.filename, reason }),
      )
    }
  }
}

// --- Event handlers ---

/**
 * Where a reconnected mailbox picks up. The provider cursor decides:
 *   - a Gmail `historyId` or an IMAP `uidValidity` means the mailbox completed
 *     an import once, so it goes straight back to `active` and one incremental
 *     tick catches it up (or, if the provider has forgotten that history, the
 *     tick re-enqueues the full import by itself);
 *   - a page cursor with the row at `syncing` is a backfill in flight, which
 *     keeps running on its own chain and needs no second one;
 *   - anything else is a mailbox that never finished importing, and starts as
 *     if new.
 */
function reconnectResumption(
  provider: "gmail" | "imap",
  row: { sync_status?: string; sync_state?: Record<string, unknown> | null },
): { syncStatus: "active" | "syncing" | "pre-sync"; job: string | null } {
  const state = row.sync_state ?? {}
  if (row.sync_status === "syncing" && state.cursor) {
    return { syncStatus: "syncing", job: null }
  }
  // An IMAP INBOX walk stopped part way (a failed page) resumes where it stopped.
  if (provider === "imap" && state.inboxWalk) {
    return { syncStatus: "syncing", job: "imap-initial-sync" }
  }
  const completedOnce = provider === "gmail" ? Boolean(state.historyId) : Boolean(state.uidValidity)
  if (completedOnce) {
    return { syncStatus: "active", job: `${provider}-incremental-sync` }
  }
  return { syncStatus: "pre-sync", job: `${provider}-initial-sync` }
}

/** Whether a mailbox row is owned by the account a connect belongs to. */
function sameMailboxOwner(row: AccountRow, ownerType: string, ownerId: string | null): boolean {
  if (row.owner_type !== ownerType) return false
  return ownerType === "org" || (row.owner_id ?? null) === (ownerId ?? null)
}

async function onAccountConnected(event: MailKernelConnectionEvent, ctx: MailCtx) {
  if (event.data?.appName !== "mail") return
  const { id, ownerType, ownerId, identifier, connectionName } = event.data
  const provider = connectionName === "gmail" ? "gmail" : "imap"
  const sameAddress: AccountRow[] = JSON.parse(
    await ctx.db_findMany("accounts", JSON.stringify({ where: { emailAddress: identifier } })),
  )
  // A mailbox row belongs to its owner: the organization (shared) or one member
  // (personal, with its own password and encryption). A connect rebinds only a
  // row of the SAME owner. Rebinding by address alone carried a member's
  // personal Gmail into the org's shared row (visible to mail admins,
  // unencrypted), or the org's mailbox into one member's personal row.
  // One row per address, so another owner's row is released (its content
  // purged, the row and its access grants deleted) only when its own connection
  // is no longer active and this connection proved it controls the account
  // (OAuth, or an IMAP login that works). Otherwise the connect is refused: the
  // new connection is disconnected and the person who made it is told why.
  const existing = sameAddress.filter((row) => sameMailboxOwner(row, ownerType, ownerId))
  for (const row of sameAddress) {
    if (existing.includes(row)) continue
    if (row.connected_account_id === id) {
      // The same grant again (a replayed event): it is this row's own connection.
      existing.push(row)
      continue
    }
    const released = JSON.parse(
      await ctx.mail_releaseForeignAccount(JSON.stringify({ accountId: row.id, connectionId: id })),
    ) as { outcome: "released" | "held" | "unproven"; heldBy?: "org" | "user" }
    if (released.outcome === "released") {
      // The account:create below tells the open views about the row that replaces it.
      ctx.log_info(
        "Another owner's disconnected mailbox released before a connect",
        JSON.stringify({ removedRowId: row.id, removedOwnerType: row.owner_type, provider }),
      )
      continue
    }
    const holder =
      (released.heldBy ?? row.owner_type) === "org" ? "the organization" : "another member"
    const summary =
      released.outcome === "held"
        ? `Your mail connection for ${identifier} was not kept: this address is already connected as ${holder}'s mailbox. That mailbox has to be disconnected before this one can connect.`
        : `Your mail connection for ${identifier} was not kept: this address belonged to ${holder}'s mailbox, and the mail server refused the login, so it could not take its place. Check the password and connect again.`
    ctx.log_warn(
      "Mail connect refused: the address is another owner's mailbox",
      JSON.stringify({ connectedAccountId: id, outcome: released.outcome, provider }),
    )
    await ctx.connections_disconnect(id, JSON.stringify({ reason: "connect_refused", summary }))
    return
  }
  let extensionRowId: string
  if (existing.length > 0) {
    const row = existing[0]
    extensionRowId = row.id
    // A re-authorization (the Re-authorize button, or a second pass through
    // Connect on a mailbox that already exists) rebinds the row to the fresh
    // grant. It must NOT restart the mailbox from scratch: resetting to
    // pre-sync re-downloaded every message the row already holds (ten thousand
    // fetches, the mailbox reported "syncing" for the duration) on every
    // reconnect. A row that has a provider cursor resumes from it; the
    // incremental sync itself falls back to the full import when the provider
    // no longer has that history. A row mid-backfill keeps its chain, which
    // the stranded-sync rescue re-drives if the reconnect was because the
    // chain had died on a revoked token.
    const resumption = reconnectResumption(provider, row)
    // New credentials: a failure backoff no longer applies.
    const { failedAttempts: _failed, nextRetryAt: _retry, ...syncState } = row.sync_state ?? {}
    await ctx.db_update(
      "accounts",
      row.id,
      JSON.stringify({
        connectedAccountId: id,
        syncStatus: resumption.syncStatus,
        lastSyncError: null,
        lastSyncAt: null,
        disconnectedAt: null,
        ...(row.sync_state ? { syncState } : {}),
      }),
    )
    await ctx.emit(
      JSON.stringify({
        entity: "account",
        action: "update",
        entityId: row.id,
        data: { id: row.id, syncStatus: resumption.syncStatus, reconnected: true },
      }),
    )
    if (resumption.job) {
      await ctx.enqueueJob(
        resumption.job,
        JSON.stringify({ orgId: event.orgId, accountId: row.id }),
        JSON.stringify({ jobId: `${resumption.job}:${row.id}` }),
      )
    }
    ctx.log_info(
      "Mail account reconnected",
      JSON.stringify({ extensionRowId, provider, syncStatus: resumption.syncStatus }),
    )
    return
  }
  // A brand-new personal row is born `ready` or `pending_enrollment`: the
  // accounts INSERT trigger (`default_mailbox_encryption_state`) reads whether
  // the owner already holds an active identity, so the handler never has to.
  const result = JSON.parse(
    await ctx.db_insert(
      "accounts",
      JSON.stringify({
        connectedAccountId: id,
        ownerType,
        ownerId: ownerId ?? undefined,
        provider,
        emailAddress: identifier,
        syncStatus: "pre-sync",
      }),
    ),
  )
  extensionRowId = result.id
  await ctx.emit(
    JSON.stringify({
      entity: "account",
      action: "create",
      entityId: result.id,
      data: { id: result.id, provider, emailAddress: identifier },
    }),
  )
  const jobName = provider === "gmail" ? "gmail-initial-sync" : "imap-initial-sync"
  // The rescue's id: a rescue or a "Sync now" right after the connect joins this
  // job instead of starting a second chain.
  await ctx.enqueueJob(
    jobName,
    JSON.stringify({ orgId: event.orgId, accountId: extensionRowId }),
    JSON.stringify({ jobId: `${jobName}:${extensionRowId}` }),
  )
  ctx.log_info("Mail account connected", JSON.stringify({ extensionRowId, provider }))
}

async function onAccountDisconnected(event: MailKernelDisconnectEvent, ctx: MailCtx) {
  if (event.data?.appName !== "mail") return
  const connectedAccountId = event.data.id
  const rows: AccountRow[] = JSON.parse(
    await ctx.db_findMany("accounts", JSON.stringify({ where: { connectedAccountId } })),
  )
  if (rows.length > 0) {
    const row = rows[0]
    // The mailbox is marked disconnected and its imported conversations,
    // messages, drafts, attachments and search documents deleted, in one host
    // transaction (kept when the address was reconnected meanwhile). The account
    // row stays.
    const purged = JSON.parse(await ctx.mail_purgeDisconnectedAccount(row.id)) as {
      kept?: boolean
    }
    if (purged.kept) return
    await ctx.db_update(
      "accounts",
      row.id,
      JSON.stringify({
        syncStatus: "disconnected",
        disconnectedAt: new Date().toISOString(),
        lastSyncError: null,
      }),
    )
    await ctx.emit(
      JSON.stringify({
        entity: "account",
        action: "update",
        entityId: row.id,
        data: { id: row.id, syncStatus: "disconnected" },
      }),
    )
  }
}

// --- Tool handlers ---

async function convertToTicket(params: unknown, ctx: MailCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const conversationId = ensureMailString(p.conversationId, "conversationId")
  const inboxId = ensureMailString(p.inboxId, "inboxId")
  const source = JSON.parse(await ctx.mail_conversion_readConversation(conversationId))
  if (source.error) return source
  if (source.conversation.status === "escalated" && source.conversation.escalated_ticket_id) {
    return {
      ticketId: source.conversation.escalated_ticket_id,
      ticketHandle: source.conversation.escalated_ticket_handle ?? null,
      idempotent: true,
    }
  }
  if (!Array.isArray(source.messages) || source.messages.length === 0) {
    return {
      error: {
        code: "empty_conversation",
        message: "conversation has no messages",
        retryable: false,
      },
    }
  }
  // ── Blueprint Task 9.7, spec section 5.6 ─────────────────────────────────
  //
  // `app_tickets.tickets` is TEAM VISIBLE. Converting a message out of an
  // end-to-end encrypted personal mailbox is therefore not a copy, it is a
  // DISCLOSURE, and it is the one place in this design where plaintext becomes
  // durably readable by other people on purpose. Two things follow, and neither
  // is optional:
  //
  //   1. The server cannot do it. It holds ciphertext; the readable text has to
  //      come from the mailbox owner's own browser.
  //   2. The owner has to have SEEN what becomes readable before it does. The
  //      disclosure sentence below is what the client shows, and the client
  //      answers with `consented: true` only after the owner said yes. An answer
  //      without that flag is refused, not treated as a default yes.
  //
  // The resulting ticket is plaintext by design. That is the point of converting.
  const conversionSupplied = (p as any).__mailboxConversion as
    | {
        consented?: boolean
        messages?: Record<
          string,
          { subject?: string | null; textBody?: string | null; htmlBody?: string | null }
        >
      }
    | undefined
  let convertedMessageIds: string[] = []
  const conversionAccount = source.conversation?.account_id
    ? JSON.parse(await ctx.db_findOne("accounts", source.conversation.account_id))
    : null
  if (mailAccountContentSuppressed(conversionAccount)) {
    const messageIds = source.messages
      .map((m: any) => m?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    if (!conversionSupplied) {
      return {
        needsPlaintext: {
          requestKind: "mail.convert",
          messageIds,
          purpose: "escalate this conversation into a team ticket",
          disclosure:
            "This will make the message body and subject readable by everyone with access to this inbox.",
        },
        note: "No ticket was created. This mailbox is end-to-end encrypted, so converting it is a deliberate disclosure: the mailbox owner has to confirm it in their own browser first.",
      }
    }
    const suppliedMessages = conversionSupplied.messages ?? {}
    const hasReadableText = messageIds.some((id: string) => {
      const supplied = suppliedMessages[id]
      return Boolean(supplied?.textBody || supplied?.htmlBody)
    })
    if (conversionSupplied.consented !== true || !hasReadableText) {
      return {
        error: {
          code: "MAILBOX_LOCKED",
          message:
            "No ticket was created. The mailbox owner did not confirm making this conversation readable by the team, or no readable copy was supplied.",
        },
      }
    }
    // Merge the supplied plaintext onto the envelope rows the server already
    // holds. The envelope (sender, recipients, timestamps) is cleartext by
    // section 2.1 and stays authoritative; only the sealed fields come from the
    // client, so a client cannot rewrite who a message was from.
    source.messages = source.messages.map((m: any) => {
      const supplied = typeof m?.id === "string" ? suppliedMessages[m.id] : undefined
      if (!supplied) return m
      return {
        ...m,
        subject: supplied.subject ?? m.subject,
        textBody: supplied.textBody ?? m.textBody,
        htmlBody: supplied.htmlBody ?? m.htmlBody,
      }
    })
    convertedMessageIds = messageIds.filter((id: string) => Boolean(suppliedMessages[id]))
    const firstSuppliedSubject = convertedMessageIds
      .map((id: string) => suppliedMessages[id]?.subject)
      .find((s): s is string => typeof s === "string" && s.length > 0)
    if (firstSuppliedSubject && !source.conversation.subject) {
      source.conversation.subject = firstSuppliedSubject
    }
  }
  const idempotencyKey =
    (p.idempotencyKey as string | undefined) ?? `mail:convert:${conversationId}`
  const inbound = source.messages.find((m: any) => m.direction === "inbound" && m.fromEmail)
  const outbound = source.messages.find((m: any) => m.direction === "outbound" && m.toEmails?.[0])
  const contactSource = inbound ?? outbound
  // BL-73: the conversation already carries the authoritative contact link
  // (`contact_id`). Inherit it directly so the new ticket is linked to the SAME
  // contact — independent of whether the message headers still parse. Fall back to
  // deriving + resolving from the sender's email only when the conversation has no
  // linked contact (e.g. a brand-new inbound from an unknown sender).
  const conversationContactId =
    typeof source.conversation.contact_id === "string" ? source.conversation.contact_id : null
  const contact =
    conversationContactId || contactSource
      ? {
          id: conversationContactId ?? undefined,
          email: contactSource?.fromEmail ?? contactSource?.toEmails?.[0],
          name: contactSource?.fromName,
        }
      : null
  const created = JSON.parse(
    await ctx.executeTool(
      "tickets:createFromMail",
      JSON.stringify({
        idempotencyKey,
        sourceConversationId: conversationId,
        sourceInboxId: inboxId,
        contact,
        subject: (p.subject as string | undefined) ?? source.conversation.subject ?? "(no subject)",
        priority: p.priority,
        categoryId: p.categoryId,
        assigneeId: p.assigneeId,
        messages: source.messages,
      }),
    ),
  )
  if (created.error || created.blocked) return created
  const { ticketId, ticketHandle, priority, assignedTo, categoryId } = created.data
  let noteAdded = false
  if (typeof p.note === "string" && p.note.length > 0) {
    const noted = JSON.parse(
      await ctx.executeTool(
        // addNote is not idempotent — its manifest declares only
        // {ticketId, text, attachmentSessionId} and the handler ignores any
        // idempotencyKey, so passing one trips strict param validation
        // ("not a recognised parameter"). The convert flow's idempotency is
        // already provided by createFromMail (which returns the existing ticket
        // on retry) and the status==="escalated" short-circuit above, so a
        // re-convert never reaches this addNote a second time.
        "tickets:addNote",
        JSON.stringify({ ticketId, text: p.note }),
      ),
    )
    if (noted.error || noted.blocked) {
      await ctx.executeTool(
        "tickets:deleteIfUnreferenced",
        JSON.stringify({ ticketId, idempotencyKey }),
      )
      return noted
    }
    noteAdded = true
  }
  const marked = JSON.parse(
    await ctx.mail_conversion_markConverted(conversationId, ticketId, ticketHandle),
  )
  if (marked.error) {
    await ctx.executeTool(
      "tickets:deleteIfUnreferenced",
      JSON.stringify({ ticketId, idempotencyKey }),
    )
    return marked
  }
  // Task 9.7: the disclosure is audited with the acting user, the conversation
  // and the message ids, and NEVER the content. What became team-readable is
  // recoverable from the ticket itself; the audit row exists to record that the
  // owner made that choice, not to keep a second copy of their mail.
  if (convertedMessageIds.length > 0) {
    try {
      await ctx.emit(
        JSON.stringify({
          entity: "conversation",
          action: "disclosed_to_team",
          entityId: conversationId,
          data: {
            conversationId,
            ticketId,
            inboxId,
            messageIds: convertedMessageIds,
            messageCount: convertedMessageIds.length,
            consented: true,
          },
        }),
      )
    } catch (err) {
      // The disclosure already happened; failing the convert over its audit row
      // would leave a ticket nobody asked for. Log loudly instead.
      ctx.log_error(
        "mail.convertToTicket disclosure audit failed",
        JSON.stringify({ conversationId, ticketId, err: String(err) }),
      )
    }
  }
  // BL-78: return the applied state so the convert is self-verifying — the
  // atomic call set priority/assignee/category, and the conversation is now
  // escalated. (assignedTo reflects a resolved "me" sentinel.) `noteAdded`
  // confirms the optional internal note was recorded in this same call, so the
  // agent (and the judge) can see the hand-off note took effect WITHOUT a
  // separate tickets:addNote toolEvent (the nested addNote never surfaces).
  return {
    ticketId,
    ticketHandle,
    priority,
    assignedTo,
    categoryId,
    escalated: true,
    noteAdded,
  }
}

// The settings page's mailbox providers (tools providers.get / providers.set).
async function providersGet(_params: unknown, ctx: MailCtx): Promise<unknown> {
  return JSON.parse(await ctx.mail_providersGet())
}
async function providersSet(params: unknown, ctx: MailCtx): Promise<unknown> {
  return JSON.parse(await ctx.mail_providersSet(JSON.stringify(params ?? {})))
}

async function createFromTicket(params: unknown, ctx: MailCtx): Promise<unknown> {
  return JSON.parse(await ctx.mail_createFromTicket(JSON.stringify(params ?? {})))
}

async function appendInboundMessage(params: unknown, ctx: MailCtx): Promise<unknown> {
  const p = (params ?? {}) as {
    conversationId?: string
    message?: unknown
    idempotencyKey?: string
  }
  const conversationId = ensureMailString(p.conversationId, "conversationId")
  return JSON.parse(
    await ctx.mail_appendInboundMessage(
      conversationId,
      JSON.stringify(p.message ?? {}),
      p.idempotencyKey,
    ),
  )
}

const LIST_ACCOUNTS_NOTE = "Only what this person can use: the organization may have others."

async function listAccounts(params: { includeDisconnected?: boolean }, ctx: MailCtx) {
  const allRows: AccountRow[] = JSON.parse(await ctx.db_findMany("accounts", JSON.stringify({})))
  const rows = params.includeDisconnected
    ? allRows
    : allRows.filter((r) => r.sync_status !== "disconnected")
  let gmailAccounts: KernelAccount[] = []
  let imapAccounts: KernelAccount[] = []
  try {
    gmailAccounts = JSON.parse(await ctx.connections_getAccounts("gmail"))
  } catch {}
  try {
    imapAccounts = JSON.parse(await ctx.connections_getAccounts("imap"))
  } catch {}
  const kernelMap = new Map<string, KernelAccount>()
  for (const a of [...gmailAccounts, ...imapAccounts]) kernelMap.set(a.id, a)
  // An account in error says why and when it is tried again, so "is the
  // mailbox working?" is answered from this one list (the agent otherwise
  // reports "it is in error, I can't tell why").
  const accounts = rows.map((row) => {
    const kernel = kernelMap.get(row.connected_account_id)
    const nextRetryAt =
      typeof row.sync_state?.nextRetryAt === "string" ? row.sync_state.nextRetryAt : null
    return {
      id: row.id,
      provider: row.provider,
      emailAddress: row.email_address,
      displayName: row.display_name,
      syncStatus: row.sync_status,
      lastSyncAt: row.last_sync_at,
      lastSyncError: row.last_sync_error,
      nextRetryAt,
      ownerType: row.owner_type,
      kernelStatus: kernel?.status,
      kernelDisplayName: kernel?.displayName,
      ...(row.provider === "imap"
        ? { serverSync: imapServerSync(row.sync_state?.capabilities, row.sync_state) }
        : {}),
    }
  })
  // RLS and inbox grants decide what this person sees here. An agent told "the
  // mailboxes connected to this org" read an empty list as "this org has no
  // mailbox", to a person whose org has five.
  return { accounts, note: LIST_ACCOUNTS_NOTE }
}

/**
 * What an IMAP mailbox keeps in step with its server, from the capabilities
 * the sync recorded (the bundle's copy of `imapSyncSummary` in
 * packages/shared/src/imap-login-failures.ts, which it cannot import). Null
 * before the first sync read them.
 */
function imapServerSync(capabilities: any, syncState?: any): Record<string, unknown> | null {
  if (!capabilities || typeof capabilities !== "object") return null
  const folders = capabilities.folders ?? {}
  const has = (key: string) => typeof folders[key] === "string" && folders[key] !== ""
  return {
    readAndStar: true,
    archive: (capabilities.gmail === true && has("all")) || has("archive"),
    trash: has("trash"),
    sent: has("sent"),
    archiveReadBack: syncState?.inboxTracked !== false,
    pollMinutes: 2,
  }
}

async function getAccount(params: { accountId: string }, ctx: MailCtx) {
  const row: AccountRow | null = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
  if (!row) throw new Error("Account not found")
  let kernelStatus: string | undefined
  let kernelDisplayName: string | null | undefined
  try {
    const provider = row.provider === "gmail" ? "gmail" : "imap"
    const accounts: KernelAccount[] = JSON.parse(await ctx.connections_getAccounts(provider))
    const kernel = accounts.find((a) => a.id === row.connected_account_id)
    if (kernel) {
      kernelStatus = kernel.status
      kernelDisplayName = kernel.displayName
    }
  } catch {}
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.email_address,
    displayName: row.display_name,
    syncStatus: row.sync_status,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
    ownerType: row.owner_type,
    connectedAccountId: row.connected_account_id,
    kernelStatus,
    kernelDisplayName,
  }
}

async function disconnectAccount(params: { accountId: string }, ctx: MailCtx) {
  const row: AccountRow | null = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
  if (!row) throw new Error("Account not found")
  if (row.owner_type === "org") {
    const isAdmin = await ctx.hasScope("mail:accounts:admin")
    if (!isAdmin) throw new Error("Admin scope required to disconnect org-level accounts")
  }
  await ctx.connections_disconnect(row.connected_account_id)
  return { success: true }
}

async function getSyncStatus(params: { accountId: string }, ctx: MailCtx) {
  const row: AccountRow | null = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
  if (!row) throw new Error("Account not found")
  return {
    syncStatus: row.sync_status,
    lastSyncAt: row.last_sync_at,
    lastSyncError: row.last_sync_error,
  }
}

/**
 * A personal mailbox fetches no mail until its owner has enrolled in mailbox
 * encryption. `pending_enrollment`, `blocked` and `paused` all mean "do not
 * fetch": a mailbox that keeps writing plaintext while the product claims zero
 * access is the one outcome no wording can make honest. Nothing is lost, the
 * messages stay at the provider until the user finishes enrolling.
 *
 * An org (shared) mailbox is never suspended: it is not in the encryption
 * regime at all.
 *
 * A row read before the `encryption_state` column existed reports `undefined`.
 * That is treated as NOT ready, deliberately: the only window in which it can
 * happen is the deploy that introduces the feature, and pausing a mailbox for a
 * few seconds is recoverable while writing plaintext into it is not.
 */
function isSyncableAccount(account: AccountRow | null | undefined): boolean {
  if (!account) return false
  if (account.owner_type !== "user") return true
  // `managed` is sealed by the server under the mailbox's own key: it syncs.
  return account.encryption_state === "ready" || account.encryption_state === "managed"
}

/**
 * The one place a skip is explained. Every suspension logs the account and the
 * state, so a mailbox that has gone quiet is diagnosable from the logs alone
 * rather than by reading this function.
 */
function logSyncSuspended(account: AccountRow, where: string, ctx: MailCtx): void {
  ctx.log_debug(
    "Mail sync suspended: personal mailbox is not enrolled in encryption",
    JSON.stringify({
      accountId: account.id,
      encryptionState: account.encryption_state ?? null,
      path: where,
    }),
  )
}

async function loadSyncableAccounts(
  provider: string,
  payload: { accountId?: string },
  ctx: MailCtx,
): Promise<any[]> {
  // THREE return paths, all guarded. The early return below is the one every
  // targeted sync takes, including the Gmail push wake and every per-account
  // job re-enqueue, so it is the primary inbound-mail path: leaving it
  // unguarded would mean the listing branches look correct while mail keeps
  // arriving.
  if (payload.accountId) {
    const account = JSON.parse(await ctx.db_findOne("accounts", payload.accountId))
    if (!account) return []
    if (!isSyncableAccount(account)) {
      logSyncSuspended(account, "accountId", ctx)
      return []
    }
    return [account]
  }
  const active = JSON.parse(
    await ctx.db_findMany(
      "accounts",
      JSON.stringify({
        where: { provider, syncStatus: "active" },
      }),
    ),
  )
  // Mid-backfill accounts with a seeded historyId sync incrementally too: the
  // initial-sync chain pages a newest-first snapshot, so mail arriving DURING
  // the backfill is only reachable through the history API. Without this, a
  // long import means hours-days of no new mail.
  const backfilling = JSON.parse(
    await ctx.db_findMany(
      "accounts",
      JSON.stringify({
        where: { provider, syncStatus: "syncing" },
      }),
    ),
  ).filter((a: any) => a.sync_state?.historyId)
  const syncable: any[] = []
  for (const account of [...active, ...backfilling]) {
    if (!isSyncableAccount(account)) {
      logSyncSuspended(account, account.sync_status === "syncing" ? "backfilling" : "active", ctx)
      continue
    }
    syncable.push(account)
  }
  return syncable
}

// --- Job handlers ---

/** Pause between initial-sync page jobs. Each page is ~100 messages, so 3s
 *  paces a full-history import at ~2k messages/minute -- fast enough to chew
 *  through a big mailbox in the background, slow enough that the worker pool,
 *  the DB, and the Gmail quota never saturate. New mail is unaffected: the
 *  incremental path does not use this chain. */
const INITIAL_SYNC_PAGE_DELAY_MS = 3000
// Cap on how many messages ONE incremental-sync invocation processes before it
// checkpoints (historyId is persisted per page) and hands the rest of a large
// backlog to a fresh PACED run. Without it, an account far behind (a big
// post-outage gap / a mailbox that fell behind) paged its ENTIRE history delta in a
// single sandbox invocation and ran the QuickJS heap out of memory ("InternalError:
// out of memory"), which then thrashed EVERY mail tool call (search included) as the
// sync OOM-looped each minute. Mirrors the initial sync's bounded-page + re-enqueue
// (which caps at 25/page because 100 sequential format=full fetches blew the job
// budget), so keep this modest: normal deltas are a handful of messages and never
// trip it; only a big backlog catch-up does, then trickles through paced continuations.
const INCREMENTAL_RUN_MESSAGE_BUDGET = 50

/** Job id for the paced continuation of an incremental run. Unique per hop: a
 *  continuation enqueues its successor while it is itself still the ACTIVE job,
 *  and BullMQ silently ignores an add whose id already exists, so a fixed
 *  per-account id let a chain run exactly one hop after any external trigger
 *  (prod 2026-09-13: a backlog replay stalled after every second run with no
 *  error anywhere). */
function continuationJobId(accountId: string): string {
  return `gmail-incremental-continue:${accountId}:${Date.now()}`
}

/** Gmail push topic from app config (`gmailPushTopic`, e.g.
 *  "projects/acme-support/topics/gmail-push"). Deployment-specific, so it
 *  is NEVER hardcoded; null when unset -> the deployment runs poll-only. */
async function resolveGmailPushTopic(ctx: MailCtx): Promise<string | null> {
  try {
    const topic = await ctx.config_get?.("gmailPushTopic")
    return typeof topic === "string" && topic.length > 0 ? topic : null
  } catch {
    return null
  }
}

/** users.watch with the configured topic. Returns null when no topic is
 *  configured or the call fails -- callers fall back to poll-only. */
async function registerGmailWatch(
  ctx: MailCtx,
  token: string,
): Promise<{ historyId?: string; expiration?: string } | null> {
  const topic = await resolveGmailPushTopic(ctx)
  if (!topic) return null
  try {
    const watchRes = JSON.parse(
      await ctx.fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/watch",
        JSON.stringify({
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ topicName: topic, labelIds: ["INBOX"] }),
        }),
      ),
    )
    if (watchRes.status !== 200) {
      ctx.log_warn(
        "Failed to register Gmail watch",
        JSON.stringify({ status: watchRes.status, topic }),
      )
      return null
    }
    return JSON.parse(watchRes.body || "{}")
  } catch {
    ctx.log_warn("Failed to register Gmail watch", JSON.stringify({ topic }))
    return null
  }
}

/** Current mailbox historyId via users.getProfile -- the pushless way to seed
 *  the incremental-sync cursor. */
async function fetchGmailProfileHistoryId(ctx: MailCtx, token: string): Promise<string | null> {
  try {
    const profileRes = JSON.parse(
      await ctx.fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
      ),
    )
    if (profileRes.status !== 200) return null
    const historyId = JSON.parse(profileRes.body || "{}").historyId
    return historyId ? String(historyId) : null
  } catch {
    return null
  }
}

/** Marker appended to a degraded message's snippet/body when its full payload
 *  could not be synced (oversized attachment blew the sandbox fetch cap). It is
 *  visible to the agent and the UI so the reader knows the body is incomplete. */
const OVERSIZED_MESSAGE_MARKER = "[attachment too large to sync; open in Gmail]"

/** True when a per-message fetch error is the sandbox bridge's response-size
 *  cap (`Response body exceeds 1000000 bytes`). Such a message has a
 *  base64-inflated attachment > ~700 KB; format=full is unfetchable through the
 *  bridge, so we fall back to format=metadata (headers only). */
function isOversizedResponseError(err: unknown): boolean {
  return /exceeds .* bytes/i.test(String(err))
}

/** True for the QuickJS execution-deadline error ("InternalError: interrupted"). */
function isSandboxInterrupt(err: unknown): boolean {
  return String(err).includes("interrupted")
}

/** Delay before a run that hit the Gmail per-user rate limit continues. */
const RATE_LIMIT_CONTINUE_DELAY_MS = 60_000

/** True for a Gmail per-user rate limit: HTTP 429, or 403 carrying the
 *  "Quota exceeded" / rateLimitExceeded body. Other 403s (missing scope) are
 *  not retried. */
function isGmailRateLimit(err: unknown): boolean {
  const text = String(err)
  if (/HTTP 429\b/.test(text)) return true
  return (
    /HTTP 403\b/.test(text) && /quota exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(text)
  )
}

/** Result of a resilient per-message fetch. `record` is null when the message
 *  could not be ingested at all (metadata fallback also failed / a non-oversized
 *  error) -- the caller skips it. `degraded` is true when the body is empty
 *  because only metadata could be fetched. */
type ResilientMessageFetch =
  | { record: ReturnType<typeof normalizeGmailMessage>; degraded: false }
  | { record: ReturnType<typeof normalizeGmailMessage>; degraded: true }
  | { record: null; degraded: false }

/** Fetch a single Gmail message with per-message resilience so one bad message
 *  never kills the whole sync job:
 *   - format=full succeeds -> full record.
 *   - format=full throws the bridge size cap -> retry the SAME message with
 *     format=metadata (small, safe) and build a body-less record carrying the
 *     oversized marker. Attachments are skipped (no parts fetched).
 *   - any other error, a non-200, or a failed metadata fallback -> skip
 *     (record: null); the caller counts it and continues the page. */
async function fetchGmailMessageResilient(
  messageId: string,
  token: string,
  ctx: MailCtx,
  accountId: string,
): Promise<ResilientMessageFetch> {
  try {
    const msgRes = JSON.parse(
      await ctx.fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}${buildQueryString({ format: "full" })}`,
        JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
      ),
    )
    if (msgRes.status !== 200) {
      ctx.log_warn(
        "Skipping Gmail message fetch with non-200 status",
        JSON.stringify({ accountId, messageId, status: msgRes.status }),
      )
      return { record: null, degraded: false }
    }
    return { record: normalizeGmailMessage(JSON.parse(msgRes.body)), degraded: false }
  } catch (err) {
    // The sandbox execution deadline is not a bad message: swallowing it here
    // would record the message as "skipped" and let the page continue on a
    // budget that is already gone. Let it unwind to the run-level catch, which
    // schedules the paced continuation.
    if (isSandboxInterrupt(err)) throw err
    if (!isOversizedResponseError(err)) {
      // A single bad message must never kill the page: log and skip.
      ctx.log_warn(
        "Skipping Gmail message after fetch error",
        JSON.stringify({ accountId, messageId, error: String(err) }),
      )
      return { record: null, degraded: false }
    }

    // Oversized: fall back to metadata (headers + snippet), no attachment parts.
    try {
      const metaRes = JSON.parse(
        await ctx.fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}${buildQueryString({ format: "metadata" })}`,
          JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
        ),
      )
      if (metaRes.status !== 200) {
        ctx.log_warn(
          "Skipping oversized Gmail message: metadata fallback non-200",
          JSON.stringify({ accountId, messageId, status: metaRes.status }),
        )
        return { record: null, degraded: false }
      }
      const meta = JSON.parse(metaRes.body)
      const record = normalizeGmailMessage(meta)
      // format=metadata carries no parts, so normalize produced an empty body.
      // Surface a marker in both the snippet (conversation preview) and the body
      // so the UI/agent can see why the content is missing.
      const providerSnippet = typeof meta.snippet === "string" ? meta.snippet : ""
      record.snippet = `${providerSnippet} ${OVERSIZED_MESSAGE_MARKER}`.trim().slice(0, 200)
      record.textBody = `${providerSnippet}\n\n${OVERSIZED_MESSAGE_MARKER}`.trim()
      record.htmlBody = ""
      record.attachments = []
      ctx.log_warn(
        "Gmail message too large for full sync; ingested from metadata (body skipped)",
        JSON.stringify({ accountId, messageId }),
      )
      return { record, degraded: true }
    } catch (metaErr) {
      if (isSandboxInterrupt(metaErr)) throw metaErr
      ctx.log_warn(
        "Skipping oversized Gmail message: metadata fallback failed",
        JSON.stringify({ accountId, messageId, error: String(metaErr) }),
      )
      return { record: null, degraded: false }
    }
  }
}

/** Re-enqueue the initial sync for accounts stranded before `active`:
 *  `pre-sync` (connect-time initial-sync job lost) or `syncing` (job died
 *  mid-run; it resumes from syncState.cursor). The scheduled incremental sync
 *  only sees `active` accounts, so without this sweep a lost one-shot job
 *  strands the account FOREVER with no error and no retry (seen in production:
 *  a mailbox connected one day was still pre-sync the next).
 *  The fixed jobId dedupes against a genuinely in-flight initial job, so this
 *  is safe to run every tick. */
/** An account whose row moved more recently than this is presumed to have a LIVE
 *  initial-sync chain (page jobs save cursor progress every few seconds), so the
 *  rescue sweep must leave it alone: the chain's page jobs carry no custom jobId,
 *  so a rescue add is NOT deduped against them and would run a SECOND initial
 *  sync on the same account concurrently -- the two jobs then fight over the
 *  accounts row lock (prod 2026-07-11: repeated "canceling statement due to
 *  statement timeout ... while updating tuple in relation accounts"). */
const INITIAL_SYNC_RESCUE_STALL_MS = 15 * 60_000

async function reenqueueStrandedInitialSyncs(
  provider: "gmail" | "imap",
  orgId: string,
  ctx: MailCtx,
): Promise<void> {
  const jobName = provider === "gmail" ? "gmail-initial-sync" : "imap-initial-sync"
  for (const syncStatus of ["pre-sync", "syncing"]) {
    const stranded: any[] = JSON.parse(
      await ctx.db_findMany("accounts", JSON.stringify({ where: { provider, syncStatus } })),
    )
    for (const account of stranded) {
      if (account.disconnected_at) continue
      // A personal mailbox waiting for its owner's encryption enrollment (or
      // blocked, or paused) is NOT stranded: its initial sync would only log
      // "suspended" and exit, and re-enqueueing it every tick polled it every
      // five minutes forever (prod 2026-09-30). It stays quiet here. The owner
      // is told by the `kernel.mailbox_enrollment` attention item, and
      // enrollment itself enqueues the sync (mailbox-keys/routes.ts).
      if (!isSyncableAccount(account)) continue
      // Only rescue accounts whose CHAIN looks genuinely stalled. Prefer the
      // chain's own pageSavedAt marker: updated_at is also refreshed by the
      // concurrent incremental sync, which would mask a dead chain forever.
      // Missing/unparsable timestamps rescue (fail open: better a rare
      // duplicate than a wedge).
      const progressRaw = account.sync_state?.pageSavedAt ?? account.updated_at
      const progressMs = progressRaw ? Date.parse(progressRaw) : Number.NaN
      if (Number.isFinite(progressMs) && Date.now() - progressMs < INITIAL_SYNC_RESCUE_STALL_MS) {
        continue
      }
      await ctx.enqueueJob(
        jobName,
        JSON.stringify({ orgId, accountId: account.id }),
        JSON.stringify({ jobId: `${jobName}:${account.id}` }),
      )
    }
  }
  // A failed IMAP sync that can pass later (not a refused login: that waits
  // for a reconnect) is tried again once its `nextRetryAt` has come.
  if (provider !== "imap") return
  const failed: any[] = JSON.parse(
    await ctx.db_findMany("accounts", JSON.stringify({ where: { provider, syncStatus: "error" } })),
  )
  for (const account of failed) {
    if (account.disconnected_at || !isSyncableAccount(account)) continue
    const due = Date.parse(account.sync_state?.nextRetryAt ?? "")
    if (!Number.isFinite(due) || due > Date.now()) continue
    await ctx.enqueueJob(
      jobName,
      JSON.stringify({ orgId, accountId: account.id }),
      JSON.stringify({
        jobId: `${jobName}:${account.id}:retry-${account.sync_state?.failedAttempts ?? 0}`,
      }),
    )
  }
}

async function gmailInitialSync(payload: { orgId: string; accountId: string }, ctx: MailCtx) {
  const account: AccountRow | null = JSON.parse(await ctx.db_findOne("accounts", payload.accountId))
  if (!account) {
    ctx.log_error("Account not found")
    return
  }
  if (account.disconnected_at) {
    ctx.log_info("Account disconnected, skipping sync")
    return
  }
  // The initial sync does NOT go through loadSyncableAccounts: it is entered by
  // job id, and `reenqueueStrandedInitialSyncs` re-enqueues it on every tick for
  // any account still at `pre-sync` or `syncing`. Without this guard a personal
  // mailbox that was mid-backfill at the deploy would keep importing plaintext.
  if (!isSyncableAccount(account)) {
    logSyncSuspended(account, "gmailInitialSync", ctx)
    return
  }

  // Only transition the row on the FIRST chain job. The job's transaction spans
  // the whole handler (including ~25 sequential Gmail fetches), so an early
  // UPDATE takes the accounts row lock for the job's full lifetime and anything
  // else touching the row (incremental sync, a rescue add) blows its statement
  // timeout waiting. Skipping the no-op write keeps the lock window down to the
  // end-of-page cursor save.
  if (account.sync_status !== "syncing") {
    await ctx.db_update("accounts", account.id, JSON.stringify({ syncStatus: "syncing" }))
  }

  const syncState = account.sync_state ?? {}
  const cursor = syncState.cursor ?? null
  let messagesSynced = syncState.messagesSynced ?? 0
  const token = await ctx.connections_getToken("gmail", account.email_address)

  // Seed the incremental cursor + push watch UP FRONT, not at backfill
  // completion. The messages.list chain pages a newest-first snapshot, so mail
  // arriving DURING a long backfill is on pages already consumed -- with the
  // cursor seeded only at the end, that mail was skipped entirely and nothing
  // new showed up until the whole history import finished (hours-days on a big
  // mailbox). Seeding first lets the scheduled incremental sync deliver new
  // mail in parallel with the backfill. Baseline: the newest ALREADY-SYNCED
  // message's own historyId when one exists (covers the gap between the list
  // snapshot and now); otherwise the watch/profile historyId.
  if (!syncState.historyId) {
    let seedHistoryId: string | null = null
    try {
      const newest = JSON.parse(
        await ctx.db_findMany(
          "messages",
          JSON.stringify({
            where: { accountId: account.id },
            orderBy: { sentAt: "desc" },
            limit: 1,
          }),
        ),
      ) as Array<{ external_provider_id?: string }>
      const newestProviderId = newest[0]?.external_provider_id
      if (newestProviderId) {
        const minRes = JSON.parse(
          await ctx.fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(newestProviderId)}${buildQueryString({ format: "minimal" })}`,
            JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
          ),
        )
        if (minRes.status === 200) {
          const hid = JSON.parse(minRes.body || "{}").historyId
          if (hid) seedHistoryId = String(hid)
        }
      }
    } catch (err) {
      ctx.log_warn(
        "Gmail history seed from newest message failed; falling back to profile",
        JSON.stringify({ accountId: account.id, error: String(err) }),
      )
    }
    const watch = await registerGmailWatch(ctx, token)
    if (watch?.expiration) syncState.watchExpiry = watch.expiration
    if (!seedHistoryId) seedHistoryId = watch?.historyId ?? null
    if (!seedHistoryId) seedHistoryId = await fetchGmailProfileHistoryId(ctx, token)
    if (seedHistoryId) {
      syncState.historyId = seedHistoryId
      await ctx.db_update(
        "accounts",
        account.id,
        JSON.stringify({ syncState: { ...syncState, cursor, messagesSynced } }),
      )
    }
  }

  // Fetch one page of messages. Page size is bounded by the sandbox execution
  // budget, not by Gmail: every message is a separate sequential format=full
  // fetch through the bridge, so 100/page blew the job timeout on real
  // mailboxes -- the transaction rolled back, the retry redid the SAME page,
  // and the import made zero progress forever. 25/page finishes each job in
  // seconds; the paced chain absorbs the extra page count.
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages${buildQueryString({
    maxResults: 25,
    pageToken: cursor,
  })}`

  const listRes = JSON.parse(
    await ctx.fetch(
      listUrl,
      JSON.stringify({
        headers: { Authorization: `Bearer ${token}` },
      }),
    ),
  )
  const listBody = JSON.parse(listRes.body || "{}")

  if (listBody.messages && listBody.messages.length > 0) {
    // The page is written as a page (see createPageWriter): fetched one message
    // at a time, buffered under a heap byte budget, stored in a handful of
    // bridge calls. A page retried after a rollback/interrupt re-lists messages
    // already stored; ONE lookup finds them all, so the retry skips their
    // fetch and always progresses.
    const stored = await storedProviderIds(
      account.id,
      listBody.messages.map((msgRef: { id: string }) => msgRef.id),
      ctx,
    )
    const writer = createPageWriter(account, ctx, "initial")
    let ingested = 0
    let degradedCount = 0
    let skippedCount = 0
    for (const msgRef of listBody.messages) {
      if (stored.has(msgRef.id)) continue
      const fetched = await fetchGmailMessageResilient(msgRef.id, token, ctx, account.id)
      if (!fetched.record) {
        skippedCount++
        continue
      }
      if (fetched.degraded) degradedCount++
      await writer.add(fetched.record)
      ingested++
    }
    await writer.flush()
    messagesSynced += ingested

    if (degradedCount > 0 || skippedCount > 0) {
      ctx.log_info(
        "Gmail initial sync page completed with degraded messages",
        JSON.stringify({
          accountId: account.id,
          ingested,
          degraded: degradedCount,
          skipped: skippedCount,
        }),
      )
    }

    const nextCursor = listBody.nextPageToken ?? null

    // Save progress. Re-read the row first: the incremental sync runs
    // concurrently with the backfill and advances syncState.historyId; writing
    // this job's start-of-run snapshot back would regress it (harmless replay,
    // but wasteful). pageSavedAt is the CHAIN's own liveness marker -- the
    // rescue sweep and /diag key off it, since updated_at is also refreshed by
    // the incremental writer.
    const freshSave = JSON.parse(await ctx.db_findOne("accounts", account.id))
    const freshSaveState = freshSave?.sync_state ?? {}
    if (freshSaveState.historyId) syncState.historyId = freshSaveState.historyId
    if (freshSaveState.watchExpiry) syncState.watchExpiry = freshSaveState.watchExpiry
    await ctx.db_update(
      "accounts",
      account.id,
      JSON.stringify({
        syncState: {
          ...syncState,
          cursor: nextCursor,
          messagesSynced,
          pageSavedAt: new Date().toISOString(),
        },
      }),
    )

    // More pages — re-enqueue self for the next page, PACED. A full-history
    // import of a large mailbox is thousands of pages; back-to-back page jobs
    // would occupy the worker and hammer Gmail + the DB continuously for
    // hours. The inter-page delay keeps the chain a background trickle the
    // rest of the system never feels, while progress (cursor) persists above.
    if (nextCursor) {
      await ctx.enqueueJob(
        "gmail-initial-sync",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
        JSON.stringify({ delay: INITIAL_SYNC_PAGE_DELAY_MS }),
      )
      return
    }
  }

  // All pages done — finalize and mark active. The historyId cursor is
  // normally seeded up front (above); this fallback covers a chain whose
  // up-front seed failed. Without a historyId, every incremental tick
  // re-enqueues this full initial sync, re-paging the entire mailbox forever.
  if (!syncState.historyId) {
    const watch = await registerGmailWatch(ctx, token)
    if (watch) {
      syncState.historyId = watch.historyId
      syncState.watchExpiry = watch.expiration
    } else {
      // No topic configured (or watch failed): poll-only mode. users.getProfile
      // returns the mailbox's current historyId with no push infrastructure.
      const profileHistoryId = await fetchGmailProfileHistoryId(ctx, token)
      if (profileHistoryId) {
        syncState.historyId = profileHistoryId
      } else {
        ctx.log_warn(
          "Gmail initial sync finalized without a historyId cursor; incremental sync will re-run the initial sync",
          JSON.stringify({ accountId: account.id }),
        )
      }
    }
  }

  // Same fresh-merge as the page save: don't regress a historyId the
  // concurrent incremental sync advanced during this job.
  const freshDone = JSON.parse(await ctx.db_findOne("accounts", account.id))
  const freshDoneState = freshDone?.sync_state ?? {}
  if (freshDoneState.historyId) syncState.historyId = freshDoneState.historyId
  if (freshDoneState.watchExpiry) syncState.watchExpiry = freshDoneState.watchExpiry
  await ctx.db_update(
    "accounts",
    account.id,
    JSON.stringify({
      syncStatus: "active",
      lastSyncAt: new Date().toISOString(),
      lastSyncError: null,
      syncState: { ...syncState, cursor: null, messagesSynced, pageSavedAt: undefined },
    }),
  )
  await ctx.emit(
    JSON.stringify({
      entity: "account",
      action: "update",
      entityId: account.id,
      data: { syncStatus: "active", messagesSynced },
    }),
  )
}
async function gmailIncrementalSync(
  payload: { orgId: string; accountId?: string; push?: boolean },
  ctx: MailCtx,
) {
  // Scheduled tick (no accountId): first rescue accounts stranded before
  // `active` -- they are invisible to loadSyncableAccounts and would otherwise
  // never sync again. Deliberately NOT gated on hasOnlineUsers: onboarding
  // must finish even after the user closes the tab.
  if (!payload.accountId) {
    await reenqueueStrandedInitialSyncs("gmail", payload.orgId, ctx)
  }
  const accounts = await loadSyncableAccounts("gmail", payload, ctx)

  for (const account of accounts) {
    if (account.disconnected_at) continue

    const isOnline = JSON.parse(await ctx.hasOnlineUsers(account.id))
    if (!isOnline && !payload.accountId) continue

    // A push means new mail now: skipping it would leave that mail for the next tick, minutes away.
    if (account.last_sync_at && !payload.push) {
      const elapsed = Date.now() - new Date(account.last_sync_at).getTime()
      if (elapsed < 60_000) continue
    }

    const syncState = account.sync_state ?? {}
    if (!syncState.historyId) {
      await ctx.enqueueJob(
        "gmail-initial-sync",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
        JSON.stringify({ jobId: `gmail-initial-sync:${account.id}` }),
      )
      continue
    }

    const token = await ctx.connections_getToken("gmail", account.email_address)
    const historyId = syncState.historyId
    let degradedCount = 0
    let skippedCount = 0
    let messagesThisRun = 0
    let budgetHandoff = false
    // Hoisted out of the try so the catch can tell whether this run made
    // progress before deciding to schedule its own continuation.
    let latestHistoryId: string = historyId

    try {
      // history.list is PAGINATED and must be status-checked. Consuming only
      // the first page while advancing the cursor to the response's top-level
      // historyId silently drops the rest; treating a non-200 as "no history"
      // silently drops everything (the response body has no `history` key, the
      // loop no-ops, and the success path stamps lastSyncAt as if all were
      // well). historyTypes is sent as REPEATED params, not comma-joined --
      // Gmail rejects the encoded-comma form.
      let pageToken: string | null = null
      let historyExpired = false
      do {
        const histRes = JSON.parse(
          await ctx.fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/history${buildQueryString({
              startHistoryId: historyId,
              pageToken,
              maxResults: 25,
            })}&historyTypes=messageAdded&historyTypes=messageDeleted&historyTypes=labelAdded&historyTypes=labelRemoved`,
            JSON.stringify({ headers: { Authorization: `Bearer ${token}` } }),
          ),
        )

        if (histRes.status === 404 || histRes.status === 410) {
          historyExpired = true
          break
        }
        if (histRes.status === 401) {
          throw new Error("401")
        }
        if (histRes.status !== 200) {
          throw new Error(
            `Gmail history.list HTTP ${histRes.status}: ${String(histRes.body ?? "").slice(0, 500)}`,
          )
        }

        const histBody = JSON.parse(histRes.body || "{}")
        // Skip messages already stored: a replay from an old checkpoint
        // (OOM/interrupt restart, or a mid-page hand-off below that could not
        // advance the cursor) must make forward progress instead of
        // re-fetching the same backlog forever. One lookup for the whole
        // history page, and the page's new mail is written as a page.
        const storedAdded = await storedProviderIds(
          account.id,
          (histBody.history ?? []).flatMap((record: any) =>
            (record.messagesAdded ?? []).map((added: any) => added?.message?.id),
          ),
          ctx,
        )
        const writer = createPageWriter(account, ctx, "incremental")
        for (const record of histBody.history ?? []) {
          if (record.messagesAdded) {
            for (const added of record.messagesAdded) {
              // Budget check BEFORE the fetch, not after a full page: one
              // format=full fetch materializes the response string + JSON tree +
              // decoded body on the QuickJS heap, so the bound must gate the
              // allocation itself. The prod OOM loop (2026-07-24) fired before a
              // page-granular check ever ran.
              if (messagesThisRun >= INCREMENTAL_RUN_MESSAGE_BUDGET) {
                budgetHandoff = true
                break
              }
              if (storedAdded.has(added.message.id)) continue
              // Two records of one page can add the same message: fetch it once.
              storedAdded.add(added.message.id)
              const fetched = await fetchGmailMessageResilient(
                added.message.id,
                token,
                ctx,
                account.id,
              )
              // A skipped message (404: deleted since, or an unfetchable body)
              // still cost a round trip, so it spends the run budget too. A
              // two-day replay over a purged spam folder was 80+ consecutive
              // 404s: with only stored messages counted, the run never handed
              // off and died on the sandbox execution timeout instead, with no
              // paced continuation scheduled.
              messagesThisRun++
              if (!fetched.record) {
                skippedCount++
                continue
              }
              if (fetched.degraded) degradedCount++
              await writer.add(fetched.record)
            }
            // Mid-page budget stop: this record is NOT fully consumed, so
            // latestHistoryId must not advance past it — bail out before the
            // deletion/label handling and before the record id is adopted. The
            // continuation re-lists from the checkpoint and the already-stored
            // skip above makes the replay cheap.
            if (budgetHandoff) break
          }

          // A deletion or label change may name a message still buffered by
          // this page's writer: store the buffer first.
          if (record.messagesDeleted || record.labelsAdded || record.labelsRemoved) {
            await writer.flush()
          }

          if (record.messagesDeleted) {
            const deletedIds = record.messagesDeleted
              .map((deleted: any) => deleted?.message?.id)
              .filter(Boolean)
            const existing = await messagesByProviderId(account.id, deletedIds, ctx)
            const touchedConversations = new Set<string>()
            for (const row of existing.values()) {
              await ctx.db_update(
                "messages",
                row.id,
                JSON.stringify({ labels: [...(row.labels ?? []), "TRASH"] }),
              )
              const conversationId = row.conversation_id ?? row.conversationId
              if (conversationId) touchedConversations.add(conversationId)
            }
            for (const conversationId of touchedConversations) {
              await recomputeConversationState(conversationId, account, ctx)
            }
          }

          if (record.labelsAdded || record.labelsRemoved) {
            // ONE RECORD CAN CARRY SEVERAL MESSAGES. Opening a thread in Gmail
            // reads every message in it, and Gmail reports that as one history
            // record with one `labelsRemoved` entry per message. Reading only
            // the first entry's message, and applying every entry's labels to
            // it, left the rest of the thread UNREAD here: the conversation
            // stayed unread in Liaison after it was read in Gmail. Each entry
            // is applied to its own message; each conversation is rolled up
            // once.
            const changes = new Map<string, { added: string[]; removed: string[] }>()
            const changeFor = (id: string) => {
              let change = changes.get(id)
              if (!change) {
                change = { added: [], removed: [] }
                changes.set(id, change)
              }
              return change
            }
            for (const entry of record.labelsAdded ?? []) {
              const id = entry?.message?.id
              if (id) changeFor(id).added.push(...(entry.labelIds ?? []))
            }
            for (const entry of record.labelsRemoved ?? []) {
              const id = entry?.message?.id
              if (id) changeFor(id).removed.push(...(entry.labelIds ?? []))
            }
            const touchedConversations = new Set<string>()
            const existingById = await messagesByProviderId(account.id, [...changes.keys()], ctx)
            for (const [msgId, change] of changes) {
              const existing = existingById.get(msgId)
              if (!existing) continue
              const labels = new Set<string>(existing.labels ?? [])
              for (const label of change.added) labels.add(label)
              for (const label of change.removed) labels.delete(label)
              const nextLabels = [...labels]
              await ctx.db_update(
                "messages",
                existing.id,
                JSON.stringify({
                  labels: nextLabels,
                  isRead: !nextLabels.includes("UNREAD"),
                  isStarred: nextLabels.includes("STARRED"),
                }),
              )
              const conversationId = existing.conversation_id ?? existing.conversationId
              if (conversationId) touchedConversations.add(conversationId)
            }
            for (const conversationId of touchedConversations) {
              await recomputeConversationState(conversationId, account, ctx)
            }
          }

          latestHistoryId = record.id ?? latestHistoryId
        }
        // Everything this page fetched is stored before its cursor is saved.
        await writer.flush()

        // The response's top-level historyId is the mailbox's CURRENT id --
        // only safe to adopt once every page has been consumed, which the
        // loop guarantees.
        if (!histBody.nextPageToken && histBody.historyId) {
          latestHistoryId = String(histBody.historyId)
        }
        pageToken = histBody.nextPageToken ?? null

        // Persist the cursor after EVERY fully-processed page. A long replay
        // (a big gap after an outage) can outlive the sandbox execution budget
        // ("InternalError: interrupted"); with only the end-of-run write, each
        // retry restarted the whole replay from the original cursor and
        // re-fetched the same messages. Page-level persistence makes an
        // interrupted run resume from the last completed page.
        if (latestHistoryId !== historyId) {
          const freshPage = JSON.parse(await ctx.db_findOne("accounts", account.id))
          const freshPageState = freshPage?.sync_state ?? syncState
          await ctx.db_update(
            "accounts",
            account.id,
            JSON.stringify({ syncState: { ...freshPageState, historyId: latestHistoryId } }),
          )
        }

        // Bounded per-run: historyId is checkpointed to this page (above), so hand a
        // large remaining backlog to a fresh PACED run instead of paging the whole
        // delta in ONE sandbox invocation (the OOM that thrashed all mail calls). We
        // deliberately do NOT bump lastSyncAt on a hand-off, so the continuation is
        // not skipped by the 60s-elapsed guard at the top of the loop.
        if (budgetHandoff || (pageToken && messagesThisRun >= INCREMENTAL_RUN_MESSAGE_BUDGET)) {
          await ctx.enqueueJob(
            "gmail-incremental-sync",
            JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
            JSON.stringify({
              delay: INITIAL_SYNC_PAGE_DELAY_MS,
              jobId: continuationJobId(account.id),
            }),
          )
          budgetHandoff = true
          break
        }
      } while (pageToken)

      if (historyExpired) {
        await ctx.db_update("accounts", account.id, JSON.stringify({ syncState: {} }))
        await ctx.enqueueJob(
          "gmail-initial-sync",
          JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
          JSON.stringify({ jobId: `gmail-initial-sync:${account.id}` }),
        )
        continue
      }

      if (degradedCount > 0 || skippedCount > 0) {
        ctx.log_info(
          "Gmail incremental sync completed with degraded messages",
          JSON.stringify({ accountId: account.id, degraded: degradedCount, skipped: skippedCount }),
        )
      }

      // Finalize ONLY when the whole delta was consumed this run. On a budget
      // hand-off the historyId is already checkpointed per page and lastSyncAt is
      // left untouched so the paced continuation runs. Re-read before writing:
      // during a backfill the page chain saves cursor progress concurrently;
      // writing this tick's start-of-run snapshot back would clobber the chain's
      // cursor/messagesSynced/pageSavedAt.
      if (!budgetHandoff) {
        const freshInc = JSON.parse(await ctx.db_findOne("accounts", account.id))
        const freshIncState = freshInc?.sync_state ?? syncState
        await ctx.db_update(
          "accounts",
          account.id,
          JSON.stringify({
            lastSyncAt: new Date().toISOString(),
            syncState: { ...freshIncState, historyId: latestHistoryId },
          }),
        )
      }
    } catch (err) {
      ctx.log_error(
        "Gmail incremental sync error",
        JSON.stringify({ accountId: account.id, error: String(err) }),
      )
      // The sandbox execution deadline ("InternalError: interrupted") lands
      // here, not on the hand-off path, so without this the chain stops until
      // the next external trigger (a push, or the owner being online at a
      // tick): a stranded two-day backlog stayed stranded. Progress is
      // checkpointed (page cursor, already-stored skip), so schedule the same
      // paced continuation the budget hand-off would have. Only when this run
      // actually moved: a page that cannot complete inside the deadline at all
      // must not loop every few seconds.
      // A Gmail per-user rate limit (HTTP 403 "Quota exceeded", 429) is the
      // other way a healthy replay ends early: the quota refills within a
      // minute, so the same continuation applies, paced back to a minute.
      const interrupted = isSandboxInterrupt(err)
      const rateLimited = isGmailRateLimit(err)
      const progressed = messagesThisRun > 0 || latestHistoryId !== historyId
      if ((interrupted || rateLimited) && progressed) {
        await ctx.enqueueJob(
          "gmail-incremental-sync",
          JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
          JSON.stringify({
            delay: rateLimited ? RATE_LIMIT_CONTINUE_DELAY_MS : INITIAL_SYNC_PAGE_DELAY_MS,
            jobId: continuationJobId(account.id),
          }),
        )
      }
      if (String(err).includes("401") || String(err).includes("Token")) {
        await ctx.db_update(
          "accounts",
          account.id,
          JSON.stringify({
            syncStatus: "error",
            lastSyncError: "Token revoked — reconnect required",
          }),
        )
      }
    }
  }
}
// ── Gmail write-back ──────────────────────────────────────────────────────────
// Archive, read state, star and trash done in Liaison reach Gmail, so the two
// stay the same mailbox. The host enqueues `gmail-write-back` AFTER the user's
// change has committed, naming the conversations and the values the user set.
//
// The job pushes the CURRENT database value, and only while it still equals
// the value the job was enqueued for: a job that a later change superseded
// pushes nothing for that field (the later change has its own job). After its
// Gmail calls it reads the row again, and a value that moved while it was
// calling is pushed by a follow-up job, so a slow job never leaves Gmail on an
// older value than Liaison.
//
// Loop safety: the change comes back through history.list as a label record.
// The job applies the same label operations to the stored labels once Gmail
// accepted them, so the echo changes nothing, and `recomputeConversationState`
// derives archive state from an INBOX TRANSITION, never from INBOX's absence,
// so neither the echo nor an unrelated label record flips the user's choice.
//
// Only Gmail ids and label ids leave Liaison: no subject, body or snippet is
// read, decrypted or logged, so an end-to-end encrypted mailbox needs nothing
// more than an org mailbox does.

/** Values a user can set on a conversation that have a Gmail counterpart. */
interface GmailWriteBackFields {
  status?: string
  isRead?: boolean
  isStarred?: boolean
}

interface GmailWriteBackPlan {
  addLabelIds: string[]
  removeLabelIds: string[]
  /** Thread-level move: `trash` moves the thread to Gmail's Trash, `untrash` back. */
  move: "trash" | "untrash" | null
}

/** Attempts of one write-back before it gives up and reports the failure. */
const GMAIL_WRITE_BACK_MAX_ATTEMPTS = 5
/** Delay before retrying a write-back Gmail refused for a transient reason. */
const GMAIL_WRITE_BACK_RETRY_DELAY_MS = 30_000
/** Delay of a write-back enqueued from inside an agent tool, whose writes commit with the tool. */
const GMAIL_WRITE_BACK_TOOL_DELAY_MS = 5_000
/** Delay of the one re-check of a tool's write-back whose change had not committed yet. */
const GMAIL_WRITE_BACK_COMMIT_RECHECK_MS = 30_000
/**
 * Prefix of the account error code a failed write-back leaves
 * (`gmail_write_back:<auth|scope|rejected|unavailable>`). The web client
 * renders the code in the viewer's language; a later success clears only it.
 */
const GMAIL_WRITE_BACK_ERROR_PREFIX = "gmail_write_back:"

/**
 * The Gmail operations that make a thread match the given Liaison values.
 *
 * - read / unread: remove / add UNREAD
 * - star / unstar: add / remove STARRED
 * - archived: remove INBOX; open: add INBOX (untrashing first when the thread is in Trash)
 * - trashed: move the thread to Trash
 * - escalated: Liaison-only (a ticket was opened from it), nothing to write
 */
function gmailWriteBackPlan(
  fields: GmailWriteBackFields,
  current: { labels?: unknown },
): GmailWriteBackPlan {
  const plan: GmailWriteBackPlan = { addLabelIds: [], removeLabelIds: [], move: null }
  const labels = Array.isArray(current.labels) ? (current.labels as string[]) : []
  if (fields.isRead === true) plan.removeLabelIds.push("UNREAD")
  if (fields.isRead === false) plan.addLabelIds.push("UNREAD")
  if (fields.isStarred === true) plan.addLabelIds.push("STARRED")
  if (fields.isStarred === false) plan.removeLabelIds.push("STARRED")
  if (fields.status === "archived") plan.removeLabelIds.push("INBOX")
  if (fields.status === "open") {
    if (labels.includes("TRASH")) plan.move = "untrash"
    plan.addLabelIds.push("INBOX")
  }
  if (fields.status === "trashed") plan.move = "trash"
  return plan
}

function gmailWriteBackPlanIsEmpty(plan: GmailWriteBackPlan): boolean {
  return plan.addLabelIds.length === 0 && plan.removeLabelIds.length === 0 && plan.move === null
}

/** The conversation's current value of each field the job was enqueued for, where it still matches. */
function gmailWriteBackLiveFields(
  intended: GmailWriteBackFields,
  conversation: Record<string, unknown>,
): GmailWriteBackFields {
  const live: GmailWriteBackFields = {}
  if (intended.status !== undefined && conversation.status === intended.status) {
    live.status = intended.status
  }
  if (intended.isRead !== undefined && Boolean(conversation.is_read) === intended.isRead) {
    live.isRead = intended.isRead
  }
  if (intended.isStarred !== undefined && Boolean(conversation.is_starred) === intended.isStarred) {
    live.isStarred = intended.isStarred
  }
  return live
}

/** The fields whose value moved away from what was pushed, at their new value. */
function gmailWriteBackDrift(
  pushed: GmailWriteBackFields,
  conversation: Record<string, unknown>,
): GmailWriteBackFields | null {
  const drift: GmailWriteBackFields = {}
  if (pushed.status !== undefined && conversation.status !== pushed.status) {
    drift.status = String(conversation.status)
  }
  if (pushed.isRead !== undefined && Boolean(conversation.is_read) !== pushed.isRead) {
    drift.isRead = Boolean(conversation.is_read)
  }
  if (pushed.isStarred !== undefined && Boolean(conversation.is_starred) !== pushed.isStarred) {
    drift.isStarred = Boolean(conversation.is_starred)
  }
  return Object.keys(drift).length > 0 ? drift : null
}

class GmailWriteBackError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "scope" | "transient" | "rejected",
  ) {
    super(message)
  }
}

function classifyGmailWriteBackFailure(status: number, body: string): GmailWriteBackError {
  const detail = `Gmail HTTP ${status}: ${body.slice(0, 300)}`
  if (status === 401) return new GmailWriteBackError(detail, "auth")
  if (status === 429 || status >= 500) return new GmailWriteBackError(detail, "transient")
  if (status === 403) {
    if (/quota exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(body)) {
      return new GmailWriteBackError(detail, "transient")
    }
    // An account connected before the app asked for gmail.modify, or a
    // consent that left the scope out: retrying cannot help.
    return new GmailWriteBackError(detail, "scope")
  }
  return new GmailWriteBackError(detail, "rejected")
}

async function gmailThreadCall(
  threadId: string,
  action: "modify" | "trash" | "untrash",
  body: Record<string, unknown> | null,
  token: string,
  ctx: MailCtx,
): Promise<"ok" | "gone"> {
  const res = JSON.parse(
    await ctx.fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}/${action}`,
      JSON.stringify({
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    ),
  )
  if (res.status === 200 || res.status === 204) return "ok"
  // The thread no longer exists in Gmail (deleted there): nothing to write.
  if (res.status === 404) return "gone"
  throw classifyGmailWriteBackFailure(Number(res.status), String(res.body ?? ""))
}

/**
 * Mirror the plan onto the stored labels, so the history echo of the change is
 * a no-op. The host applies it as a delta in one transaction: a label change
 * the sync stored while this job was calling Gmail is kept.
 */
async function mirrorGmailWriteBackLocally(
  conversation: Record<string, any>,
  plan: GmailWriteBackPlan,
  ctx: MailCtx,
): Promise<void> {
  const remove = [...plan.removeLabelIds, ...(plan.move === "untrash" ? ["TRASH"] : [])]
  const add = [...plan.addLabelIds, ...(plan.move === "trash" ? ["TRASH"] : [])]
  await ctx.mail_applyLabelDelta(
    JSON.stringify({
      accountId: conversation.account_id,
      conversationId: conversation.id,
      add,
      remove,
    }),
  )
}

async function setGmailWriteBackError(
  account: Record<string, any>,
  kind: "auth" | "scope" | "rejected" | "unavailable" | null,
  ctx: MailCtx,
  prefix: string = GMAIL_WRITE_BACK_ERROR_PREFIX,
): Promise<void> {
  if (kind === null) {
    const current = String(account.last_sync_error ?? "")
    if (!current.startsWith(prefix)) return
  }
  const lastSyncError = kind === null ? null : `${prefix}${kind}`
  await ctx.db_update("accounts", account.id, JSON.stringify({ lastSyncError }))
  await ctx.emit(
    JSON.stringify({
      entity: "account",
      action: "update",
      entityId: account.id,
      data: { lastSyncError },
    }),
  )
}

/**
 * Write user changes on Gmail-backed conversations back to Gmail.
 * Payload: `{ orgId, accountId, conversationIds, fields, attempt? }`.
 */
async function gmailWriteBack(
  payload: {
    orgId: string
    accountId: string
    conversationIds: string[]
    fields: GmailWriteBackFields
    attempt?: number
    /** Set by a caller that enqueues before its own write commits (an agent tool). */
    awaitCommit?: boolean
  },
  ctx: MailCtx,
): Promise<void> {
  const attempt = payload.attempt ?? 1
  const account = JSON.parse(await ctx.db_findOne("accounts", payload.accountId)) as Record<
    string,
    any
  > | null
  // A disconnected mailbox has nobody to write to.
  if (!account || account.disconnected_at) return
  if (account.provider === "imap") {
    await imapWriteBackJob(payload, account, ctx)
    return
  }
  if (account.provider !== "gmail") return

  const retry: string[] = []
  const notCommitted: string[] = []
  const followUps: Array<{ conversationId: string; fields: GmailWriteBackFields }> = []
  let failure: GmailWriteBackError | null = null
  let token: string | null = null
  // True once Gmail answered a write without refusing it: only then is an
  // earlier write-back error stale.
  let gmailAccepted = false

  for (const conversationId of payload.conversationIds) {
    const conversation = JSON.parse(
      await ctx.db_findOne("conversations", conversationId),
    ) as Record<string, any> | null
    if (!conversation || conversation.account_id !== account.id) continue
    const threadId = conversation.external_thread_id
    if (typeof threadId !== "string" || threadId.length === 0) continue

    const live = gmailWriteBackLiveFields(payload.fields, conversation)
    if (Object.keys(live).length === 0 && payload.awaitCommit) {
      notCommitted.push(conversationId)
      continue
    }
    const plan = gmailWriteBackPlan(live, conversation)
    if (gmailWriteBackPlanIsEmpty(plan)) continue

    try {
      if (token === null) {
        try {
          token = await ctx.connections_getToken("gmail", account.email_address)
        } catch (err) {
          throw new GmailWriteBackError(String(err), "auth")
        }
      }
      let gone = false
      if (plan.move === "untrash") {
        gone = (await gmailThreadCall(threadId, "untrash", null, token, ctx)) === "gone"
      }
      if (!gone && (plan.addLabelIds.length > 0 || plan.removeLabelIds.length > 0)) {
        gone =
          (await gmailThreadCall(
            threadId,
            "modify",
            { addLabelIds: plan.addLabelIds, removeLabelIds: plan.removeLabelIds },
            token,
            ctx,
          )) === "gone"
      }
      if (!gone && plan.move === "trash") {
        gone = (await gmailThreadCall(threadId, "trash", null, token, ctx)) === "gone"
      }
      gmailAccepted = true
      if (gone) {
        ctx.log_info(
          "Gmail write-back: thread no longer exists in Gmail",
          JSON.stringify({ accountId: account.id, conversationId }),
        )
        continue
      }
      await mirrorGmailWriteBackLocally(conversation, plan, ctx)

      const after = JSON.parse(await ctx.db_findOne("conversations", conversationId)) as Record<
        string,
        unknown
      > | null
      const drift = after ? gmailWriteBackDrift(live, after) : null
      if (drift) followUps.push({ conversationId, fields: drift })
    } catch (err) {
      const typed =
        err instanceof GmailWriteBackError ? err : new GmailWriteBackError(String(err), "transient")
      ctx.log_warn(
        "Gmail write-back failed",
        JSON.stringify({ accountId: account.id, conversationId, kind: typed.kind, attempt }),
      )
      if (typed.kind === "transient") {
        retry.push(conversationId)
        failure = failure ?? typed
        continue
      }
      // Authorization problems hold for the whole mailbox: stop here.
      failure = typed
      break
    }
  }

  if (notCommitted.length > 0) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({
        orgId: payload.orgId,
        accountId: account.id,
        conversationIds: notCommitted,
        fields: payload.fields,
        awaitCommit: false,
      }),
      JSON.stringify({ delay: GMAIL_WRITE_BACK_COMMIT_RECHECK_MS }),
    )
  }

  for (const followUp of followUps) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({
        orgId: payload.orgId,
        accountId: account.id,
        conversationIds: [followUp.conversationId],
        fields: followUp.fields,
      }),
    )
  }

  if (failure === null) {
    if (gmailAccepted) await setGmailWriteBackError(account, null, ctx)
    return
  }
  if (failure.kind === "transient" && attempt < GMAIL_WRITE_BACK_MAX_ATTEMPTS) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({ ...payload, conversationIds: retry, attempt: attempt + 1 }),
      JSON.stringify({ delay: GMAIL_WRITE_BACK_RETRY_DELAY_MS * attempt }),
    )
    return
  }
  // The change stays in Liaison either way; the mailbox says Gmail did not get it.
  await setGmailWriteBackError(
    account,
    failure.kind === "transient" ? "unavailable" : failure.kind,
    ctx,
  )
}
void gmailWriteBack

/**
 * Prefix of the account error code a failed IMAP write-back leaves
 * (`imap_write_back:<auth|rejected|unavailable>`), worded by the web client.
 */
const IMAP_WRITE_BACK_ERROR_PREFIX = "imap_write_back:"

/** Conversations per write-back session: IMAP_WRITE_BACK_MAX_ITEMS in imap-mailbox.ts. */
const IMAP_WRITE_BACK_BATCH = 15

/** The IMAP operations that make the server match the given Liaison values. */
function imapWriteBackInput(fields: GmailWriteBackFields): {
  seen?: boolean
  flagged?: boolean
  location?: "archive" | "inbox" | "trash"
} {
  const input: { seen?: boolean; flagged?: boolean; location?: "archive" | "inbox" | "trash" } = {}
  if (fields.isRead !== undefined) input.seen = fields.isRead
  if (fields.isStarred !== undefined) input.flagged = fields.isStarred
  if (fields.status === "archived") input.location = "archive"
  if (fields.status === "open") input.location = "inbox"
  if (fields.status === "trashed") input.location = "trash"
  return input
}

function classifyImapWriteBackFailure(err: unknown): GmailWriteBackError {
  const message = String((err as { message?: unknown })?.message ?? err)
  if (/authentication failed/i.test(message)) return new GmailWriteBackError(message, "auth")
  if (/^IMAP rejected/i.test(message)) return new GmailWriteBackError(message, "rejected")
  return new GmailWriteBackError(message, "transient")
}

/**
 * The IMAP side of the write-back job: the same payload, the same retries and
 * the same idempotency as Gmail's (the values written are the conversation's
 * values, re-read here, so a replay writes the same state). The conversation's
 * messages are found on the server by Message-ID (imap-mailbox.ts). The stored
 * labels are mirrored like Gmail's, so the next sync's read-back is a no-op.
 * A server with no Archive folder keeps archive in Liaison only: the mailbox
 * settings say so from the capabilities the sync records.
 */
async function imapWriteBackJob(
  payload: {
    orgId: string
    accountId: string
    conversationIds: string[]
    fields: GmailWriteBackFields
    attempt?: number
    awaitCommit?: boolean
  },
  account: Record<string, any>,
  ctx: MailCtx,
): Promise<void> {
  if (!ctx.imap_writeBack) return
  const attempt = payload.attempt ?? 1
  const retry: string[] = []
  const notCommitted: string[] = []
  const followUps: Array<{ conversationId: string; fields: GmailWriteBackFields }> = []
  let failure: GmailWriteBackError | null = null
  let accepted = false

  // One server session per run, for at most IMAP_WRITE_BACK_BATCH
  // conversations; the rest go to the next run of the job, at once.
  const batch = payload.conversationIds.slice(0, IMAP_WRITE_BACK_BATCH)
  const rest = payload.conversationIds.slice(IMAP_WRITE_BACK_BATCH)
  if (rest.length > 0) {
    await ctx.enqueueJob("gmail-write-back", JSON.stringify({ ...payload, conversationIds: rest }))
  }

  const items: Array<{
    conversationId: string
    live: GmailWriteBackFields
    input: ReturnType<typeof imapWriteBackInput>
    messageIds: string[]
  }> = []
  for (const conversationId of batch) {
    const conversation = JSON.parse(
      await ctx.db_findOne("conversations", conversationId),
    ) as Record<string, any> | null
    if (!conversation || conversation.account_id !== account.id) continue

    const live = gmailWriteBackLiveFields(payload.fields, conversation)
    if (Object.keys(live).length === 0 && payload.awaitCommit) {
      notCommitted.push(conversationId)
      continue
    }
    const input = imapWriteBackInput(live)
    if (Object.keys(input).length === 0) continue

    const rows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: { conversationId },
          select: ["externalMessageId"],
          limit: 500,
        }),
      ),
    ) as Array<Record<string, unknown>>
    const messageIds = [
      ...new Set(
        rows
          .map((r) => r.external_message_id ?? r.externalMessageId)
          .filter(
            (id): id is string =>
              typeof id === "string" && id.startsWith("<") && !id.startsWith("<unknown-"),
          ),
      ),
    ]
    if (messageIds.length === 0) continue
    items.push({ conversationId, live, input, messageIds })
  }

  let response: { results: Array<Record<string, any>> } | null = null
  if (items.length > 0) {
    try {
      response = JSON.parse(
        await ctx.imap_writeBack(
          "imap",
          account.email_address,
          JSON.stringify({
            items: items.map((item) => ({ messageIds: item.messageIds, ...item.input })),
          }),
        ),
      )
    } catch (err) {
      failure = err instanceof GmailWriteBackError ? err : classifyImapWriteBackFailure(err)
      ctx.log_warn(
        "IMAP write-back failed",
        JSON.stringify({
          accountId: account.id,
          conversations: items.length,
          kind: failure.kind,
          attempt,
        }),
      )
      if (failure.kind === "transient") retry.push(...items.map((item) => item.conversationId))
    }
  }

  for (const [index, item] of response ? items.entries() : []) {
    const { conversationId, live, input } = item
    const result = response?.results?.[index]
    if (!result) {
      retry.push(conversationId)
      failure = failure ?? new GmailWriteBackError("IMAP write-back: no result", "transient")
      continue
    }
    if (typeof result.error === "string") {
      // The server refused this conversation's change; the others went through.
      ctx.log_warn(
        "IMAP write-back refused",
        JSON.stringify({ accountId: account.id, conversationId, error: result.error }),
      )
      failure = new GmailWriteBackError(result.error, "rejected")
      continue
    }
    accepted = true
    if (result.found === 0) {
      ctx.log_info(
        "IMAP write-back: the conversation's messages are no longer on the server",
        JSON.stringify({ accountId: account.id, conversationId }),
      )
      continue
    }
    // Mirror what the server now holds, as Gmail's write-back does.
    const add: string[] = []
    const remove: string[] = []
    if (input.seen === true) remove.push("UNREAD")
    if (input.seen === false) add.push("UNREAD")
    if (input.flagged === true) add.push("STARRED")
    if (input.flagged === false) remove.push("STARRED")
    if (input.location === "archive" && !result.archiveUnsupported) remove.push("INBOX")
    if (input.location === "inbox") {
      add.push("INBOX")
      remove.push("TRASH")
    }
    if (input.location === "trash" && !result.trashUnsupported) {
      add.push("TRASH")
      remove.push("INBOX")
    }
    if (add.length > 0 || remove.length > 0) {
      await ctx.mail_applyLabelDelta(
        JSON.stringify({ accountId: account.id, conversationId, add, remove }),
      )
    }
    if (result.archiveUnsupported || result.trashUnsupported) {
      ctx.log_info(
        "IMAP write-back: the server has no folder for this change; kept in Liaison",
        JSON.stringify({
          accountId: account.id,
          conversationId,
          archive: Boolean(result.archiveUnsupported),
          trash: Boolean(result.trashUnsupported),
        }),
      )
    }
    const after = JSON.parse(await ctx.db_findOne("conversations", conversationId)) as Record<
      string,
      unknown
    > | null
    const drift = after ? gmailWriteBackDrift(live, after) : null
    if (drift) followUps.push({ conversationId, fields: drift })
  }

  if (notCommitted.length > 0) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({
        orgId: payload.orgId,
        accountId: account.id,
        conversationIds: notCommitted,
        fields: payload.fields,
        awaitCommit: false,
      }),
      JSON.stringify({ delay: GMAIL_WRITE_BACK_COMMIT_RECHECK_MS }),
    )
  }
  for (const followUp of followUps) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({
        orgId: payload.orgId,
        accountId: account.id,
        conversationIds: [followUp.conversationId],
        fields: followUp.fields,
      }),
    )
  }
  if (failure === null) {
    if (accepted) await setGmailWriteBackError(account, null, ctx, IMAP_WRITE_BACK_ERROR_PREFIX)
    return
  }
  if (failure.kind === "transient" && attempt < GMAIL_WRITE_BACK_MAX_ATTEMPTS) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({ ...payload, conversationIds: retry, attempt: attempt + 1 }),
      JSON.stringify({ delay: GMAIL_WRITE_BACK_RETRY_DELAY_MS * attempt }),
    )
    return
  }
  await setGmailWriteBackError(
    account,
    failure.kind === "transient"
      ? "unavailable"
      : failure.kind === "scope"
        ? "rejected"
        : failure.kind,
    ctx,
    IMAP_WRITE_BACK_ERROR_PREFIX,
  )
}

/** Messages one backfill job scans before it hands the rest to a paced successor. */
const ATTACHMENT_BACKFILL_PAGE = 25
/** Pause between backfill page jobs, so the backfill stays a background trickle. */
const ATTACHMENT_BACKFILL_PAGE_DELAY_MS = 2000
/** Default look-back of the backfill, in days. */
const ATTACHMENT_BACKFILL_DEFAULT_DAYS = 60

/** True when a stored message's top-level Content-Type can carry a file part.
 *  A missing header (a row stored without it) is a candidate: checking costs
 *  one Gmail fetch, missing a file costs the file. */
function mayCarryAttachments(row: any): boolean {
  const headers = row?.raw_headers ?? row?.rawHeaders
  const contentType = String(headers?.["content-type"] ?? "").toLowerCase()
  if (!contentType) return true
  return contentType.startsWith("multipart/") && !contentType.startsWith("multipart/alternative")
}

/**
 * Re-download the attachments of Gmail messages already stored without them.
 * Gmail hands every real attachment over as an `attachmentId`, and sync once
 * imported only parts that carried their bytes, so those messages were stored
 * with no files. On demand only (enqueued by an operator after the fix ships).
 *
 * Payload: `{ orgId, accountId?, days?, offset? }`. Without `accountId` it fans
 * out one job per syncable Gmail mailbox. Each job scans one page of inbound
 * messages, newest first, and stops at the look-back. A message that already
 * has a file, or whose Content-Type cannot carry one, is skipped without a
 * Gmail call; the rest are re-fetched and imported through the same path live
 * sync uses (resumed, so ordinals already stored are never duplicated).
 * Idempotent: re-running it imports nothing twice.
 */
async function gmailAttachmentBackfill(
  payload: { orgId: string; accountId?: string; days?: number; offset?: number },
  ctx: MailCtx,
) {
  const days =
    typeof payload.days === "number" && payload.days > 0
      ? payload.days
      : ATTACHMENT_BACKFILL_DEFAULT_DAYS
  if (!payload.accountId) {
    const accounts = await loadSyncableAccounts("gmail", {}, ctx)
    for (const account of accounts) {
      await ctx.enqueueJob(
        "gmail-attachment-backfill",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id, days }),
        JSON.stringify({ jobId: `gmail-attachment-backfill:${account.id}:0` }),
      )
    }
    return { accounts: accounts.length }
  }
  const [account] = await loadSyncableAccounts("gmail", { accountId: payload.accountId }, ctx)
  if (account?.provider !== "gmail" || account.disconnected_at) {
    return { skipped: "account not syncable" }
  }
  const offset = Math.max(Number(payload.offset) || 0, 0)
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000
  const rows = JSON.parse(
    await ctx.db_findMany(
      "messages",
      JSON.stringify({
        where: { accountId: account.id, direction: "inbound" },
        orderBy: { sentAt: "desc" },
        select: ["id", "externalProviderId", "sentAt", "rawHeaders"],
        limit: ATTACHMENT_BACKFILL_PAGE,
        offset,
      }),
    ),
  ) as any[]
  const source = gmailAttachmentSource(account.email_address, ctx)
  let token: string | null = null
  let reachedCutoff = false
  let checked = 0
  let imported = 0
  for (const row of rows) {
    const sentAt = Date.parse(row.sent_at ?? row.sentAt ?? "")
    if (Number.isFinite(sentAt) && sentAt < cutoffMs) {
      reachedCutoff = true
      break
    }
    const providerId = row.external_provider_id ?? row.externalProviderId
    if (!providerId || !mayCarryAttachments(row)) continue
    if (ctx.files_listAttachments) {
      const existing = JSON.parse(
        await ctx.files_listAttachments(
          JSON.stringify({ app: "mail", entityType: "message", entityId: row.id }),
        ),
      ) as unknown[]
      if (existing.length > 0) continue
    }
    token ??= await ctx.connections_getToken("gmail", account.email_address)
    const fetched = await fetchGmailMessageResilient(providerId, token, ctx, account.id)
    checked++
    const record = fetched.record
    if (!record || !Array.isArray(record.attachments) || record.attachments.length === 0) continue
    await importInboundAttachments({ ...record, direction: "inbound" }, row.id, true, ctx, source)
    imported++
  }
  ctx.log_info(
    "Gmail attachment backfill page",
    JSON.stringify({ accountId: account.id, offset, scanned: rows.length, checked, imported }),
  )
  if (!reachedCutoff && rows.length === ATTACHMENT_BACKFILL_PAGE) {
    const next = offset + ATTACHMENT_BACKFILL_PAGE
    await ctx.enqueueJob(
      "gmail-attachment-backfill",
      JSON.stringify({ orgId: payload.orgId, accountId: account.id, days, offset: next }),
      JSON.stringify({
        jobId: `gmail-attachment-backfill:${account.id}:${next}`,
        delay: ATTACHMENT_BACKFILL_PAGE_DELAY_MS,
      }),
    )
  }
  return { accountId: account.id, offset, scanned: rows.length, checked, imported }
}

async function gmailWatchRenewal(_payload: unknown, ctx: MailCtx) {
  const accounts = JSON.parse(
    await ctx.db_findMany(
      "accounts",
      JSON.stringify({
        where: { provider: "gmail", syncStatus: "active" },
      }),
    ),
  )

  // No topic configured -> poll-only deployment, no watch to renew.
  if (!(await resolveGmailPushTopic(ctx))) return

  for (const account of accounts) {
    try {
      const token = await ctx.connections_getToken("gmail", account.email_address)
      const watch = await registerGmailWatch(ctx, token)
      if (!watch) continue
      const syncState = account.sync_state ?? {}
      await ctx.db_update(
        "accounts",
        account.id,
        JSON.stringify({
          syncState: { ...syncState, watchExpiry: watch.expiration },
        }),
      )
    } catch {
      ctx.log_error("Watch renewal failed", JSON.stringify({ accountId: account.id }))
    }
  }
}
/** First wait before retrying a failed IMAP sync, doubled per failure up to the cap. */
const IMAP_RETRY_BASE_MS = 15 * 60_000
const IMAP_RETRY_MAX_MS = 6 * 60 * 60_000

/** A refused login: retrying with the same credentials cannot pass. */
function isImapAuthFailure(message: string): boolean {
  return /authentication failed|AUTHENTICATIONFAILED|invalid credentials/i.test(message)
}

/**
 * A failed IMAP fetch, on the account: the error the settings show, and for a
 * failure that can pass later, when the rescue tries again. The sync state
 * (cursor, uidValidity, count) is kept, so the retry resumes where it stopped.
 */
async function recordImapSyncFailure(
  account: any,
  syncState: Record<string, any>,
  err: unknown,
  ctx: MailCtx,
): Promise<void> {
  const message = String((err as { message?: unknown })?.message ?? err)
  const auth = isImapAuthFailure(message)
  const failedAttempts = Number(syncState.failedAttempts ?? 0) + 1
  const delay = Math.min(IMAP_RETRY_BASE_MS * 2 ** (failedAttempts - 1), IMAP_RETRY_MAX_MS)
  const nextRetryAt = auth ? null : new Date(Date.now() + delay).toISOString()
  // Merged into the row as it is now: the incremental sync may have moved the
  // cursor while this run was fetching.
  await patchImapSyncState(account.id, { failedAttempts, nextRetryAt }, ctx, {
    syncStatus: "error",
    lastSyncError: message,
  })
  await ctx.emit(
    JSON.stringify({
      entity: "account",
      action: "update",
      entityId: account.id,
      data: { syncStatus: "error", lastSyncError: message },
    }),
  )
  ctx.log_error(
    "IMAP sync failed",
    JSON.stringify({ accountId: account.id, error: message, failedAttempts, nextRetryAt }),
  )
}

/**
 * Save part of an IMAP account's sync state, merged into what the row holds
 * NOW: the initial sync (Sent backfill) and the incremental sync may run side
 * by side on an account, and each owns its own keys.
 */
async function patchImapSyncState(
  accountId: string,
  patch: Record<string, unknown>,
  ctx: MailCtx,
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const fresh = JSON.parse(await ctx.db_findOne("accounts", accountId)) as Record<
    string,
    any
  > | null
  const syncState = { ...(fresh?.sync_state ?? {}), ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete syncState[key]
  }
  await ctx.db_update("accounts", accountId, JSON.stringify({ ...extra, syncState }))
  return syncState
}

/**
 * The server renumbered the mailbox (UIDVALIDITY changed): every stored UID now
 * names nothing, or worse a different message. They are dropped, so the
 * read-back matches nothing stale; the re-walk that follows finds each stored
 * message again by Message-ID and stores its new UID (settleKnownInboxMessages).
 */
async function forgetImapUids(accountId: string, ctx: MailCtx): Promise<void> {
  await ctx.db_updateMany(
    "messages",
    JSON.stringify({ where: { accountId }, data: { externalProviderId: null } }),
  )
}

/** Whether the server has a Sent folder this mailbox imports. */
function imapHasSentFolder(capabilities: any): boolean {
  return typeof capabilities?.folders?.sent === "string" && capabilities.folders.sent.length > 0
}

/** The stored messages among the given Message-IDs, keyed by Message-ID. */
async function messagesByExternalId(
  accountId: string,
  externalIds: string[],
  ctx: MailCtx,
): Promise<Map<string, any>> {
  const out = new Map<string, any>()
  const ids = [...new Set(externalIds.filter(Boolean))]
  for (let start = 0; start < ids.length; start += 500) {
    const rows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: { accountId, externalMessageId: { in: ids.slice(start, start + 500) } },
          select: ["id", "labels", "conversationId", "externalProviderId", "externalMessageId"],
          limit: 1000,
        }),
      ),
    )
    for (const row of rows) {
      const key = row.external_message_id ?? row.externalMessageId
      if (typeof key === "string" && ids.includes(key)) out.set(key, row)
    }
  }
  return out
}

/**
 * INBOX messages the fetch returned that are already stored: a message moved
 * back into the INBOX (by another client, or by Liaison's own write-back) gets
 * a new UID and shows up as new. It is not imported again: its stored copy goes
 * back to the INBOX (reopening an archived or trashed conversation, as Gmail
 * does) and remembers its new UID. Returns the messages that are really new.
 */
async function settleKnownInboxMessages(
  messages: any[],
  account: any,
  ctx: MailCtx,
): Promise<any[]> {
  if (messages.length === 0) return messages
  const stored = await messagesByExternalId(
    account.id,
    messages.map((m) => m.externalMessageId),
    ctx,
  )
  if (stored.size === 0) return messages
  const fresh: any[] = []
  const touched = new Set<string>()
  for (const message of messages) {
    // A synthetic id (no Message-ID header) names one UID, never a moved message.
    const synthetic = String(message.externalMessageId ?? "").startsWith("<unknown-")
    const row = synthetic ? undefined : stored.get(message.externalMessageId)
    if (!row) {
      fresh.push(message)
      continue
    }
    const labels = new Set<string>(row.labels ?? [])
    const back = !labels.has("INBOX") || labels.has("TRASH")
    labels.add("INBOX")
    labels.delete("TRASH")
    const providerId = row.external_provider_id ?? row.externalProviderId
    const update: Record<string, unknown> = {}
    if (back) update.labels = [...labels]
    if (providerId !== message.externalProviderId)
      update.externalProviderId = message.externalProviderId
    if (Object.keys(update).length === 0) continue
    await ctx.db_update("messages", row.id, JSON.stringify(update))
    const conversationId = row.conversation_id ?? row.conversationId
    if (back && conversationId) touched.add(conversationId)
  }
  for (const conversationId of touched) {
    await recomputeConversationState(conversationId, account, ctx)
  }
  return fresh
}

/** Read and star flags as stored in a flag snapshot: "<seen><flagged>", e.g. "10". */
function imapFlagBits(flag: { seen: boolean; flagged: boolean }): string {
  return `${flag.seen ? 1 : 0}${flag.flagged ? 1 : 0}`
}

/**
 * Apply what the server says changed in the INBOX since the last sync, so a
 * change made in another client (read on the phone, archived in the web
 * client) reaches Liaison. Precedence is the Gmail path's: a change made on the
 * server since the last sync wins; a change made in Liaison was already
 * written back and mirrored, so its echo here changes nothing; a message
 * leaving the INBOX archives its conversation (trashing elsewhere reads the
 * same over IMAP), and `escalated` stays. Returns the state to keep.
 */
async function applyImapInboxState(
  reconcile: any,
  syncState: Record<string, any>,
  account: any,
  ctx: MailCtx,
): Promise<Record<string, unknown>> {
  const touched = new Set<string>()
  const removed: number[] = Array.isArray(reconcile?.removedUids) ? reconcile.removedUids : []
  if (removed.length > 0) {
    const rows = await messagesByProviderId(account.id, removed.map(String), ctx)
    for (const row of rows.values()) {
      const labels: string[] = row.labels ?? []
      if (!labels.includes("INBOX")) continue
      await ctx.db_update(
        "messages",
        row.id,
        JSON.stringify({ labels: labels.filter((l) => l !== "INBOX") }),
      )
      const conversationId = row.conversation_id ?? row.conversationId
      if (conversationId) touched.add(conversationId)
    }
  }

  const flags: Array<{ uid: number; seen: boolean; flagged: boolean }> = Array.isArray(
    reconcile?.flags,
  )
    ? reconcile.flags
    : []
  const previous: Record<string, string> | null =
    syncState.flagSnapshot && typeof syncState.flagSnapshot === "object"
      ? syncState.flagSnapshot
      : null
  // Without CONDSTORE the server reports current flags, not changes: only a
  // flag that moved since the last read is a change. The first read only
  // records them (a stale local value must not be taken as a remote change).
  const changed = reconcile?.flagsAreChanges
    ? flags
    : previous
      ? flags.filter(
          (f) =>
            previous[String(f.uid)] !== undefined && previous[String(f.uid)] !== imapFlagBits(f),
        )
      : []
  if (changed.length > 0) {
    const rows = await messagesByProviderId(
      account.id,
      changed.map((f) => String(f.uid)),
      ctx,
    )
    for (const flag of changed) {
      const row = rows.get(String(flag.uid))
      if (!row) continue
      // Only the flag that moved on the server is taken: without CONDSTORE a
      // star changed elsewhere must not carry the server's read state over a
      // read made in Liaison whose write-back has not run yet (and the reverse).
      const before = previous?.[String(flag.uid)]
      const seenMoved = reconcile?.flagsAreChanges || before?.[0] !== imapFlagBits(flag)[0]
      const flaggedMoved = reconcile?.flagsAreChanges || before?.[1] !== imapFlagBits(flag)[1]
      const labels = new Set<string>(row.labels ?? [])
      const update: Record<string, unknown> = {}
      if (seenMoved) {
        if (flag.seen) labels.delete("UNREAD")
        else labels.add("UNREAD")
        if (Boolean(row.is_read ?? row.isRead) !== flag.seen) update.isRead = flag.seen
      }
      if (flaggedMoved) {
        if (flag.flagged) labels.add("STARRED")
        else labels.delete("STARRED")
        if (Boolean(row.is_starred ?? row.isStarred) !== flag.flagged)
          update.isStarred = flag.flagged
      }
      const sortedBefore = [...(row.labels ?? [])].sort().join(",")
      if ([...labels].sort().join(",") !== sortedBefore) update.labels = [...labels]
      if (Object.keys(update).length === 0) continue
      await ctx.db_update("messages", row.id, JSON.stringify(update))
      const conversationId = row.conversation_id ?? row.conversationId
      if (conversationId) touched.add(conversationId)
    }
  }
  for (const conversationId of touched) {
    await recomputeConversationState(conversationId, account, ctx, { keepTrashed: true })
  }

  const state: Record<string, unknown> = {
    // An INBOX too large to track: archive done elsewhere is not read back, and
    // the mailbox settings say so.
    inboxTracked: reconcile ? reconcile.uidSet !== null : undefined,
    inboxUids: reconcile?.uidSet ?? undefined,
    modseq: reconcile?.modseq ?? undefined,
  }
  if (
    !reconcile?.flagsAreChanges &&
    !(reconcile?.modseq && account.sync_state?.capabilities?.condstore)
  ) {
    const snapshot: Record<string, string> = {}
    for (const flag of flags) snapshot[String(flag.uid)] = imapFlagBits(flag)
    state.flagSnapshot = flags.length > 0 ? snapshot : (previous ?? undefined)
  } else {
    state.flagSnapshot = undefined
  }
  return state
}

/**
 * Where IMAP mail is not yet imported below a folder's cursor: the UIDs
 * strictly between `above` and `before`. A catch-up that found more new mail
 * than one page takes the newest page and leaves the rest as a gap, filled
 * newest first by the next runs.
 */
type ImapGap = { above: string; before: string }
/** Gaps kept per folder; past it the two oldest merge (the stored mail between is skipped by Message-ID). */
const IMAP_MAX_GAPS = 20
/** A run does no second IMAP call (Sent, or the walk page) once this long has passed. */
const IMAP_RUN_SECOND_CALL_BEFORE_MS = 30_000

function imapGaps(value: unknown): ImapGap[] {
  return Array.isArray(value)
    ? value.filter(
        (g): g is ImapGap => !!g && typeof g.above === "string" && typeof g.before === "string",
      )
    : []
}

/**
 * One newest-first catch-up page of a folder: the newest page of the mail
 * above `cursor`, or, when there is none, the newest page of the newest gap.
 * Never walks forward from an old cursor: after any pause (a backoff, a
 * restart, a reconnect) the latest mail comes first.
 */
async function imapCatchUpPage(
  account: any,
  folder: "inbox" | "sent",
  state: Record<string, any>,
  ctx: MailCtx,
  reconcile?: Record<string, unknown>,
): Promise<{
  result: any
  cursor: string | null
  gaps: ImapGap[]
  uidValidityChanged: boolean
}> {
  const cursor: string | null = state.cursor ?? null
  let gaps = imapGaps(state.gaps)
  const call = async (above: string | null, before: string | null, withReconcile: boolean) =>
    JSON.parse(
      await ctx.imap_fetch(
        "imap",
        account.email_address,
        JSON.stringify({
          mode: "incremental",
          order: "newest",
          batchSize: 25,
          above,
          before,
          cursor,
          ...(folder === "sent" ? { folder: "sent" } : {}),
          ...(withReconcile && reconcile ? { reconcile } : {}),
        }),
      ),
    )
  let result = await call(cursor, null, true)
  if (result.noFolder) return { result, cursor, gaps, uidValidityChanged: false }
  if (state.uidValidity && result.uidValidity !== state.uidValidity) {
    return { result, cursor, gaps, uidValidityChanged: true }
  }
  let next = cursor
  if (result.highest) {
    next = result.highest
    if (!result.done && result.nextBefore) {
      gaps = [{ above: cursor ?? "0", before: result.nextBefore }, ...gaps]
    }
  } else if (gaps.length > 0) {
    const [gap, ...rest] = gaps
    const fill = await call(gap.above, gap.before, false)
    gaps =
      fill.done || !fill.nextBefore
        ? rest
        : [{ above: gap.above, before: fill.nextBefore }, ...rest]
    result = { ...fill, reconcile: result.reconcile, capabilities: result.capabilities }
  }
  while (gaps.length > IMAP_MAX_GAPS) {
    const oldest = gaps.pop() as ImapGap
    const prev = gaps.pop() as ImapGap
    gaps.push({ above: oldest.above, before: prev.before })
  }
  return { result, cursor: next, gaps, uidValidityChanged: false }
}

/**
 * One page of the Sent folder: mail sent from the mailbox (in Liaison or in any
 * other client) joins its conversations. A message Liaison sent is already
 * stored under its Message-ID and is skipped by the page write.
 *
 * Newest first, always: until the folder is imported (`done`) the folder is
 * walked down from its newest message (`before`), the first page recording
 * its highest UID as `cursor`; after, each page catches up newest first above
 * the cursor (imapCatchUpPage). A Sent state from an older release (oldest
 * first, no `walk` mark, not done) starts the walk again from the newest.
 */
async function imapSentStep(
  account: any,
  sent: Record<string, any>,
  ctx: MailCtx,
): Promise<{ sent: Record<string, any>; more: boolean }> {
  const store = async (messages: any[]) => {
    if (messages.length === 0) return
    await processMessages(
      messages.map((message: any) => ({ ...message, direction: "outbound", isRead: true })),
      account,
      ctx,
      "imap-sent",
    )
  }
  if (sent.done === true) {
    const page = await imapCatchUpPage(account, "sent", sent, ctx)
    if (page.result.noFolder) return { sent: { ...sent, done: true }, more: false }
    if (page.uidValidityChanged) {
      ctx.log_warn("IMAP Sent uidValidity changed, re-reading Sent")
      return { sent: { uidValidity: page.result.uidValidity, walk: true, done: false }, more: true }
    }
    await store(page.result.messages)
    return {
      sent: {
        ...sent,
        uidValidity: page.result.uidValidity,
        cursor: page.cursor,
        gaps: page.gaps.length > 0 ? page.gaps : undefined,
      },
      more: page.gaps.length > 0,
    }
  }
  const walking = sent.walk === true
  const result = JSON.parse(
    await ctx.imap_fetch(
      "imap",
      account.email_address,
      JSON.stringify({
        mode: "full",
        order: "newest",
        batchSize: 25,
        before: walking ? (sent.before ?? null) : null,
        folder: "sent",
      }),
    ),
  )
  if (result.noFolder) return { sent: { ...sent, done: true, cursor: null }, more: false }
  if (walking && sent.uidValidity && result.uidValidity !== sent.uidValidity) {
    ctx.log_warn("IMAP Sent uidValidity changed, re-reading Sent")
    return { sent: { uidValidity: result.uidValidity, walk: true, done: false }, more: true }
  }
  await store(result.messages)
  const done = Boolean(result.done)
  return {
    sent: {
      uidValidity: result.uidValidity,
      // The first page fixes the high-water mark; later pages keep it.
      cursor: walking ? (sent.cursor ?? null) : (result.highest ?? null),
      walk: true,
      before: done ? null : (result.nextBefore ?? null),
      done,
    },
    more: !done,
  }
}

/** Whether a stored state's retry time is still ahead. */
function imapRetryAhead(state: Record<string, any> | undefined): boolean {
  const due = Date.parse(state?.nextRetryAt ?? "")
  return Number.isFinite(due) && due > Date.now()
}

/** The wait after the n-th failure in a row: 2 min doubling, at most 6 h. A refused login waits the most. */
function imapRetryDelay(failedAttempts: number, message: string): number {
  if (isImapAuthFailure(message)) return IMAP_RETRY_MAX_MS
  return Math.min(IMAP_INCREMENTAL_RETRY_BASE_MS * 2 ** (failedAttempts - 1), IMAP_RETRY_MAX_MS)
}

/** The stored new-mail state of an INBOX as one fetch's reconcile input. */
function imapReconcileInput(syncState: Record<string, any>): Record<string, unknown> {
  return { uidSet: syncState.inboxUids ?? null, modseq: syncState.modseq ?? null }
}

/**
 * The first import of an IMAP INBOX: a chain of runs, each one bounded page.
 *
 * NEWEST FIRST: the INBOX is walked down from its newest message (`inboxWalk`
 * .before), so recent mail shows within the first minute and a mailbox of
 * years is imported in the background. The first page records the INBOX's
 * highest UID as the cursor; each later run first catches up the mail that
 * arrived since (imapCatchUpPage, newest first), then takes the next walk
 * page. While the walk runs, this chain is the ONLY writer of the mailbox's
 * sync state (the incremental sync leaves a walking mailbox alone), and each
 * run saves everything it changed in one write; the last page finalizes in
 * that same write (`inboxDone`), so no state between "walked" and "done"
 * exists. The Sent folder is the incremental sync's, once the INBOX is in.
 *
 * A state from an older release (a cursor, no `inboxWalk`, not done: an
 * oldest-first import left part way) starts the walk again from the newest;
 * the mail it stored is found by Message-ID and not stored twice.
 *
 * A failure is written on the account, where the Mail settings and the
 * agent's account list show it. A refused login stays an error until the
 * mailbox is reconnected; any other failure (an unreachable host, a timeout)
 * is retried by the stranded-sync rescue after a growing delay
 * (`nextRetryAt`), resuming from the page it saved.
 */
async function imapInitialSync(payload: { orgId: string; accountId: string }, ctx: MailCtx) {
  const startedAt = Date.now()
  const account = JSON.parse(await ctx.db_findOne("accounts", payload.accountId))
  if (!account) {
    ctx.log_error("Account not found")
    return
  }
  if (account.disconnected_at) {
    ctx.log_info("Account disconnected")
    return
  }
  // Same reasoning as gmailInitialSync above: entered by job id, re-enqueued by
  // the stranded-sync rescue, never routed through loadSyncableAccounts.
  if (!isSyncableAccount(account)) {
    logSyncSuspended(account, "imapInitialSync", ctx)
    return
  }

  const syncState: Record<string, any> = account.sync_state ?? {}
  if (syncState.inboxDone === true) {
    // Imported already (a job queued before it finished, or by an older
    // release for its Sent backfill, which the incremental sync now does).
    if (account.sync_status !== "active") {
      await ctx.db_update(
        "accounts",
        account.id,
        JSON.stringify({ syncStatus: "active", lastSyncError: null }),
      )
    }
    return
  }
  // Only when it changes: a no-op write would hold the row lock for the whole
  // run (see gmailInitialSync).
  if (account.sync_status !== "syncing") {
    await ctx.db_update("accounts", account.id, JSON.stringify({ syncStatus: "syncing" }))
  }

  const walk: { before?: string | null } | null =
    syncState.inboxWalk && typeof syncState.inboxWalk === "object" ? syncState.inboxWalk : null
  let messagesSynced = Number(syncState.messagesSynced ?? 0)
  const patch: Record<string, unknown> = {}

  const store = async (messages: any[]) => {
    if (messages.length === 0) return
    const fresh = await settleKnownInboxMessages(messages, account, ctx)
    if (fresh.length > 0) {
      await processMessages(
        fresh.map((message: any) => ({ ...message, direction: "inbound" })),
        account,
        ctx,
        "imap",
      )
    }
  }
  const restart = async (uidValidity: unknown) => {
    // The server renumbered the INBOX: every position means nothing any more.
    // The walk starts again; stored mail is found again by Message-ID and
    // takes its new UID.
    await forgetImapUids(account.id, ctx)
    await patchImapSyncState(
      account.id,
      {
        inboxWalk: undefined,
        cursor: undefined,
        gaps: undefined,
        inboxUids: undefined,
        flagSnapshot: undefined,
        modseq: undefined,
        uidValidity,
        messagesSynced: 0,
      },
      ctx,
    )
    ctx.log_warn("IMAP uidValidity changed, restarting sync")
    await ctx.enqueueJob(
      "imap-initial-sync",
      JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
      JSON.stringify({
        jobId: `imap-initial-sync:${account.id}:restart`,
        delay: INITIAL_SYNC_PAGE_DELAY_MS,
      }),
    )
  }

  try {
    // 1. New mail since the walk started, newest first (from the second run on).
    if (walk) {
      const page = await imapCatchUpPage(
        account,
        "inbox",
        syncState,
        ctx,
        imapReconcileInput(syncState),
      )
      if (page.uidValidityChanged) {
        await restart(page.result.uidValidity)
        return
      }
      await store(page.result.messages)
      messagesSynced += page.result.messages.length
      const inboxState = page.result.reconcile
        ? await applyImapInboxState(page.result.reconcile, syncState, account, ctx)
        : {}
      Object.assign(patch, inboxState, {
        cursor: page.cursor ?? undefined,
        gaps: page.gaps.length > 0 ? page.gaps : undefined,
      })
    }

    // 2. The next walk page, while the run has time for a second call.
    let walkDone = false
    let before = walk?.before ?? null
    let capabilities = syncState.capabilities ?? null
    let uidValidity = syncState.uidValidity ?? null
    if (!walk || Date.now() - startedAt < IMAP_RUN_SECOND_CALL_BEFORE_MS) {
      const result = JSON.parse(
        await ctx.imap_fetch(
          "imap",
          account.email_address,
          // 25/batch, matching the gmail page bound: the whole batch crosses the
          // bridge as ONE JSON string materialized on the QuickJS heap, so batch
          // size IS the memory bound.
          JSON.stringify({ mode: "full", order: "newest", batchSize: 25, before }),
        ),
      )
      if (walk && uidValidity !== null && result.uidValidity !== uidValidity) {
        await restart(result.uidValidity)
        return
      }
      uidValidity = result.uidValidity
      if (result.capabilities) capabilities = result.capabilities
      if (!walk) {
        // The first page: from here on, mail above `highest` is caught up
        // above the cursor, and the walk takes everything below. Saved before
        // the page's writes, so a run killed mid-page still has its cursor.
        await patchImapSyncState(
          account.id,
          {
            cursor: result.highest ?? undefined,
            uidValidity,
            capabilities: capabilities ?? undefined,
            inboxWalk: { before: null },
            pageSavedAt: new Date().toISOString(),
          },
          ctx,
        )
      }
      await store(result.messages)
      messagesSynced += result.messages.length
      walkDone = Boolean(result.done)
      before = walkDone ? null : (result.nextBefore ?? null)
    }

    if (walkDone) {
      // The last page: finalized in the same write as its progress.
      Object.assign(patch, {
        inboxWalk: undefined,
        inboxDone: true,
        pageSavedAt: undefined,
        uidValidity,
        messagesSynced,
        capabilities: capabilities ?? undefined,
        failedAttempts: undefined,
        nextRetryAt: undefined,
      })
      await patchImapSyncState(account.id, patch, ctx, {
        syncStatus: "active",
        lastSyncAt: new Date().toISOString(),
        lastSyncError: null,
      })
      await ctx.emit(
        JSON.stringify({
          entity: "account",
          action: "update",
          entityId: account.id,
          data: { syncStatus: "active", messagesSynced },
        }),
      )
      return
    }

    Object.assign(patch, {
      inboxWalk: { before },
      uidValidity,
      messagesSynced,
      capabilities: capabilities ?? undefined,
      pageSavedAt: new Date().toISOString(),
      failedAttempts: undefined,
      nextRetryAt: undefined,
    })
    await patchImapSyncState(account.id, patch, ctx)
  } catch (err) {
    await recordImapSyncFailure(account, syncState, err, ctx)
    return
  }

  // More pages: the next run, PACED (see the gmail initial sync's page chain).
  // Its id names the page it takes: two chains at the same page collapse into one.
  const at = JSON.parse(await ctx.db_findOne("accounts", account.id))?.sync_state?.inboxWalk
  await ctx.enqueueJob(
    "imap-initial-sync",
    JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
    JSON.stringify({
      jobId: `imap-initial-sync:${account.id}:${at?.before ?? "top"}`,
      delay: INITIAL_SYNC_PAGE_DELAY_MS,
    }),
  )
}

/**
 * A mailbox whose incremental sync failed waits before the scheduled tick
 * tries it again: 2 minutes (one tick), doubled per failure, capped at six
 * hours (a refused login waits the six hours at once). A slow or unreachable
 * server then costs one short attempt per wait instead of a job held to its
 * timeout every tick. "Sync now" and a reconnect (new credentials) try at once.
 */
const IMAP_INCREMENTAL_RETRY_BASE_MS = 2 * 60_000
/** A catch-up chain silent this long is taken as dead; the tick takes over. */
const IMAP_CHAIN_STALL_MS = 60_000

/**
 * Whether an IMAP mailbox's INBOX has been imported, in either state shape:
 * this release marks it `inboxDone` (and walks with `inboxWalk`); a mailbox
 * imported before `inboxDone` existed is `active` with a cursor and no walk.
 * A row with a cursor but neither (`syncing`, `error` or `pre-sync`) is a first
 * import an older release left part way, oldest first: its cursor is not a
 * high-water mark, and the import starts again newest first.
 */
function imapInboxImported(account: any): boolean {
  const state = account.sync_state ?? {}
  if (state.inboxDone === true) return true
  return account.sync_status === "active" && !state.inboxWalk && state.cursor != null
}

async function recordImapIncrementalFailure(
  account: any,
  err: unknown,
  ctx: MailCtx,
): Promise<void> {
  const message = String((err as { message?: unknown })?.message ?? err)
  const failedAttempts = Number(account.sync_state?.failedAttempts ?? 0) + 1
  const nextRetryAt = new Date(Date.now() + imapRetryDelay(failedAttempts, message)).toISOString()
  // The mailbox stays `active` (what it holds is current up to the cursor);
  // the error and the next try are on the row, where the Mail settings and
  // the agent's account list show them.
  await patchImapSyncState(account.id, { failedAttempts, nextRetryAt }, ctx, {
    lastSyncError: message,
  })
  await ctx.emit(
    JSON.stringify({
      entity: "account",
      action: "update",
      entityId: account.id,
      data: { lastSyncError: message, nextRetryAt },
    }),
  )
  ctx.log_warn(
    "IMAP incremental sync failed; backing off",
    JSON.stringify({ accountId: account.id, error: message, failedAttempts, nextRetryAt }),
  )
}

async function imapIncrementalSync(
  payload: { orgId: string; accountId?: string; tick?: boolean; chain?: boolean },
  ctx: MailCtx,
) {
  // Same stranded-account rescue as gmailIncrementalSync (see there).
  if (!payload.accountId) {
    await reenqueueStrandedInitialSyncs("imap", payload.orgId, ctx)
  }
  const accounts = await loadSyncableAccounts("imap", payload, ctx)
  // Asked for by a person ("Sync now"), not by the schedule or a chain.
  const manual = Boolean(payload.accountId) && payload.tick !== true && payload.chain !== true

  // The scheduled tick of an org with several mailboxes runs each in a job of
  // its own: one slow server must not hold the others (or the job's budget),
  // and the jobs queue fairly with every other org's.
  const fanOut = !payload.accountId && accounts.length > 1

  for (const account of accounts) {
    if (account.disconnected_at) continue
    const syncState: Record<string, any> = account.sync_state ?? {}

    if (!imapInboxImported(account)) {
      // The first import brings the mail (and catches up new mail as it
      // walks); while it runs it is the mailbox's only writer. "Sync now"
      // makes sure it is running: a chain silent a while is started again.
      if (manual) {
        if (account.sync_status === "error") {
          await patchImapSyncState(account.id, { nextRetryAt: undefined }, ctx)
        }
        const saved = Date.parse(String(syncState.pageSavedAt ?? ""))
        const alive =
          account.sync_status === "syncing" &&
          Number.isFinite(saved) &&
          Date.now() - saved < INITIAL_SYNC_RESCUE_STALL_MS
        if (!alive) {
          await ctx.enqueueJob(
            "imap-initial-sync",
            JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
            JSON.stringify({ jobId: `imap-initial-sync:${account.id}` }),
          )
        }
      }
      continue
    }

    if (!manual && imapRetryAhead(syncState)) continue
    // A catch-up chain running for this mailbox is its writer: the tick leaves it.
    const chainAt = Date.parse(String(syncState.chainAt ?? ""))
    if (
      payload.chain !== true &&
      Number.isFinite(chainAt) &&
      Date.now() - chainAt < IMAP_CHAIN_STALL_MS
    ) {
      continue
    }

    // A person's mailbox waits until someone who can read it is online. An org's
    // shared mailbox does not: IMAP has no push, so nothing else would bring its
    // mail in, and mail-driven work (a routine, a ticket) has nobody to wait for.
    if (!payload.accountId && account.owner_type !== "org") {
      const isOnline = JSON.parse(await ctx.hasOnlineUsers(account.id))
      if (!isOnline) continue
    }
    if (fanOut) {
      await ctx.enqueueJob(
        "imap-incremental-sync",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id, tick: true }),
        JSON.stringify({ jobId: `imap-incremental-sync:${account.id}` }),
      )
      continue
    }

    const startedAt = Date.now()
    let page: Awaited<ReturnType<typeof imapCatchUpPage>>
    try {
      page = await imapCatchUpPage(account, "inbox", syncState, ctx, imapReconcileInput(syncState))
    } catch (err) {
      await recordImapIncrementalFailure(account, err, ctx)
      continue
    }
    const result = page.result

    if (page.uidValidityChanged) {
      await forgetImapUids(account.id, ctx)
      await ctx.db_update("accounts", account.id, JSON.stringify({ syncState: {} }))
      await ctx.enqueueJob(
        "imap-initial-sync",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id }),
        JSON.stringify({ jobId: `imap-initial-sync:${account.id}` }),
      )
      continue
    }

    if (result.messages.length > 0) {
      const fresh = await settleKnownInboxMessages(result.messages, account, ctx)
      if (fresh.length > 0) {
        await processMessages(
          fresh.map((message: any) => ({ ...message, direction: "inbound" })),
          account,
          ctx,
          "imap",
        )
      }
    }

    const inboxState = result.reconcile
      ? await applyImapInboxState(result.reconcile, syncState, account, ctx)
      : {}
    const capabilities = result.capabilities ?? syncState.capabilities
    const patch: Record<string, unknown> = {
      cursor: page.cursor ?? undefined,
      gaps: page.gaps.length > 0 ? page.gaps : undefined,
      uidValidity: result.uidValidity,
      ...(capabilities ? { capabilities } : {}),
      ...inboxState,
      // An imported INBOX in either state shape is done from here on.
      inboxDone: true,
      failedAttempts: undefined,
      nextRetryAt: undefined,
    }
    let more = page.gaps.length > 0

    // Sent, newest first too, in the same run while it has time for a second
    // call. Its failures back off on their own (`sent.nextRetryAt`) and never
    // hold the INBOX back.
    const sent: Record<string, any> = syncState.sent ?? {}
    if (
      imapHasSentFolder(capabilities) &&
      !imapRetryAhead(sent) &&
      Date.now() - startedAt < IMAP_RUN_SECOND_CALL_BEFORE_MS
    ) {
      try {
        const step = await imapSentStep(account, sent, ctx)
        patch.sent = { ...step.sent, failedAttempts: undefined, nextRetryAt: undefined }
        more = more || step.more
      } catch (err) {
        const message = String((err as Error)?.message ?? err)
        const failedAttempts = Number(sent.failedAttempts ?? 0) + 1
        patch.sent = {
          ...sent,
          failedAttempts,
          nextRetryAt: new Date(Date.now() + imapRetryDelay(failedAttempts, message)).toISOString(),
        }
        ctx.log_warn(
          "IMAP Sent sync failed; backing off",
          JSON.stringify({ accountId: account.id, error: message, failedAttempts }),
        )
      }
    } else if (imapHasSentFolder(capabilities) && sent.done !== true && !imapRetryAhead(sent)) {
      more = true
    }
    patch.chainAt = more ? new Date().toISOString() : undefined

    await patchImapSyncState(account.id, patch, ctx, {
      lastSyncAt: new Date().toISOString(),
      ...(syncState.failedAttempts || account.last_sync_error ? { lastSyncError: null } : {}),
    })

    if (more) {
      // The rest (a gap below new mail, the Sent walk): the next run, paced.
      // Its id names where it starts, so two chains at one place collapse.
      const at = page.gaps[0]?.before ?? (patch.sent as any)?.before ?? "sent"
      await ctx.enqueueJob(
        "imap-incremental-sync",
        JSON.stringify({ orgId: payload.orgId, accountId: account.id, chain: true }),
        JSON.stringify({
          jobId: `imap-incremental-sync:${account.id}:chain:${page.cursor ?? 0}:${at}`,
          delay: INITIAL_SYNC_PAGE_DELAY_MS,
        }),
      )
    }
  }
}

// --- Webhook handlers ---

async function onGmailPush(payload: unknown, ctx: MailCtx) {
  try {
    const message = (payload as { message?: { data?: string; messageId?: string } })?.message
    if (!message?.data) {
      ctx.log_warn("Gmail push missing message data")
      return
    }

    const decoded = decodeBase64(message.data)
    const parsed = JSON.parse(decoded) as { emailAddress?: string; historyId?: string }

    if (!parsed.emailAddress) {
      ctx.log_warn("Gmail push missing emailAddress")
      return
    }

    const accounts: AccountRow[] = JSON.parse(
      await ctx.db_findMany(
        "accounts",
        JSON.stringify({
          where: { emailAddress: parsed.emailAddress, provider: "gmail" },
        }),
      ),
    )
    // A push for an account no longer here (a watch still lapsing at the provider): dropped
    // and acknowledged, and its address is not kept even in the log.
    if (accounts.length === 0) {
      ctx.log_info("Gmail push for no connected account, dropped")
      return
    }

    const account = accounts[0]
    if (account.disconnected_at) return

    await ctx.enqueueJob(
      "gmail-incremental-sync",
      JSON.stringify({
        orgId: ctx.getOrgId(),
        accountId: account.id,
        historyId: parsed.historyId,
        push: true,
      }),
      JSON.stringify({ jobId: `gmail-incremental-sync:${account.id}` }),
    )
  } catch (err) {
    ctx.log_error("Gmail push handler error", JSON.stringify({ error: String(err) }))
  }
}

async function onContactMerge(
  event: { data: { sourceId: string; targetId: string } },
  ctx: MailCtx,
) {
  const { sourceId, targetId } = event.data
  const affected = JSON.parse(
    await ctx.db_findMany(
      "conversations",
      JSON.stringify({
        where: { contactId: sourceId },
      }),
    ),
  )

  await ctx.db_updateMany(
    "conversations",
    JSON.stringify({
      where: { contactId: sourceId },
      data: { contactId: targetId },
    }),
  )

  for (const row of affected) {
    await ctx.emit(
      JSON.stringify({
        entity: "conversation",
        action: "update",
        entityId: row.id,
        data: { id: row.id, accountId: row.account_id ?? row.accountId, contactId: targetId },
      }),
    )
  }

  ctx.log_info(
    "Updated conversation contact references after merge",
    JSON.stringify({ sourceId, targetId }),
  )
}

async function sendViaGmail(
  ctx: MailCtx,
  accountEmail: string,
  rfc2822: string,
  threadId?: string,
  opts?: { onDispatch?: () => void },
): Promise<{ messageId: string; threadId?: string }> {
  const token = await ctx.connections_getToken("gmail", accountEmail)
  // Encode host-side: the message can carry multi-MB attachments, and the
  // interpreted fallback encoder freezes the whole process for its duration.
  const raw = ctx.codec_base64UrlEncodeUtf8
    ? await ctx.codec_base64UrlEncodeUtf8(rfc2822)
    : encodeBase64Url(rfc2822)
  opts?.onDispatch?.()
  const response = JSON.parse(
    await ctx.fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      JSON.stringify({
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
      }),
    ),
  )
  if (response.status !== 200) {
    let body: any = null
    try {
      body = response.body ? JSON.parse(response.body) : null
    } catch {
      body = response.body ?? null
    }
    throw {
      code: "GMAIL_SEND_FAILED",
      message: `Gmail send failed with status ${response.status}`,
      status: response.status,
      body,
      providerRejected: response.status >= 400 && response.status < 500,
      deliveryState: response.status >= 400 && response.status < 500 ? "rejected" : undefined,
    }
  }
  const body = response.body ? JSON.parse(response.body) : {}
  return { messageId: body.id ?? body.messageId, threadId: body.threadId }
}

async function sendViaSmtp(
  ctx: MailCtx,
  accountEmail: string,
  message: Record<string, unknown>,
  opts?: { onDispatch?: () => void },
): Promise<{ messageId: string }> {
  opts?.onDispatch?.()
  const result = JSON.parse(await ctx.smtp_send("imap", accountEmail, JSON.stringify(message)))
  return { messageId: result.messageId }
}

function buildSendMessage(
  params: any,
  extra?: { inReplyTo?: string | null; references?: string[] },
) {
  return {
    from: params.accountEmail,
    to: formatMailAddresses(params.to),
    cc: formatMailAddresses(params.cc),
    bcc: formatMailAddresses(params.bcc),
    subject: params.subject,
    htmlBody: params.htmlBody ?? "",
    textBody: params.textBody ?? "",
    attachments: params.attachments,
    ...extra,
  }
}

/**
 * Copy agent-supplied source files onto the mail `outbound_staging` parent
 * (keyed by account id), fetch their bytes, and return MIME-ready
 * `OutboundAttachmentPart[]`. The staged copy ids are returned so the caller
 * can relink them onto the persisted message after the send.
 *
 * `files_attachToParent` performs the RLS read-check, executable denylist,
 * quota, and provenance event; `files_getAttachmentBytes` returns the bytes
 * (the staged copy is a mail-app file, so the app-match gate is satisfied).
 */
/**
 * Blueprint Task 9.9.
 *
 * Re-attaching a stored file reads its bytes back out of the object store. Once
 * Phase 7 seals attachments at import (`kernel.files.enc_version = 1`) those
 * bytes are STREAM ciphertext and the server cannot decrypt them, by design. Left
 * alone, the recipient gets an unreadable blob and the send reports success.
 *
 * So a sealed file is never sent from here. Either the mailbox owner's browser
 * supplied its plaintext (through the approval fulfilment, or the two-phase
 * `mail.attachment` request for an ungated caller), or the send refuses. The
 * detection is `encVersion` as reported by the files bridge, never the mailbox's
 * own state, so an account whose attachments are still plaintext keeps working
 * unchanged and one whose attachments are sealed is caught the moment they are.
 */
async function stageAndLoadAttachments(
  ctx: MailCtx,
  fileIds: string[],
  accountId: string,
  suppliedBytes?: Record<string, string> | null,
): Promise<{
  parts: OutboundAttachmentPart[]
  stagedFileIds: string[]
  /** Sealed files with no supplied plaintext: ASK the client for these. */
  sealedFileIds: string[]
  /** Sealed files whose supplied plaintext was empty: REFUSE, never send. */
  refusedFileIds: string[]
}> {
  const parts: OutboundAttachmentPart[] = []
  const stagedFileIds: string[] = []
  const sealedFileIds: string[] = []
  const refusedFileIds: string[] = []
  if (!ctx.files_attachToParent || !ctx.files_getAttachmentBytes) {
    throw new Error("file attachment bridge unavailable")
  }
  for (const sourceFileId of fileIds) {
    const copied = JSON.parse(
      await ctx.files_attachToParent(
        JSON.stringify({
          sourceFileId,
          targetApp: "mail",
          targetEntityType: "outbound_staging",
          targetEntityId: accountId,
        }),
      ),
    ) as { id: string; filename: string; mimeType: string }
    stagedFileIds.push(copied.id)
    // The bytes read here are STREAM ciphertext whenever the source attachment
    // was sealed at import (Task 7.2), and the server cannot decrypt them by
    // design. `encVersion` is the bridge's report of exactly that, and the
    // branch below is the only thing standing between a sealed file and an
    // unreadable blob arriving at an external recipient. Never attempt a
    // server-side decrypt, and never fall back to sending `decoded.bytesBase64`
    // when it is sealed.
    const decoded = JSON.parse(
      await ctx.files_getAttachmentBytes(
        JSON.stringify({
          fileId: copied.id,
          allowedParents: [{ app: "mail", entityType: "outbound_staging", entityId: accountId }],
        }),
      ),
    ) as { filename?: string; mimeType?: string; bytesBase64: string; encVersion?: number }
    const sealed = typeof decoded.encVersion === "number" && decoded.encVersion >= 1
    let bytesBase64 = decoded.bytesBase64
    if (sealed) {
      const supplied = suppliedBytes?.[sourceFileId]
      if (supplied === undefined) {
        sealedFileIds.push(sourceFileId)
        continue
      }
      if (typeof supplied !== "string" || supplied.length === 0) {
        // The client was asked and came back with nothing. Sending the sealed
        // bytes instead would deliver an unreadable file and report success.
        refusedFileIds.push(sourceFileId)
        continue
      }
      bytesBase64 = supplied
    }
    parts.push({
      filename: decoded.filename ?? copied.filename,
      mimeType: decoded.mimeType ?? copied.mimeType,
      bytesBase64,
      disposition: "attachment",
    })
  }
  return { parts, stagedFileIds, sealedFileIds, refusedFileIds }
}

/**
 * Turn a staging result that contains sealed attachments into either the
 * two-phase request the client answers, or a flat refusal. Returns null when
 * every attachment is sendable, which is the ordinary case.
 *
 * There is deliberately no third option. A partial send, dropping the sealed
 * attachments and delivering the rest, would look like a success to everyone
 * involved and lose the file silently.
 */
function refuseOrAskForSealedAttachments(staged: {
  sealedFileIds: string[]
  refusedFileIds: string[]
}): any | null {
  if (staged.refusedFileIds.length > 0) {
    return {
      error: {
        code: "MAILBOX_LOCKED",
        message:
          "The attachments on this message are stored encrypted and no readable copy was supplied, so nothing was sent. Unlock the mailbox and try again.",
      },
    }
  }
  if (staged.sealedFileIds.length > 0) {
    return {
      needsPlaintext: {
        requestKind: "mail.attachment",
        messageIds: staged.sealedFileIds,
        purpose: "attach the stored files to this outgoing message",
      },
      note: "Nothing was sent. The attachments are stored encrypted, so their readable bytes have to come from the mailbox owner's own browser before the message can go out.",
    }
  }
  return null
}

/**
 * Relink staged attachment copies onto the persisted outbound message so they
 * show on the sent message and the audit trail points there. Best-effort —
 * the email has already been sent, so a relink failure must not fail the send.
 */
async function relinkStagedAttachments(
  ctx: MailCtx,
  stagedFileIds: string[],
  externalMessageId: string,
): Promise<void> {
  if (stagedFileIds.length === 0 || !ctx.files_reparent) return
  const rows = JSON.parse(
    await ctx.db_findMany("messages", JSON.stringify({ where: { externalMessageId }, limit: 1 })),
  ) as Array<{ id: string }>
  const messageId = rows[0]?.id
  if (!messageId) return
  await ctx.files_reparent(
    JSON.stringify({
      fileIds: stagedFileIds,
      targetEntityType: "message",
      targetEntityId: messageId,
    }),
  )
}

/**
 * A body written as markdown or plain text (an agent's draft, an approver's
 * edit, which blanks the stale htmlBody) goes out as formatted email through
 * the host's emailBody (codec_markdownToEmail), as a ticket reply does. A body
 * that already carries HTML is the browser composer's, whose textBody is
 * already the text part: both are sent as given.
 */
async function withEmailBody<T extends { htmlBody?: string; textBody?: string }>(
  params: T,
  ctx: MailCtx,
): Promise<T> {
  if (params.htmlBody?.trim() || !params.textBody?.trim() || !ctx.codec_markdownToEmail) {
    return params
  }
  const body = JSON.parse(await ctx.codec_markdownToEmail(params.textBody))
  return { ...params, htmlBody: body.html, textBody: body.text }
}

async function sendReply(params: any, ctx: MailCtx, opts?: { onDispatch?: () => void }) {
  const references = combineReferences(params.references, params.inReplyTo)
  const msg = buildSendMessage(params, { inReplyTo: params.inReplyTo, references })
  const rfc2822 = buildRfc2822Message(msg)

  if (params.provider === "gmail") {
    const result = await sendViaGmail(
      ctx,
      params.accountEmail,
      rfc2822,
      params.externalThreadId,
      opts,
    )
    return {
      messageId: result.messageId ?? `<reply-${Date.now()}@mail.gmail.com>`,
      externalThreadId: result.threadId ?? params.externalThreadId,
    }
  }

  const result = await sendViaSmtp(ctx, params.accountEmail, msg, opts)
  return { messageId: result.messageId, externalThreadId: params.externalThreadId }
}

async function sendCompose(params: any, ctx: MailCtx, opts?: { onDispatch?: () => void }) {
  const msg = buildSendMessage(params)
  const rfc2822 = buildRfc2822Message(msg)

  if (params.provider === "gmail") {
    const result = await sendViaGmail(ctx, params.accountEmail, rfc2822, undefined, opts)
    return {
      messageId: result.messageId ?? `<compose-${Date.now()}@mail.gmail.com>`,
      externalThreadId: result.threadId ?? result.messageId ?? `thread-${Date.now()}`,
    }
  }

  const result = await sendViaSmtp(ctx, params.accountEmail, msg, opts)
  return { messageId: result.messageId, externalThreadId: result.messageId }
}

async function persistSentMessage(
  ctx: MailCtx,
  account: any,
  params: any,
  result: { messageId: string; externalThreadId?: string },
  extra?: { inReplyTo?: string | null; references?: string[] },
): Promise<void> {
  const sentAt = new Date().toISOString()
  await processMessages(
    [
      {
        externalMessageId: result.messageId,
        externalProviderId: result.messageId,
        externalThreadId: result.externalThreadId ?? result.messageId,
        inReplyTo: extra?.inReplyTo ?? null,
        references: extra?.references ?? [],
        from: { email: params.accountEmail },
        to: params.to ?? [],
        cc: params.cc ?? [],
        bcc: params.bcc ?? [],
        subject: params.subject || null,
        textBody: params.textBody || null,
        htmlBody: params.htmlBody || null,
        snippet: (params.textBody || params.htmlBody || "").slice(0, 200),
        isRead: true,
        isStarred: false,
        labels: ["SENT"],
        direction: "outbound",
        sentAt,
        headers: {},
        sentByUserId: ctx.getUserId(),
      },
    ],
    account,
    ctx,
    "sent",
  )
}

interface ConversationRow {
  id: string
  account_id?: string
  subject?: string | null
  snippet?: string | null
  from_email?: string | null
  from_address?: { name?: string | null; email?: string | null } | null
  is_read?: boolean
  is_starred?: boolean
  assigned_to?: string | null
  status?: string | null
  last_message_at?: string | null
  message_count?: number
  last_inbound_at?: string | null
}

interface MailSearchItem {
  id: string
  subject?: string | null
  snippet: string
  accountEmail: string
  fromName: string | null
  fromEmail: string | null
  unread: boolean
  isStarred?: boolean
  assignedTo?: string | null
  status?: string | null
  lastMessageAt?: string | null
  /** The newest inbound message's date: our own outbound never moves it. */
  lastInboundAt?: string | null
  messageCount?: number
}

type MailSearchWhere = {
  accountId?: string
  contactId?: string
  status?: string
  isRead?: boolean
  assignedTo?: string
}

// Hard cap on how many DB-matching rows we scan when an in-JS post-filter
// (sender substring / date-range / body) is active. The bridge `where` clause
// only supports equality, so range/substring predicates cannot be pushed into
// SQL — we scan the equality-narrowed result set and filter in JS. Mail
// conversation sets per org/account are small; this bound keeps the scan honest
// (exact totalCount + correct paging) without an unbounded read.
const MAIL_SEARCH_SCAN_CAP = 2000

// ── Inbox-hygiene mutations (BL-169 #12) ──────────────────────────────────────
// Archive + (re)label conversations the agent can already see/write, via the generic
// db_update CRUD over app_mail.conversations (status + labels columns exist). No external
// send — purely internal mailbox tidy. Both accept conversationIds[] so the agent issues
// ONE bulk tool call instead of N. Scope-gated (mail:conversations:write) at the framework
// layer; RLS still applies per-conversation (a non-writable id surfaces as a per-id error).
function asStringIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []
}

/** The mailbox a conversation belongs to, or null when it cannot be read. */
async function conversationAccountId(conversationId: string, ctx: MailCtx): Promise<string | null> {
  try {
    const row = JSON.parse(await ctx.db_findOne("conversations", conversationId)) as {
      account_id?: string
    } | null
    return typeof row?.account_id === "string" ? row.account_id : null
  } catch (err) {
    ctx.log_warn?.(
      "Gmail write-back: conversation mailbox not resolved",
      JSON.stringify({ conversationId, error: String(err) }),
    )
    return null
  }
}

async function agentMailArchive(params: any, ctx: MailCtx): Promise<any> {
  const ids = asStringIds(params?.conversationIds)
  if (ids.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "conversationIds (a non-empty array of conversation ids) is required",
      },
    }
  }
  const results: Array<{ id: string; archived: boolean; error?: string }> = []
  const archivedByAccount = new Map<string, string[]>()
  for (const id of ids) {
    try {
      await ctx.db_update("conversations", id, JSON.stringify({ status: "archived" }))
      const accountId = await conversationAccountId(id, ctx)
      if (accountId) {
        archivedByAccount.set(accountId, [...(archivedByAccount.get(accountId) ?? []), id])
      }
      await ctx.emit(
        JSON.stringify({
          entity: "conversation",
          action: "update",
          entityId: id,
          data: { id, status: "archived" },
        }),
      )
      results.push({ id, archived: true })
    } catch (e: any) {
      results.push({ id, archived: false, error: String(e?.message ?? e) })
    }
  }
  // Gmail and IMAP mailboxes archive on the server too (the job skips others).
  // Delayed so it runs after this tool's writes have committed.
  for (const [accountId, conversationIds] of archivedByAccount) {
    await ctx.enqueueJob(
      "gmail-write-back",
      JSON.stringify({
        orgId: ctx.getOrgId(),
        accountId,
        conversationIds,
        fields: { status: "archived" },
        // The tool's writes may commit after this job starts: a conversation
        // not archived yet is looked at once more, later.
        awaitCommit: true,
      }),
      JSON.stringify({ delay: GMAIL_WRITE_BACK_TOOL_DELAY_MS }),
    )
  }
  return { archived: results.filter((r) => r.archived).length, total: ids.length, results }
}

/** Gmail's system label ids and its user label ids (`Label_<n>`), as sync stores them. */
function isGmailLabelId(label: string): boolean {
  return /^(INBOX|UNREAD|STARRED|TRASH|SPAM|SENT|DRAFT|IMPORTANT|CHAT|CATEGORY_[A-Z]+|Label_\d+)$/.test(
    label,
  )
}

async function agentMailSetLabels(params: any, ctx: MailCtx): Promise<any> {
  const ids = asStringIds(params?.conversationIds)
  const labels = asStringIds(params?.labels)
  if (ids.length === 0) {
    return {
      error: { code: "invalid_params", message: "conversationIds (a non-empty array) is required" },
    }
  }
  if (labels.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "labels (a non-empty array of label strings) is required",
      },
    }
  }
  // mode 'add' (default) merges with existing labels; 'replace' overwrites.
  const mode = params?.mode === "replace" ? "replace" : "add"
  const results: Array<{ id: string; labels?: string[]; ok: boolean; error?: string }> = []
  for (const id of ids) {
    try {
      const existing = JSON.parse(await ctx.db_findOne("conversations", id)) as {
        labels?: string[]
      } | null
      // Replace swaps Liaison's labels only. Gmail's own label ids stay: the
      // label roll-up reads them as Gmail's previous state (INBOX decides
      // archive), so dropping them would reopen an archived conversation on the
      // next unrelated Gmail label change.
      const kept =
        mode === "add"
          ? (existing?.labels ?? [])
          : (existing?.labels ?? []).filter((label) => isGmailLabelId(label))
      const next = [...new Set([...kept, ...labels])]
      await ctx.db_update("conversations", id, JSON.stringify({ labels: next }))
      await ctx.emit(
        JSON.stringify({
          entity: "conversation",
          action: "update",
          entityId: id,
          data: { id, labels: next },
        }),
      )
      results.push({ id, labels: next, ok: true })
    } catch (e: any) {
      results.push({ id, ok: false, error: String(e?.message ?? e) })
    }
  }
  return { updated: results.filter((r) => r.ok).length, total: ids.length, results }
}

interface MailScopeParams {
  query?: string
  accountId?: string
  contactId?: string
  status?: string
  unreadOnly?: boolean
  assignedTo?: string
  from?: string
  since?: string
  until?: string
  body?: string
}

// Resolve the shared mail scope (equality `where` + subject/snippet `search` +
// the in-JS post-filters that the bridge's equality-only `where` cannot express:
// sender substring / date range / body text). Both `agentMailSearch` (paged
// list) and `exportConversations` (full-set bundle) build their scope here so an
// export is scoped IDENTICALLY to the search the agent ran — the export never
// silently broadens or narrows relative to the list it bundles. Validates the
// date bounds and returns a typed error (never throws, never silently returns
// all rows) so the model sees a real reason.
async function resolveMailScope(
  params: MailScopeParams,
  ctx: MailCtx,
): Promise<
  | {
      where: MailSearchWhere
      search?: { fields: string[]; query: string }
      postFiltered: boolean
      matchesPostFilters: (r: ConversationRow) => boolean
    }
  | { error: { code: string; message: string } }
> {
  for (const [field, v] of [
    ["since", params.since],
    ["until", params.until],
  ] as const) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) {
      return { error: { code: "invalid_params", message: `${field} is not a valid ISO date` } }
    }
  }

  const where: MailSearchWhere = {}
  if (params.accountId) where.accountId = params.accountId
  if (params.contactId) where.contactId = params.contactId
  if (params.status) where.status = params.status
  if (params.unreadOnly) where.isRead = false
  if (params.assignedTo) where.assignedTo = params.assignedTo
  const search = params.query?.trim()
    ? { fields: ["subject", "snippet"], query: params.query.trim() }
    : undefined

  const fromNeedle = params.from?.trim() ? params.from.trim().toLowerCase() : undefined
  const bodyQuery = params.body?.trim() ? params.body.trim() : undefined
  const postFiltered =
    fromNeedle !== undefined ||
    params.since !== undefined ||
    params.until !== undefined ||
    bodyQuery !== undefined

  let bodyConvIds: Set<string> | undefined
  if (bodyQuery !== undefined) {
    const hits: Array<{ conversation_id: string }> = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({ search: { fields: ["textBody"], query: bodyQuery }, limit: 5000 }),
      ),
    )
    bodyConvIds = new Set(hits.map((m) => m.conversation_id))
  }

  const matchesPostFilters = (r: ConversationRow): boolean => {
    if (fromNeedle !== undefined) {
      const sender = String(r.from_email ?? r.from_address?.email ?? "").toLowerCase()
      if (!sender.includes(fromNeedle)) return false
    }
    if (params.since !== undefined) {
      if (r.last_message_at == null || r.last_message_at < params.since) return false
    }
    if (params.until !== undefined) {
      if (r.last_message_at == null || r.last_message_at > params.until) return false
    }
    if (bodyConvIds !== undefined && !bodyConvIds.has(r.id)) return false
    return true
  }

  return { where, search, postFiltered, matchesPostFilters }
}

// Scan the equality-narrowed (+ optionally subject/snippet-searched) result set
// in DB order and apply the in-JS post-filters over the WHOLE set, bounded by
// MAIL_SEARCH_SCAN_CAP. Returns the matched rows (in lastMessageAt-desc order)
// plus whether the scan hit the cap (so callers can report the bundle is capped
// rather than silently truncating). Shared by the paged search and the export.
async function scanMatchedConversations(
  scope: {
    where: MailSearchWhere
    search?: { fields: string[]; query: string }
    matchesPostFilters: (r: ConversationRow) => boolean
  },
  ctx: MailCtx,
  // LAZY early-exit for the interactive paged search: stop once we have collected
  // `stopAt` matches (enough to fill the requested page + detect a next page). The
  // full-set export omits it and scans to MAIL_SEARCH_SCAN_CAP. Without this, a
  // from/date/body search always paged up to 2000 conversations into the sandbox
  // just to compute an EXACT totalCount — which times out + OOMs on a large mailbox
  // (12k+ threads) even when the wanted thread is recent and in the first DB page.
  opts?: { stopAt?: number },
): Promise<{ matched: ConversationRow[]; truncated: boolean; exhausted: boolean }> {
  const matched: ConversationRow[] = []
  let scanOffset = 0
  const PAGE = 200
  let truncated = false
  let exhausted = false
  for (;;) {
    const batch: ConversationRow[] = JSON.parse(
      await ctx.db_findMany(
        "conversations",
        JSON.stringify({
          where: scope.where,
          search: scope.search,
          orderBy: { lastMessageAt: "desc" },
          limit: PAGE,
          offset: scanOffset,
        }),
      ),
    )
    for (const r of batch) {
      if (scope.matchesPostFilters(r)) matched.push(r)
    }
    scanOffset += batch.length
    if (batch.length < PAGE) {
      exhausted = true
      break
    }
    if (opts?.stopAt != null && matched.length >= opts.stopAt) break
    if (scanOffset >= MAIL_SEARCH_SCAN_CAP) {
      truncated = true
      break
    }
  }
  return { matched, truncated, exhausted }
}

async function agentMailSearch(
  params: {
    query?: string
    accountId?: string
    contactId?: string
    status?: string
    unreadOnly?: boolean
    assignedTo?: string
    from?: string
    since?: string
    until?: string
    body?: string
    /** Gmail Primary / Other (S13). Absent: primary on personal Gmail mailboxes only. */
    category?: "primary" | "other" | "all"
    limit?: number
    cursor?: string
    /**
     * Phase 2 of the client-search exchange (spec section 5.5), supplied by the
     * broker on the RETRY, never by the model: the message ids the user's own
     * browser matched against its local index. Their presence, empty list
     * included, means the free-text half has been answered and must not be
     * asked again.
     */
    __mailboxSearchIds?: string[]
    /** False when that browser holds no usable index, so an empty list above is
     *  "could not answer", not "no matches". */
    __mailboxSearchIndexComplete?: boolean
  },
  ctx: MailCtx,
): Promise<
  | {
      items: MailSearchItem[]
      totalCount: number
      nextCursor?: string
      /** Present only when a free-text term could not be answered server-side. */
      needsClientSearch?: {
        query: string
        filters: Record<string, unknown>
        limit: number
      }
      unanswered?: string
    }
  | { error: { code: string; message: string } }
> {
  // Host-side search (rpc-bridge `mail_search` -> apps/mail/search.ts):
  // structured filters run as real SQL under the caller's RLS tx (from/date
  // included — no more equality-only `where` + in-JS scan), and free text
  // (query + body) resolves through the permission-filtered kernel Meili index
  // (token-based over subject, participants, contact and message text).
  // Nothing pages rows into the sandbox heap beyond the final result page.
  for (const [field, v] of [
    ["since", params.since],
    ["until", params.until],
  ] as const) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) {
      return { error: { code: "invalid_params", message: `${field} is not a valid ISO date` } }
    }
  }
  if (params.category !== undefined && !["primary", "other", "all"].includes(params.category)) {
    return {
      error: { code: "invalid_params", message: "category must be primary, other or all" },
    }
  }
  const limit = Math.min(params.limit ?? 20, 50)
  const offset = params.cursor ? Math.max(Number(params.cursor) || 0, 0) : 0

  // Blueprint Task 9.6. Structured and envelope filters (accountId, contactId,
  // status, unreadOnly, assignedTo, from, since, until) are CLEARTEXT by spec
  // section 2.1 and run unchanged, server-side, under the caller's RLS. Free text
  // cannot: subject, body and snippet are ciphertext for a sealed mailbox, and
  // the caller cannot know which ids match before decryption, so there is nothing
  // for the plaintext-request flow to name. The free-text half is therefore
  // routed to the client's own index and is never silently dropped: the result
  // carries the marker AND says which half went unanswered.
  const freeText = [params.query, params.body].filter(
    (v) => typeof v === "string" && v.trim().length > 0,
  ) as string[]
  let sealedInScope = false
  // The scope could not be resolved. Neither answer is safe on its own: running
  // the free-text half server-side silently misses every encrypted conversation,
  // and stripping it silently misses every plaintext one. So do both: run it as
  // before AND tell the agent the encrypted half went unanswered.
  let unknownScope = false
  // The browser already answered. `clientSearchIds` is an id list the CLIENT
  // produced from its own index, so it can only ever narrow what this query
  // returns, and the page query runs under the caller's RLS either way.
  const clientSearchIds = Array.isArray(params.__mailboxSearchIds)
    ? params.__mailboxSearchIds.filter((id) => typeof id === "string")
    : null
  const clientIndexComplete = params.__mailboxSearchIndexComplete !== false
  // An id list from a browser that could not build an index is not an answer:
  // narrowing to it would report an empty mailbox as a fact.
  const applyClientIds = clientSearchIds !== null && clientIndexComplete
  if (freeText.length > 0) {
    try {
      const accounts = JSON.parse(
        await ctx.db_findMany(
          "accounts",
          JSON.stringify(
            params.accountId
              ? { where: { id: params.accountId }, limit: 1 }
              : { where: { ownerType: "user" }, limit: 50 },
          ),
        ),
      )
      sealedInScope = (accounts ?? []).some((a: any) => mailAccountContentSuppressed(a))
    } catch {
      unknownScope = true
    }
  }

  const raw = JSON.parse(
    await ctx.mail_search(
      JSON.stringify({
        query: sealedInScope ? undefined : params.query,
        body: sealedInScope ? undefined : params.body,
        accountId: params.accountId,
        contactId: params.contactId,
        status: params.status,
        unreadOnly: params.unreadOnly,
        assignedTo: params.assignedTo,
        from: params.from,
        since: params.since,
        until: params.until,
        // S13: an agent that names no category sees a personal Gmail
        // mailbox's Primary only (newsletters stay out of its answers), and
        // every shared or non-Gmail mailbox whole. `all` brings them back.
        ...(params.category === undefined
          ? { category: "primary", categoryScope: "personal-gmail" }
          : { category: params.category }),
        limit,
        offset,
        ...(applyClientIds ? { messageIds: clientSearchIds } : {}),
      }),
    ),
  )
  if (raw.error) return raw

  const items: MailSearchItem[] = (raw.items ?? []).map(
    (row: ConversationRow & { account_email?: string | null }) => ({
      id: row.id,
      subject: row.subject,
      // Inbound preview text is untrusted external content — same fencing as
      // the old projection.
      snippet: wrapExternalContent((row.snippet ?? "").slice(0, 200)),
      accountEmail: row.account_email ?? "",
      fromName: row.from_address?.name ?? null,
      fromEmail: row.from_email ?? row.from_address?.email ?? null,
      unread: !row.is_read,
      isStarred: row.is_starred,
      assignedTo: row.assigned_to,
      status: row.status,
      lastMessageAt: row.last_message_at,
      lastInboundAt: row.last_inbound_at ?? null,
      messageCount: row.message_count,
    }),
  )
  // The browser's half of the exchange is in. Asking again would raise a marker
  // the broker has already spent this turn's wait budget on, and the retry is
  // not brokered a second time, so the marker would reach the agent as the tool
  // result. Answer with what came back instead.
  if ((sealedInScope || unknownScope) && clientSearchIds !== null) {
    return {
      items,
      totalCount: raw.totalCount ?? items.length,
      nextCursor: raw.nextOffset != null ? String(raw.nextOffset) : undefined,
      ...(clientIndexComplete
        ? {}
        : {
            unanswered: `The structured filters were answered from the database. The words ${JSON.stringify(
              freeText.join(" "),
            )} were NOT: this mailbox is end-to-end encrypted, so text search runs in the user's own browser, and that browser has not finished building its index. Treat the rows above as the structured answer only, never as the whole answer.`,
          }),
    }
  }

  if (sealedInScope || unknownScope) {
    return {
      items,
      totalCount: raw.totalCount ?? items.length,
      nextCursor: raw.nextOffset != null ? String(raw.nextOffset) : undefined,
      needsClientSearch: {
        query: freeText.join(" "),
        filters: {
          accountId: params.accountId,
          contactId: params.contactId,
          status: params.status,
          unreadOnly: params.unreadOnly,
          assignedTo: params.assignedTo,
          from: params.from,
          since: params.since,
          until: params.until,
        },
        limit,
      },
      unanswered: `The structured filters were answered from the database. The words ${JSON.stringify(freeText.join(" "))} were NOT: this mailbox is end-to-end encrypted, so text search runs in the user's own browser. Treat the rows above as the structured answer only, never as the whole answer.`,
    }
  }

  return {
    items,
    totalCount: raw.totalCount ?? items.length,
    nextCursor: raw.nextOffset != null ? String(raw.nextOffset) : undefined,
  }
}

// ── mail:export_conversations ────────────────────────────────────────────────
// Compile a SCOPED set of conversations into ONE downloadable kernel.files
// artifact (CSV or Markdown) so the agent can hand back an audit bundle — the
// missing "export-to-file" capability the quarterly dealer-correspondence audit
// needs. The scope params MIRROR mail:search EXACTLY (contactId / accountId /
// status / from / since / until / body / query), and the matched set is resolved
// through the SAME `resolveMailScope` + `scanMatchedConversations` primitives the
// list path uses — so the bundle contains precisely the conversations the agent
// would see in mail:search, scoped server-side over lastMessageAt for since/until
// (no client-side approximation, no broadening). It compiles the FULL matched set
// (every page, not just the first), not a single search page.
//
// INTEGRITY: every row traces to a real conversation visible under the caller's
// RLS (rows come from ctx.db_findMany, which runs under the caller's RLS context
// — the export can never escalate or invent a row). The file bytes hold only what
// the caller can already read.
//
// GATING: this is a READ-to-file — it sends nothing externally and mutates no
// business state (it only writes one derived artifact). It is therefore UNGATED
// and scoped `mail:conversations:read`, exactly like mail:search/mail:read. The
// returned envelope carries the file id + the scope it bundled (provenance) so
// the agent reports a real downloadable artifact, never a fabricated one.
//
// ARTIFACT: RFC-4180 CSV (default) — one row per conversation: dealer/contact,
// account, subject, lastMessageAt, status, messageCount, snippet — or a Markdown
// digest. Written via the files_importAttachment bridge as a kernel.files row
// parented to the resolved mail account (the `outbound_staging` fileParent), so
// it is discoverable via files_list (mail, outbound_staging, <accountId>) and
// downloadable.
const MAIL_EXPORT_CSV_COLUMNS: Array<[string, string]> = [
  ["conversationId", "id"],
  ["contact", "contactName"],
  ["accountEmail", "accountEmail"],
  ["subject", "subject"],
  ["fromName", "fromName"],
  ["fromEmail", "fromEmail"],
  ["lastMessageAt", "lastMessageAt"],
  ["status", "status"],
  ["messageCount", "messageCount"],
  ["snippet", "snippet"],
]

interface ExportConvRow {
  id: string
  contactName: string
  accountEmail: string
  subject: string
  fromName: string
  fromEmail: string
  lastMessageAt: string
  status: string
  messageCount: string
  snippet: string
}

function buildExportCsv(rows: ExportConvRow[]): string {
  // RFC-4180: CRLF line endings, header row, each field quoted when it contains
  // a comma / quote / CR / LF (mailCsvCell handles the doubling of embedded
  // quotes). Deterministic column order.
  const header = MAIL_EXPORT_CSV_COLUMNS.map(([k]) => k).join(",")
  const body = rows
    .map((r) =>
      MAIL_EXPORT_CSV_COLUMNS.map(([, key]) => mailCsvCell(r[key as keyof ExportConvRow])).join(
        ",",
      ),
    )
    .join("\r\n")
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`
}

function buildExportMarkdown(rows: ExportConvRow[], scopeLine: string): string {
  const lines: string[] = [
    "# Mail correspondence export",
    "",
    scopeLine,
    "",
    `Conversations: ${rows.length}`,
    "",
  ]
  for (const r of rows) {
    lines.push(`## ${r.subject || "(no subject)"}`)
    lines.push("")
    lines.push(`- Contact: ${r.contactName || "(unlinked)"}`)
    lines.push(
      `- From: ${r.fromName ? `${r.fromName} <${r.fromEmail}>` : r.fromEmail || "(unknown)"}`,
    )
    lines.push(`- Mailbox: ${r.accountEmail}`)
    lines.push(`- Last message: ${r.lastMessageAt}`)
    lines.push(`- Status: ${r.status}  ·  Messages: ${r.messageCount}`)
    lines.push(`- Conversation id: ${r.id}`)
    if (r.snippet) {
      lines.push("")
      lines.push(`  > ${r.snippet.replace(/\n/g, "\n  > ")}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

async function exportConversations(
  params: {
    query?: string
    accountId?: string
    contactId?: string
    status?: string
    unreadOnly?: boolean
    assignedTo?: string
    from?: string
    since?: string
    until?: string
    body?: string
    format?: "csv" | "markdown"
    filename?: string
  },
  ctx: MailCtx,
): Promise<
  | {
      fileId: string
      filename: string
      mimeType: string
      sizeBytes: number
      format: "csv" | "markdown"
      conversationCount: number
      truncated: boolean
      accountId: string
      scope: Record<string, unknown>
    }
  | { error: { code: string; message: string } }
> {
  if (!ctx.files_importAttachment) {
    return {
      error: {
        code: "unsupported",
        message:
          "the files bridge is unavailable in this context, so no export artifact can be written",
      },
    }
  }

  const format: "csv" | "markdown" = params.format === "markdown" ? "markdown" : "csv"

  const scope = await resolveMailScope(params, ctx)
  if ("error" in scope) return scope

  // Resolve the account the artifact will be parented to (its `outbound_staging`
  // fileParent). If the caller scoped to a specific account, use it; otherwise
  // fall back to the org's default mailbox — the same resolution compose uses. We
  // REQUIRE a real, RLS-visible account: absent ⇒ a typed error (never write an
  // orphaned/un-parentable artifact, never silently succeed with no file).
  let parentAccount: { id?: string; email_address?: string } | null = null
  if (params.accountId) {
    try {
      parentAccount = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
    } catch {
      parentAccount = null
    }
  }
  if (!parentAccount?.id) {
    const orgAccounts = JSON.parse(
      await ctx.db_findMany("accounts", JSON.stringify({ where: { ownerType: "org" }, limit: 1 })),
    ) as Array<{ id?: string; email_address?: string }>
    parentAccount = orgAccounts[0] ?? null
  }
  if (!parentAccount?.id) {
    return {
      error: {
        code: "NOT_FOUND",
        message:
          "no mail account is visible to parent the export artifact to (scope an accountId or ensure an org mailbox exists)",
      },
    }
  }

  // Collect the FULL matched set (all pages), scoped identically to mail:search.
  let matched: ConversationRow[]
  let truncated: boolean
  if (!scope.postFiltered) {
    matched = []
    let offset = 0
    const PAGE = 200
    for (;;) {
      const batch: ConversationRow[] = JSON.parse(
        await ctx.db_findMany(
          "conversations",
          JSON.stringify({
            where: scope.where,
            search: scope.search,
            orderBy: { lastMessageAt: "desc" },
            limit: PAGE,
            offset,
          }),
        ),
      )
      matched.push(...batch)
      offset += batch.length
      if (batch.length < PAGE) break
      if (offset >= MAIL_SEARCH_SCAN_CAP) break
    }
    truncated = matched.length >= MAIL_SEARCH_SCAN_CAP
  } else {
    const res = await scanMatchedConversations(
      { where: scope.where, search: scope.search, matchesPostFilters: scope.matchesPostFilters },
      ctx,
    )
    matched = res.matched
    truncated = res.truncated
  }

  // Project each matched conversation, resolving the linked CRM contact name and
  // the account email. Snippets are NOT re-fenced here — the artifact is a data
  // file, not agent-facing text the model would act on.
  //
  // Invariant K. An export is the most direct way to materialise a plaintext
  // copy of a mailbox on the server, so for an encrypted personal mailbox the
  // artifact carries the ENVELOPE only: correspondent, mailbox, dates, status
  // and counts, never a subject and never a snippet. The plaintext columns are
  // already NULL for newly sealed mail, but every historical conversation still
  // holds them for the whole Phase 12 dual-read window, so the suppression has
  // to be explicit rather than inherited from the row.
  //
  // A full export of an encrypted mailbox is still available: the account holder
  // produces it from their own client, which is the only place the keys exist.
  const accountCache = new Map<string, { email: string; encrypted: boolean }>()
  let anyEncrypted = false
  const rows: ExportConvRow[] = []
  for (const r of matched) {
    let accountEmail = ""
    let accountEncrypted = false
    if (r.account_id) {
      const cached = accountCache.get(r.account_id)
      if (cached !== undefined) {
        accountEmail = cached.email
        accountEncrypted = cached.encrypted
      } else {
        const acct: {
          email_address?: string
          owner_type?: string
          encryption_state?: string
        } | null = JSON.parse(await ctx.db_findOne("accounts", r.account_id))
        accountEmail = acct?.email_address ?? ""
        accountEncrypted = mailAccountContentSuppressed(acct)
        accountCache.set(r.account_id, { email: accountEmail, encrypted: accountEncrypted })
      }
    }
    if (accountEncrypted) anyEncrypted = true
    let contactName = ""
    const contactId = (r as ConversationRow & { contact_id?: string | null }).contact_id
    if (contactId) {
      try {
        const contact: { name?: string } | null = JSON.parse(
          await ctx.kernel_findOne("contacts", contactId),
        )
        contactName = contact?.name ?? ""
      } catch {
        contactName = ""
      }
    }
    rows.push({
      id: r.id,
      contactName,
      accountEmail,
      subject: accountEncrypted ? "" : (r.subject ?? ""),
      fromName: r.from_address?.name ?? "",
      fromEmail: r.from_email ?? r.from_address?.email ?? "",
      lastMessageAt: r.last_message_at ?? "",
      status: r.status ?? "",
      messageCount: r.message_count != null ? String(r.message_count) : "",
      snippet: accountEncrypted ? "" : (r.snippet ?? "").slice(0, 500),
    })
  }

  const scopeRecord: Record<string, unknown> = {}
  for (const k of [
    "query",
    "accountId",
    "contactId",
    "status",
    "from",
    "since",
    "until",
    "body",
  ] as const) {
    if (params[k] !== undefined) scopeRecord[k] = params[k]
  }
  if (params.unreadOnly) scopeRecord.unreadOnly = true

  const encryptedNote = anyEncrypted
    ? " Note: one or more of these mailboxes is encrypted, so this export carries envelope columns only (correspondent, mailbox, dates, status, counts). Subjects and message text are readable only by the mailbox owner, whose own client produces a full export."
    : ""
  const scopeLine = `Scope: ${
    Object.keys(scopeRecord).length
      ? Object.entries(scopeRecord)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ")
      : "all visible conversations"
  }${encryptedNote}`

  // The note rides in the CSV as a leading `#` comment line (the conventional
  // CSV comment, skipped by every reader that supports one) so an operator
  // opening the file sees WHY the subject column is empty rather than filing a
  // bug about a broken export.
  const content =
    format === "csv"
      ? `${anyEncrypted ? `# ${encryptedNote.trim()}\r\n` : ""}${buildExportCsv(rows)}`
      : buildExportMarkdown(rows, scopeLine)
  const mimeType = format === "csv" ? "text/csv" : "text/markdown"
  const ext = format === "csv" ? "csv" : "md"
  const defaultName = `mail-correspondence-export.${ext}`
  const filename =
    typeof params.filename === "string" && params.filename.trim().length > 0
      ? params.filename.trim()
      : defaultName

  // Encode UTF-8 → STANDARD base64 for the files bridge (it decodes via
  // Buffer.from(bytesBase64, "base64"), which expects standard +/ alphabet and
  // = padding — NOT base64url). Encoded deterministically so two runs over the
  // same scoped set produce byte-identical artifacts. Host-side when
  // available: exports can span thousands of messages and the interpreted
  // encoder blocks the process for the whole encode.
  const bytesBase64 = ctx.codec_base64EncodeUtf8
    ? await ctx.codec_base64EncodeUtf8(content)
    : encodeBase64Std(content)

  const written = JSON.parse(
    await ctx.files_importAttachment(
      JSON.stringify({
        targetApp: "mail",
        targetEntityType: "outbound_staging",
        targetEntityId: parentAccount.id,
        filename,
        mimeType,
        bytesBase64,
        disposition: "attachment",
        ordinal: 0,
      }),
    ),
  ) as { id: string; filename: string; sizeBytes: number }

  return {
    fileId: written.id,
    filename: written.filename,
    mimeType,
    sizeBytes: written.sizeBytes,
    format,
    conversationCount: rows.length,
    truncated,
    accountId: parentAccount.id,
    scope: scopeRecord,
  }
}

// ── The two-phase agent read protocol, phase 1 ───────────────────────────────
//
// Blueprint Tasks 9.1, 9.6, 9.8; spec section 5.3b. For a personal mailbox that
// is sealed, the server holds ciphertext and CANNOT produce body text at all.
// The tools therefore resolve envelope metadata under RLS exactly as before and
// return a structured MARKER instead of text, immediately. They never block,
// never wait and never call out to a browser: the sandbox budget is 5 s in
// production, the mail tools declare no `timeoutMs`, and a sandbox timeout kills
// the worker outright. The waiting happens one layer up, in the tool bridge.
//
// "Sealed" here is the same question `mailAccountContentSuppressed` answers for
// the export and search surfaces, so the agent read path and the projections
// cannot disagree about which mailbox is under the regime.

/** The envelope of one message: everything that is cleartext by section 2.1. */
function projectMessageEnvelope(message: any, attachments: any[]): any {
  return {
    messageId: message.id,
    from: message.from_address,
    to: message.to_addresses ?? [],
    sentAt: message.sent_at,
    direction: message.direction,
    hasAttachments: attachments.length > 0,
    attachments,
    labels: message.labels ?? [],
  }
}

async function agentMailRead(
  params: {
    conversationId: string
    messagesLimit?: number
    messagesCursor?: string
    includeBody?: boolean
    messageId?: string
  },
  ctx: MailCtx,
): Promise<any> {
  const conversation = JSON.parse(await ctx.db_findOne("conversations", params.conversationId))
  if (!conversation?.id)
    return { error: { code: "NOT_FOUND", message: "Conversation not found or inaccessible" } }

  const account = JSON.parse(await ctx.db_findOne("accounts", conversation.account_id))
  const contact = conversation.contact_id
    ? JSON.parse(await ctx.kernel_findOne("contacts", conversation.contact_id))
    : null

  function projectConversation() {
    return {
      id: conversation.id,
      subject: conversation.subject,
      account: { id: account?.id, email: account?.email_address },
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      status: conversation.status,
      isRead: conversation.is_read,
      isStarred: conversation.is_starred,
      assignedTo: conversation.assigned_to,
      messageCount: conversation.message_count,
      lastMessageAt: conversation.last_message_at,
    }
  }

  async function projectMessage(message: any, bodyCap?: number, stripQuoted = true) {
    const sentByUser = message.sent_by_user_id
      ? JSON.parse(await ctx.kernel_findOne("users", message.sent_by_user_id))
      : null
    const body = message.text_body ?? ""
    // Inbound messages are written by the external sender (the customer); their
    // body/snippet is untrusted and must be fenced so the agent treats it as
    // data. Outbound/internal messages are our own text — left unwrapped.
    const isInbound = message.direction === "inbound"
    const rawSnippet = (message.snippet ?? "").slice(0, 200)
    const projected: any = {
      id: message.id,
      from: message.from_address,
      to: message.to_addresses ?? [],
      sentAt: message.sent_at,
      direction: message.direction,
      sentByUser: sentByUser ? { id: sentByUser.id, name: sentByUser.name } : null,
      snippet: isInbound ? wrapExternalContent(rawSnippet) : rawSnippet,
    }
    if (bodyCap) {
      // Strip the quoted reply-chain tail BEFORE capping: a raw email body is
      // often mostly its own quoted history, so capping first would spend the
      // budget on duplication. The messageId drill-down path passes
      // stripQuoted:false — asking for one exact message is the opt-in to its
      // full chain.
      const stripped = stripQuoted ? stripQuotedHistory(body).text : body
      const capped = stripped.length > bodyCap ? stripped.slice(0, bodyCap) : stripped
      projected.textBody = isInbound ? wrapExternalContent(capped) : capped
      projected.bodyTruncated = stripped.length > bodyCap
    }
    // Surface inbound attachments (a PDF invoice, a label, an image) with their
    // kernel file ids so the agent can "pull"/forward/re-attach them directly —
    // no separate files_list call with a guessed (app, entityType, entityId)
    // tuple. Empty array when the message has none.
    projected.attachments = await listMessageAttachments(message.id, ctx)
    return projected
  }

  // Envelope-only conversation projection for a sealed mailbox: `subject` is
  // ciphertext (NULL in the plaintext column), so it is simply not there.
  function projectSealedConversation() {
    return {
      id: conversation.id,
      account: { id: account?.id, email: account?.email_address },
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      status: conversation.status,
      isRead: conversation.is_read,
      isStarred: conversation.is_starred,
      assignedTo: conversation.assigned_to,
      messageCount: conversation.message_count,
      lastMessageAt: conversation.last_message_at,
      encrypted: true,
    }
  }

  if (mailAccountContentSuppressed(account)) {
    let rows: any[]
    if (params.messageId) {
      const message = JSON.parse(await ctx.db_findOne("messages", params.messageId))
      if (!message?.id || message.conversation_id !== params.conversationId) {
        return { error: { code: "NOT_FOUND", message: "Message not found in conversation" } }
      }
      rows = [message]
    } else {
      const limit = Math.min(params.messagesLimit ?? 5, 25)
      const offset = params.messagesCursor ? Math.max(Number(params.messagesCursor) || 0, 0) : 0
      rows = JSON.parse(
        await ctx.db_findMany(
          "messages",
          JSON.stringify({
            where: { conversationId: params.conversationId },
            orderBy: { sentAt: "desc" },
            limit,
            offset,
          }),
        ),
      ).reverse()
    }
    const envelope = []
    for (const row of rows) {
      envelope.push(projectMessageEnvelope(row, await listMessageAttachments(row.id, ctx)))
    }
    return {
      conversation: projectSealedConversation(),
      needsPlaintext: {
        requestKind: "mail.read",
        messageIds: envelope.map((e: any) => e.messageId),
        purpose: "read this conversation to answer the user",
      },
      envelope,
      note: "This mailbox is end-to-end encrypted. The server holds only ciphertext, so subjects and bodies are not in this result. They are supplied for this turn only, by the user's own browser, when the mailbox is unlocked.",
    }
  }

  if (params.messageId) {
    const message = JSON.parse(await ctx.db_findOne("messages", params.messageId))
    if (!message?.id || message.conversation_id !== params.conversationId) {
      return { error: { code: "NOT_FOUND", message: "Message not found in conversation" } }
    }
    return {
      conversation: projectConversation(),
      messages: [await projectMessage(message, 200 * 1024, false)],
      hasMoreMessages: false,
    }
  }

  const limit = Math.min(params.messagesLimit ?? 5, 25)
  const offset = params.messagesCursor ? Math.max(Number(params.messagesCursor) || 0, 0) : 0
  const messagesResult = JSON.parse(
    await ctx.db_findMany(
      "messages",
      JSON.stringify({
        where: { conversationId: params.conversationId },
        orderBy: { sentAt: "desc" },
        limit,
        offset,
      }),
    ),
  )
  const messages = await Promise.all(
    messagesResult
      .reverse()
      .map((message: any) => projectMessage(message, params.includeBody ? 4000 : undefined)),
  )

  return {
    conversation: projectConversation(),
    messages,
    hasMoreMessages: messagesResult.length === limit,
    nextMessagesCursor: messagesResult.length === limit ? String(offset + limit) : undefined,
    pendingReplyDrafts: await listPendingReplyDrafts(conversation.id, ctx),
  }
}

async function agentMailReply(params: any, ctx: MailCtx): Promise<any> {
  await ctx.approval_recordStarted("mail:reply")
  let dispatched = false
  let classified = false
  try {
    const conversation = JSON.parse(await ctx.db_findOne("conversations", params.conversationId))
    if (!conversation?.id) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        "mail:reply",
        JSON.stringify({ code: "NOT_FOUND", message: "Conversation not found" }),
      )
      throw new Error("Conversation not found")
    }
    const account = JSON.parse(await ctx.db_findOne("accounts", conversation.account_id))
    if (!account?.id) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        "mail:reply",
        JSON.stringify({ code: "NOT_FOUND", message: "Account not found" }),
      )
      throw new Error("Account not found")
    }
    const messagesRows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: { conversationId: params.conversationId, direction: "inbound" },
          orderBy: { sentAt: "desc" },
          limit: 1,
        }),
      ),
    )
    const latest = messagesRows[0]
    if (!latest) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        "mail:reply",
        JSON.stringify({ code: "NOT_FOUND", message: "No inbound message to reply to" }),
      )
      throw new Error("No inbound message to reply to")
    }
    const guardCheck = await checkSendGuard(
      "mail:reply",
      params,
      { ...params, to: replyRecipients(params.to, latest), conversationId: params.conversationId },
      ctx,
    )
    if (guardCheck.stop) {
      classified = true
      if (guardCheck.refusal) return guardCheck.refusal
      throw new Error(guardCheck.message)
    }
    // Blueprint Task 9.8, the reply half. The `Re:` subject is derived from a
    // SEALED subject, which the server does not hold. A reply whose subject is a
    // bare "Re: " is the same silent data loss as an empty forward quote, so the
    // subject is asked for and, failing that, the send is refused.
    let sealedSubject: string | null = null
    if (mailAccountContentSuppressed(account)) {
      const supplied = (params as any).__mailboxQuote?.[latest.id] ?? null
      if (!supplied) {
        classified = true
        await ctx.approval_recordFailedNoEffect(
          "mail:reply",
          JSON.stringify({
            code: "NEEDS_PLAINTEXT",
            message: "the reply subject has to be resolved by the mailbox owner's browser",
          }),
        )
        return {
          needsPlaintext: {
            requestKind: "mail.quote",
            messageIds: [latest.id],
            purpose: "resolve the subject line of the conversation being replied to",
          },
          note: "Nothing was sent. This mailbox is end-to-end encrypted, so the subject line has to come from the user's own browser before the reply can go out.",
        }
      }
      sealedSubject = supplied.resolvedSubject ?? null
      if (!sealedSubject) {
        classified = true
        await ctx.approval_recordFailedNoEffect(
          "mail:reply",
          JSON.stringify({
            code: "MAILBOX_LOCKED",
            message: "the subject line was not supplied, so nothing was sent",
          }),
        )
        return {
          error: {
            code: "MAILBOX_LOCKED",
            message:
              "The mailbox is locked, so the conversation subject could not be resolved. Nothing was sent. Ask the user to unlock their mailbox and try again.",
          },
        }
      }
    }
    const baseSubject = sealedSubject ?? conversation.subject ?? ""
    const subject = baseSubject.startsWith("Re:") ? baseSubject : `Re: ${baseSubject}`
    let attachmentParts: OutboundAttachmentPart[] = []
    let stagedFileIds: string[] = []
    if (Array.isArray(params.attachments) && params.attachments.length > 0) {
      // Blueprint Task 9.9, the reply call site.
      const staged = await stageAndLoadAttachments(
        ctx,
        params.attachments,
        account.id,
        (params as any).__mailboxAttachments ?? null,
      )
      const refusal = refuseOrAskForSealedAttachments(staged)
      if (refusal) {
        classified = true
        await ctx.approval_recordFailedNoEffect(
          "mail:reply",
          JSON.stringify({
            code: "MAILBOX_LOCKED",
            message: "a sealed attachment could not be sent, so nothing was sent",
          }),
        )
        return refusal
      }
      attachmentParts = staged.parts
      stagedFileIds = staged.stagedFileIds
    }
    // Reply target: default is the last inbound sender, but an explicit `to`
    // overrides it (gmail-style recipient editing) — e.g. when the latest
    // synced message is our own outbound (we were only cc'd), the default
    // would address a teammate instead of the customer.
    const toOverride = Array.isArray(params.to)
      ? params.to
          .map((v: unknown) => (typeof v === "string" ? v.trim() : ""))
          .filter((v: string) => v.length > 0)
      : []
    // The default keeps the stored sender as it is ({name,email}): the send
    // formats it for the header (RFC 2047 for a non-ASCII name), and the sent
    // copy persists it in the shape a synced message has, never as a header
    // string with encoded words in it.
    const defaultTo = formatMailAddress(latest.from_address) ? latest.from_address : null
    const to: unknown[] = toOverride.length > 0 ? toOverride : defaultTo ? [defaultTo] : []
    if (to.length === 0) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        "mail:reply",
        JSON.stringify({
          code: "invalid_params",
          message:
            "No valid reply recipient: the stored sender address is unusable and no `to` was given",
        }),
      )
      throw new Error("No valid reply recipient")
    }
    const sendParams = await withEmailBody(
      {
        provider: account.provider,
        accountEmail: account.email_address,
        to,
        cc: params.cc ?? [],
        bcc: params.bcc ?? [],
        subject,
        textBody: guardCheck.footer?.textBody ?? params.textBody,
        htmlBody: guardCheck.footer?.htmlBody ?? params.htmlBody,
        externalThreadId: conversation.external_thread_id,
        inReplyTo: latest.external_message_id,
        references: latest.message_references ?? [],
        attachments: attachmentParts,
      },
      ctx,
    )
    const result = await sendReply(sendParams, ctx, {
      onDispatch: () => {
        dispatched = true
      },
    })
    const sentRef = sentMessageRef(sendParams.provider, result)
    await recordSendLanded(ctx, "mail:reply", sentRef)
    await persistSentMessage(ctx, account, sendParams, result, {
      inReplyTo: sendParams.inReplyTo,
      references: sendParams.references,
    })
    if (stagedFileIds.length > 0) {
      try {
        await relinkStagedAttachments(ctx, stagedFileIds, result.messageId)
      } catch (err) {
        ctx.log_warn("mail.reply attachment relink failed", JSON.stringify({ err: String(err) }))
      }
    }
    await ctx.approval_recordSucceeded(
      "mail:reply",
      JSON.stringify({ ...sentRef, ...(guardCheck.record ?? {}) }),
    )
    return {
      ...result,
      note: `Sent to ${sendParams.to.map(sentToLabel).join(", ")} from ${account.email_address}, in conversation ${params.conversationId}.`,
    }
  } catch (err: any) {
    if (classified) throw err
    const errPayload = {
      code: err?.code ?? "UNKNOWN",
      message: String(err?.message ?? err),
      status: err?.status,
      body: err?.body,
    }
    if (!dispatched || isProviderRejection(err)) {
      await ctx.approval_recordFailedNoEffect("mail:reply", JSON.stringify(errPayload))
    } else {
      await ctx.approval_recordAmbiguous("mail:reply", JSON.stringify(errPayload))
    }
    throw err
  }
}

type SendGuardCheck =
  | {
      stop: false
      footer?: { textBody?: string; htmlBody?: string }
      /** The check's result, kept with the recorded send. Absent when no check applies. */
      record?: { guard: { state: string; mode: string; classification: string } }
    }
  | { stop: true; message: string; refusal?: unknown }

/** A recipient as a result states it: the address alone. */
function sentToLabel(recipient: unknown): string {
  if (typeof recipient === "string") return recipient
  return String((recipient as { email?: unknown } | null)?.email ?? recipient)
}

/** Who a reply goes to when the draft names nobody: the last inbound sender. */
function replyRecipients(to: unknown, latest: { from_address?: unknown } | undefined): unknown[] {
  if (Array.isArray(to) && to.length > 0) return to
  return latest?.from_address ? [latest.from_address] : []
}

/**
 * The send check, before anything leaves. An approved call records the stop and
 * throws, and the kernel closes or re-pends the request by its `final`. With no
 * approval behind the call (a policy approved it) the run gets a refusal instead.
 * Only the check's own footer reaches the send: it is never in the staged payload.
 */
async function checkSendGuard(
  toolName: string,
  params: any,
  payload: any,
  ctx: MailCtx,
): Promise<SendGuardCheck> {
  const result = JSON.parse(
    await ctx.mail_checkSendGuard(
      JSON.stringify({
        sendGuard: params.sendGuard,
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        conversationId: payload.conversationId,
        textBody: params.textBody,
        htmlBody: params.htmlBody,
      }),
    ),
  )
  if (!result.applies || result.state === "clear") {
    return {
      stop: false,
      ...(result.footer ? { footer: result.footer } : {}),
      ...(result.record ? { record: result.record } : {}),
    }
  }
  if (result.approved) {
    await ctx.approval_recordFailedNoEffect(
      toolName,
      JSON.stringify({
        code: result.code,
        message: result.message,
        ...(result.final ? { final: true } : {}),
        guard: result.guard,
      }),
    )
    return { stop: true, message: result.message }
  }
  return {
    stop: true,
    message: result.message,
    refusal: {
      status: "error",
      error: {
        code: result.code,
        message: result.message,
        retryable: !result.final,
        refusal: true,
        body: { guard: result.guard },
      },
    },
  }
}

/** The send check's pin on a staged call, the preflight's last step. */
async function pinSendGuard(
  toolName: string,
  params: any,
  payload: { to?: unknown; conversationId?: string },
  ctx: MailCtx,
): Promise<any> {
  const built = JSON.parse(
    await ctx.mail_buildSendGuard(
      JSON.stringify({
        toolName,
        to: payload.to,
        cc: params.cc,
        bcc: params.bcc,
        conversationId: payload.conversationId,
        followUp: params.followUp,
      }),
    ),
  )
  if (built.refusal) {
    return { status: "error", error: { ...built.refusal, refusal: true } }
  }
  if (!built.applies) return { ok: true }
  return {
    ok: true,
    pinnedParams: {
      sendGuard: built.sendGuard,
      ...(built.guardKey ? { guardKey: built.guardKey } : {}),
    },
  }
}

interface SentMessageRef {
  provider?: string
  messageId: string
  externalThreadId?: string
}

function sentMessageRef(
  provider: string | undefined,
  result: { messageId: string; externalThreadId?: string },
): SentMessageRef {
  return { provider, messageId: result.messageId, externalThreadId: result.externalThreadId }
}

/**
 * Record that the provider accepted the message, BEFORE persisting the sent copy
 * or relinking attachments. That post-send work can outlast the execution
 * ceiling; if it is cut off there, the host reads this ref and records the send
 * as done (the mail sync ingests the sent copy) instead of leaving the approval
 * unknown, and never sends again.
 */
async function recordSendLanded(
  ctx: MailCtx,
  toolName: string,
  ref: SentMessageRef,
): Promise<void> {
  if (!ctx.approval_recordEffectLanded) return
  await ctx.approval_recordEffectLanded(toolName, JSON.stringify(ref))
}

function isProviderRejection(err: any): boolean {
  return (
    err?.providerRejected === true ||
    err?.deliveryState === "rejected" ||
    err?.deliveryState === "not_delivered"
  )
}

async function agentMailReplyPreflight(params: any, ctx: MailCtx): Promise<any> {
  const conversation = JSON.parse(await ctx.db_findOne("conversations", params.conversationId))
  if (!conversation?.id) {
    return { error: { code: "NOT_FOUND", message: "Conversation not found or inaccessible" } }
  }

  const account = JSON.parse(await ctx.db_findOne("accounts", conversation.account_id))
  if (!account?.id) {
    return {
      error: { code: "NOT_FOUND", message: "Conversation account not found or inaccessible" },
    }
  }

  // PROPOSE-time guard for a reply with NO INBOUND MESSAGE (the claire-day-finance sales-handoff root):
  // mail:reply renders the customer `To:` from the conversation's most recent INBOUND message, so a
  // conversation with no inbound message (e.g. an OUTBOUND-only dunning/final-demand thread the agent
  // tried to "reply" to) has no recipient — the execute handler throws `No inbound message to reply to`
  // (handler_no_effect / 422) at decide time, which surfaces as an UNVERIFIABLE approved gated execution
  // and force-fails the run. Catch it HERE, at propose, with a clear, self-correcting error so the agent
  // drops mail:reply and reaches for the right OUTBOUND tool instead (mail:compose for a new email, or
  // invoicing's documents_send_to_customer for a dunning/demand to a dealer) — never a doomed gated
  // approval. Mirrors the tickets:reply `no_inbound`/`no_recipient` propose-time preflight (l577).
  const inboundRows = JSON.parse(
    await ctx.db_findMany(
      "messages",
      JSON.stringify({
        where: { conversationId: params.conversationId, direction: "inbound" },
        orderBy: { sentAt: "desc" },
        limit: 1,
      }),
    ),
  ) as Array<{ from_address?: unknown }>
  if (inboundRows.length === 0) {
    return {
      error: {
        code: "no_inbound",
        message:
          "This conversation has no inbound message to reply to, so mail:reply has no recipient to send to. " +
          "Use mail:compose to start a NEW outbound email (or, for a dealer dunning/final-demand, invoicing's " +
          "documents_send_to_customer) instead of replying to a thread with no inbound message.",
      },
    }
  }

  return pinSendGuard(
    "mail:reply",
    params,
    { to: replyRecipients(params.to, inboundRows[0]), conversationId: params.conversationId },
    ctx,
  )
}

const COMPOSE_ACCOUNT_REQUIRED =
  "accountId is required: call mail listAccounts and pass the id of the mailbox to send FROM (the user's own mailbox when they write as themselves, the shared org mailbox only for mail the org sends)."
const COMPOSE_ACCOUNT_NOT_FOUND =
  "No mailbox matches that accountId: call mail listAccounts and pass a real account id. Never invent one."

/**
 * Shared compose pipeline used by both `agentMailCompose` (post-approval) and
 * `agentMailComposeForApp` (internal, no gate; caller has already gated at its
 * own surface). Holds everything from "after the approval gate" onward:
 * account lookup, attachment materialization, MIME assembly, send, persist,
 * staged-attachment relink, and audit recording.
 *
 * `auditToolName` selects which tool name the `approval_record*` audit calls
 * are stamped under (so the audit chain is correctly scoped to mail:compose
 * vs mail:composeForApp). `extraSuccessPayload` is merged into the recorded
 * success payload — used by `composeForApp` to thread `originating_approval_id`
 * for the cross-app audit chain.
 *
 * Refactor invariant (resolves review I8): both `agentMailCompose` and
 * `agentMailComposeForApp` MUST call `_doCompose`. The test
 * `agentMailCompose and agentMailComposeForApp share _doCompose` in
 * handlers.test.ts enforces this statically.
 */
async function _doCompose(
  auditToolName: string,
  params: any,
  ctx: MailCtx,
  extraSuccessPayload?: Record<string, unknown>,
): Promise<any> {
  await ctx.approval_recordStarted(auditToolName)
  let dispatched = false
  let classified = false
  try {
    // Resolve the send-from account. `accountId` is required (see agentMailComposePreflight): a missing
    // or unknown id is refused, never replaced by the org's shared mailbox. A non-uuid placeholder makes
    // db_findOne throw, so treat that as not found.
    let account: {
      id?: string
      provider?: string
      email_address?: string
      owner_type?: string
      encryption_state?: string
    } | null = null
    if (params.accountId) {
      try {
        account = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
      } catch {
        account = null
      }
    }
    if (!account?.id) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        auditToolName,
        JSON.stringify({
          code: params.accountId ? "NOT_FOUND" : "invalid_params",
          message: params.accountId ? COMPOSE_ACCOUNT_NOT_FOUND : COMPOSE_ACCOUNT_REQUIRED,
        }),
      )
      throw new Error(params.accountId ? COMPOSE_ACCOUNT_NOT_FOUND : COMPOSE_ACCOUNT_REQUIRED)
    }
    // Only the agent-facing tool. `composeForApp`'s caller gated at its own surface.
    let guardFooter: { textBody?: string; htmlBody?: string } | undefined
    let guardRecord: Record<string, unknown> | undefined
    if (auditToolName === "mail:compose") {
      const guardCheck = await checkSendGuard(auditToolName, params, params, ctx)
      if (guardCheck.stop) {
        classified = true
        if (guardCheck.refusal) return guardCheck.refusal
        throw new Error(guardCheck.message)
      }
      guardFooter = guardCheck.footer
      guardRecord = guardCheck.record
    }
    // Blueprint Task 9.8, the approval half. A GATED send from an encrypted
    // personal mailbox reaches this handler with its drafted body missing: Phase
    // 6 sealed `kernel.approval_requests.current_payload`, so the plaintext only
    // exists if the mailbox owner's browser supplied it while approving (see
    // `modules/approvals/mailbox-fulfilment.ts`). Sending regardless delivers a
    // blank email and records it as a success, so refuse instead. An UNSEALED
    // mailbox is untouched by this: a deliberately empty body still sends.
    if (
      mailAccountContentSuppressed(account) &&
      !(typeof params.textBody === "string" && params.textBody.length > 0) &&
      !(typeof params.htmlBody === "string" && params.htmlBody.length > 0)
    ) {
      classified = true
      await ctx.approval_recordFailedNoEffect(
        auditToolName,
        JSON.stringify({
          code: "MAILBOX_LOCKED",
          message: "the drafted body was not supplied, so nothing was sent",
        }),
      )
      return {
        error: {
          code: "MAILBOX_LOCKED",
          message:
            "This mailbox is end-to-end encrypted and the drafted message body did not arrive in a readable form, so nothing was sent. Unlock the mailbox and approve again.",
        },
      }
    }
    let attachmentParts: OutboundAttachmentPart[] = []
    let stagedFileIds: string[] = []
    if (Array.isArray(params.attachments) && params.attachments.length > 0) {
      const staged = await stageAndLoadAttachments(
        ctx,
        params.attachments,
        account.id,
        (params as any).__mailboxAttachments ?? null,
      )
      const refusal = refuseOrAskForSealedAttachments(staged)
      if (refusal) {
        classified = true
        await ctx.approval_recordFailedNoEffect(
          auditToolName,
          JSON.stringify({
            code: "MAILBOX_LOCKED",
            message: "a sealed attachment could not be sent, so nothing was sent",
          }),
        )
        return refusal
      }
      attachmentParts = staged.parts
      stagedFileIds = staged.stagedFileIds
    }
    const sendParams = await withEmailBody(
      {
        provider: account.provider,
        accountEmail: account.email_address,
        to: params.to,
        cc: params.cc ?? [],
        bcc: params.bcc ?? [],
        subject: params.subject,
        textBody: guardFooter?.textBody ?? params.textBody,
        htmlBody: guardFooter?.htmlBody ?? params.htmlBody,
        attachments: attachmentParts,
      },
      ctx,
    )
    const result = await sendCompose(sendParams, ctx, {
      onDispatch: () => {
        dispatched = true
      },
    })
    const sentRef = sentMessageRef(sendParams.provider, result)
    await recordSendLanded(ctx, auditToolName, sentRef)
    await persistSentMessage(ctx, account, sendParams, result)
    if (stagedFileIds.length > 0) {
      try {
        await relinkStagedAttachments(ctx, stagedFileIds, result.messageId)
      } catch (err) {
        ctx.log_warn(
          `${auditToolName} attachment relink failed`,
          JSON.stringify({ err: String(err) }),
        )
      }
    }
    await ctx.approval_recordSucceeded(
      auditToolName,
      JSON.stringify({ ...sentRef, ...(guardRecord ?? {}), ...(extraSuccessPayload ?? {}) }),
    )
    return {
      ...result,
      note: `Sent to ${(Array.isArray(params.to) ? params.to : [params.to]).map(sentToLabel).join(", ")} from ${account.email_address}.`,
    }
  } catch (err: any) {
    if (classified) throw err
    const errPayload = {
      code: err?.code ?? "UNKNOWN",
      message: String(err?.message ?? err),
      status: err?.status,
      body: err?.body,
    }
    if (!dispatched || isProviderRejection(err)) {
      await ctx.approval_recordFailedNoEffect(auditToolName, JSON.stringify(errPayload))
    } else {
      await ctx.approval_recordAmbiguous(auditToolName, JSON.stringify(errPayload))
    }
    throw err
  }
}

async function agentMailCompose(params: any, ctx: MailCtx): Promise<any> {
  // Public agent-facing compose. The kernel's executeTool has already enforced
  // the gated-approval flow before we reach this handler (see
  // execute-tool.ts:1561). All real work lives in the shared `_doCompose`
  // helper — keep this function thin so the refactor invariant holds.
  return _doCompose("mail:compose", params, ctx)
}

/**
 * Internal companion tool for cross-app callers (e.g. Invoicing's auto-flow).
 * Same compose pipeline as `agentMailCompose`, but:
 *  - declared `trustBoundary: "internal"`, `agentVisible: false`, and
 *    `deferLoading: true` in the manifest, so the kernel restricts it to
 *    cross-app callers that declared the dependency (see execute-tool.ts:1345),
 *  - skips the per-call approval card (the caller is expected to gate at its
 *    own surface),
 *  - threads `originating_approval_id` into the audit success payload so the
 *    cross-app chain is reconstructible.
 *
 * Cross-app PDF attachments are materialized as Mail-owned copies via the
 * existing `files_attachToParent` bridge inside `stageAndLoadAttachments`
 * (resolves review M2). No additional materialization step is needed.
 */
async function agentMailComposeForApp(params: any, ctx: MailCtx): Promise<any> {
  return _doCompose("mail:composeForApp", params, ctx, {
    originating_approval_id: params?.originating_approval_id ?? null,
  })
}

// ── mail:forward ─────────────────────────────────────────────────────────────
// Forward an existing inbound message to new recipients, faithfully carrying the
// ORIGINAL message's body (quoted under a "Forwarded message" header) AND its
// attachments. This is the first-class "hit Forward" primitive — the agent does
// NOT have to find the attachment file id, re-type the body, or know that
// attachments come from files_list: forward resolves the source message itself,
// lists its kernel.files attachments (the same listMessageAttachments mail:read
// surfaces), and re-attaches them by feeding their ids into the shared compose
// pipeline (`_doCompose` copies each via files_attachToParent — the source keeps
// its copy). GATED: it queues a pending approval (no send) showing the carried
// attachments by filename + origin. Resolves BL: mail had reply + compose but no
// forward, forcing a lossy compose-and-re-attach workaround that a weak agent
// botched (inventing a forward, or composing WITHOUT the PDF).
function formatAddressForQuote(addr: unknown): string {
  if (typeof addr === "string") return addr
  if (addr && typeof addr === "object") {
    const a = addr as { name?: string; email?: string }
    if (a.name && a.email) return `${a.name} <${a.email}>`
    return a.email ?? a.name ?? ""
  }
  return ""
}

function buildForwardedBody(
  note: string | undefined,
  original: {
    from: unknown
    to: unknown[]
    subject: string
    sentAt: string | null
    textBody: string
  },
): string {
  const toArray = Array.isArray(original.to) ? original.to : []
  const toLine = toArray.map(formatAddressForQuote).filter(Boolean).join(", ")
  const headerLines = [
    "---------- Forwarded message ----------",
    `From: ${formatAddressForQuote(original.from)}`,
    original.sentAt ? `Date: ${original.sentAt}` : "",
    `Subject: ${original.subject}`,
    toLine ? `To: ${toLine}` : "",
  ].filter(Boolean)
  const quoted = (original.textBody ?? "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  const lead = note?.trim() ? `${note.trim()}\n\n` : ""
  return `${lead}${headerLines.join("\n")}\n\n${quoted}`
}

async function resolveForwardSource(
  params: { conversationId: string; messageId?: string },
  ctx: MailCtx,
): Promise<
  | { error: { code: string; message: string } }
  | {
      conversation: any
      account: any
      message: any
      attachmentIds: string[]
    }
> {
  const conversation = JSON.parse(await ctx.db_findOne("conversations", params.conversationId))
  if (!conversation?.id) {
    return { error: { code: "NOT_FOUND", message: "Conversation not found or inaccessible" } }
  }
  const account = JSON.parse(await ctx.db_findOne("accounts", conversation.account_id))
  if (!account?.id) {
    return {
      error: { code: "NOT_FOUND", message: "Conversation account not found or inaccessible" },
    }
  }

  let message: any
  if (params.messageId) {
    message = JSON.parse(await ctx.db_findOne("messages", params.messageId))
    if (!message?.id || message.conversation_id !== params.conversationId) {
      return { error: { code: "NOT_FOUND", message: "Message not found in this conversation" } }
    }
  } else {
    // Default: the latest INBOUND message — forwarding a customer's email means
    // re-sending what THEY sent, not our own prior reply.
    const rows = JSON.parse(
      await ctx.db_findMany(
        "messages",
        JSON.stringify({
          where: { conversationId: params.conversationId, direction: "inbound" },
          orderBy: { sentAt: "desc" },
          limit: 1,
        }),
      ),
    )
    message = rows[0]
    if (!message) {
      return {
        error: { code: "NOT_FOUND", message: "No inbound message in this conversation to forward" },
      }
    }
  }

  const attachments = await listMessageAttachments(message.id, ctx)
  return { conversation, account, message, attachmentIds: attachments.map((a) => a.id) }
}

/**
 * The ids a forward attaches: the original message's own attachments, then any
 * extra files the caller passed (a local upload, a Drive import), each once.
 */
function forwardAttachmentIds(originalIds: string[], extra: unknown): string[] {
  const extras = Array.isArray(extra)
    ? extra.filter((id): id is string => typeof id === "string")
    : []
  return [...new Set([...originalIds, ...extras])]
}

async function agentMailForward(params: any, ctx: MailCtx): Promise<any> {
  let resolved: Awaited<ReturnType<typeof resolveForwardSource>>
  try {
    resolved = await resolveForwardSource(params, ctx)
  } catch (e: any) {
    throw new Error(`mail.forward resolveForwardSource threw: ${String(e?.message ?? e)}`)
  }
  if ("error" in resolved) {
    // The source could not be resolved — record a clean failed-no-effect under
    // the forward tool (no send was attempted) so the audit chain is complete,
    // then surface the real reason to the agent (never a bare "execution failed").
    await ctx.approval_recordStarted("mail:forward")
    await ctx.approval_recordFailedNoEffect("mail:forward", JSON.stringify(resolved.error))
    throw new Error(resolved.error.message)
  }
  const { conversation, account, message, attachmentIds } = resolved
  // Blueprint Task 9.8. A forward carries the ORIGINAL message's subject and body,
  // and for a sealed mailbox the server holds neither. Left alone this sends
  // `Fwd: ` with an empty quote and reports success, which is silent data loss
  // wearing the costume of a delivered mail. So: ask for the quote, and if it is
  // not supplied, REFUSE. Sending an empty quote is never an option.
  let suppliedQuote: { quotedBody?: string | null; resolvedSubject?: string | null } | null = null
  if (mailAccountContentSuppressed(account)) {
    suppliedQuote = (params as any).__mailboxQuote?.[message.id] ?? null
    if (!suppliedQuote) {
      return {
        needsPlaintext: {
          requestKind: "mail.quote",
          messageIds: [message.id],
          purpose: "quote the message being forwarded",
        },
        envelope: projectMessageEnvelope(message, []),
        note: "Nothing was sent. This mailbox is end-to-end encrypted, so the quoted original has to come from the user's own browser before the forward can go out.",
      }
    }
    const quoted = suppliedQuote.quotedBody
    const resolvedSubject = suppliedQuote.resolvedSubject
    if (!quoted || !resolvedSubject) {
      await ctx.approval_recordStarted("mail:forward")
      await ctx.approval_recordFailedNoEffect(
        "mail:forward",
        JSON.stringify({
          code: "MAILBOX_LOCKED",
          message: "the quoted original was not supplied, so nothing was sent",
        }),
      )
      return {
        error: {
          code: "MAILBOX_LOCKED",
          message:
            "The mailbox is locked, so the original message could not be quoted. Nothing was sent. Ask the user to unlock their mailbox and try again.",
        },
      }
    }
  }
  let subject: string
  let textBody: string
  try {
    const rawSubject =
      suppliedQuote?.resolvedSubject ?? message.subject ?? conversation.subject ?? ""
    subject = /^fwd:/i.test(rawSubject) ? rawSubject : `Fwd: ${rawSubject}`
    textBody = buildForwardedBody(params.note, {
      from: message.from_address,
      to: message.to_addresses ?? [],
      subject: rawSubject,
      sentAt: message.sent_at ?? null,
      // The client supplies the plaintext; the QUOTING TEMPLATE stays here, in
      // one place, so the two cannot drift apart.
      textBody: suppliedQuote?.quotedBody ?? message.text_body ?? "",
    })
  } catch (e: any) {
    throw new Error(`mail.forward buildForwardedBody threw: ${String(e?.message ?? e)}`)
  }

  // Delegate to the shared compose pipeline so the forward re-uses the exact same
  // send/persist/attach plumbing as compose — the original attachments re-attach
  // because their kernel.files ids are passed through to stageAndLoadAttachments.
  // _doCompose records started/succeeded/failed under the audit name "mail:forward".
  try {
    return await _doCompose(
      "mail:forward",
      {
        accountId: conversation.account_id,
        to: params.to,
        cc: params.cc,
        bcc: params.bcc,
        subject,
        textBody,
        attachments: forwardAttachmentIds(attachmentIds, params.attachments),
      },
      ctx,
    )
  } catch (err: any) {
    // Surface the REAL failure to the transcript/audit — never let it reach the
    // approval-decide path as a bare "not a function"/"Tool execution failed". The
    // precise message (which bridge/step + payload) becomes a field bug report.
    ctx.log_error(
      "mail.forward send failed",
      JSON.stringify({
        message: String(err?.message ?? err),
        code: err?.code,
        attachmentCount: attachmentIds.length,
        to: params.to,
      }),
    )
    throw err
  }
}

async function agentMailForwardPreflight(
  params: { conversationId: string; messageId?: string },
  ctx: MailCtx,
): Promise<any> {
  const resolved = await resolveForwardSource(params, ctx)
  if ("error" in resolved) return { error: resolved.error }
  return { ok: true }
}

async function agentMailComposePreflight(params: any, ctx: MailCtx): Promise<any> {
  // `accountId` is REQUIRED: there is no implicit send-from mailbox, because a silent fallback to the
  // org's shared box sends a user's personal mail from contact@. Refuse at staging with an envelope that
  // tells the agent how to recover (never throw: a bare throw surfaces as "Tool execution failed" and the
  // agent loops). A non-uuid placeholder makes db_findOne throw, so tolerate that as "not found".
  if (!params.accountId) {
    return { error: { code: "invalid_params", message: COMPOSE_ACCOUNT_REQUIRED } }
  }
  let account: { id?: string } | null = null
  try {
    account = JSON.parse(await ctx.db_findOne("accounts", params.accountId))
  } catch {
    account = null
  }
  if (!account?.id) {
    return { error: { code: "NOT_FOUND", message: COMPOSE_ACCOUNT_NOT_FOUND } }
  }

  return pinSendGuard("mail:compose", params, { to: params.to }, ctx)
}

async function verifyGmailPush(
  requestData: { body?: string; query?: Record<string, string>; headers?: Record<string, string> },
  ctx: {
    config_get: (key: string) => Promise<unknown>
    crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
    env_allowInsecurePush?: () => Promise<boolean>
    pubsub_verifyGoogleOidcJwt?: (
      token: string,
      audience: string,
      serviceAccount: string,
    ) => Promise<string>
  },
) {
  try {
    const body =
      typeof requestData.body === "string" ? JSON.parse(requestData.body) : requestData.body
    const messageId = body?.message?.messageId
    if (!messageId) return { valid: false, status: 401, _chaosReason: "missing_messageId" }

    // Spec: real Pub/Sub push must use OIDC verification (issuer, audience,
    // service account, message envelope). When `gmailPushAudience` and
    // `gmailPushServiceAccount` are configured we MUST verify the OIDC JWT
    // off the Authorization header — query-token verification is reserved
    // for explicit local/mock modes that don't have OIDC config.
    const audience = await ctx.config_get("gmailPushAudience")
    const serviceAccount = await ctx.config_get("gmailPushServiceAccount")
    if (
      typeof audience === "string" &&
      audience.length > 0 &&
      typeof serviceAccount === "string" &&
      serviceAccount.length > 0
    ) {
      if (!ctx.pubsub_verifyGoogleOidcJwt) {
        return { valid: false, status: 500, _chaosReason: "oidc_bridge_missing" }
      }
      const auth = requestData.headers?.authorization ?? requestData.headers?.Authorization ?? ""
      const m = /^Bearer\s+(.+)$/i.exec(auth)
      if (!m) return { valid: false, status: 401, _chaosReason: "missing_bearer" }
      const token = m[1]!.trim()
      let verifyRes: { valid: boolean; reason?: string }
      try {
        verifyRes = JSON.parse(
          await ctx.pubsub_verifyGoogleOidcJwt(token, audience, serviceAccount),
        )
      } catch {
        return { valid: false, status: 401, _chaosReason: "oidc_parse_error" }
      }
      if (!verifyRes.valid) {
        return { valid: false, status: 401, _chaosReason: verifyRes.reason ?? "oidc_invalid" }
      }
      return {
        valid: true,
        replayKey: messageId,
        replayTtlSeconds: 86400,
        scopes: ["mail:accounts:read"],
      }
    }

    // Local/mock fallback — only when no OIDC config is set. Query-token
    // verification is acceptable for ad-hoc local runs but NEVER for a real
    // production deploy: a prod deployment that forgets to configure OIDC must
    // fail closed rather than silently accept any caller bearing the shared
    // static token. (Real Pub/Sub push always carries an OIDC bearer.)
    // The fallback is opt-in (ALLOW_INSECURE_PUSH), not "anything that is not
    // production": a self-host started without NODE_ENV would otherwise accept it.
    const allowInsecure = ctx.env_allowInsecurePush ? await ctx.env_allowInsecurePush() : false
    if (!allowInsecure) {
      return { valid: false, status: 401, _chaosReason: "oidc_config_missing" }
    }
    const expectedToken = await ctx.config_get("gmailPushSecret")
    const providedToken = requestData.query?.token
    if (
      !providedToken ||
      typeof expectedToken !== "string" ||
      expectedToken.length === 0 ||
      !(await ctx.crypto_timingSafeEqual(providedToken, expectedToken))
    ) {
      const reason = !providedToken
        ? "missing_token"
        : typeof expectedToken !== "string" || expectedToken.length === 0
          ? "expected_token_unset"
          : "token_mismatch"
      return { valid: false, status: 401, _chaosReason: reason }
    }
    return {
      valid: true,
      replayKey: messageId,
      replayTtlSeconds: 86400,
      scopes: ["mail:accounts:read"],
    }
  } catch {
    return { valid: false, status: 401 }
  }
}

// Per-app data export (Phase 13, E1/E3). Reads conversations under the
// caller's RLS via ctx.db_findMany, so the export never escalates.
const MAIL_EXPORT_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["accountId", "account_id"],
  ["subject", "subject"],
  ["snippet", "snippet"],
  ["status", "status"],
  ["contactId", "contact_id"],
  ["lastMessageAt", "last_message_at"],
  ["createdAt", "created_at"],
]

function mailCsvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value)
  // Spreadsheet formula injection: a leading = + - @ tab or CR makes the cell a formula, so prefix a
  // single quote (plain numbers like "-5000" stay numeric). Verbatim copy of @liaison/shared csvCell.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

async function exportMail(params: unknown, ctx: MailCtx): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>
  const format = p.format ?? "json"
  const dateRange = p.dateRange as { from?: string; to?: string } | undefined
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += 1000) {
    const page: Array<Record<string, unknown>> = JSON.parse(
      await ctx.db_findMany(
        "conversations",
        JSON.stringify({ orderBy: { createdAt: "asc" }, limit: 1000, offset }),
      ),
    )
    rows.push(...page)
    if (page.length < 1000) break
  }
  const fromT = dateRange?.from ? Date.parse(dateRange.from) : Number.NEGATIVE_INFINITY
  const toT = dateRange?.to ? Date.parse(dateRange.to) : Number.POSITIVE_INFINITY
  const ranged =
    dateRange?.from || dateRange?.to
      ? rows.filter((r) => {
          const t = Date.parse(String(r.created_at ?? ""))
          return t >= fromT && t <= toT
        })
      : rows
  // Invariant K, the export surface the earlier draft of this work missed. This
  // is the handler the multi-app Admin Data Export orchestrator invokes, and its
  // declared schema promised plaintext `subject` and `snippet` columns. For an
  // encrypted personal mailbox both are emitted empty, and the manifest's
  // declared schema now says so.
  //
  // Two independent signals, because neither alone is sufficient:
  //
  //   * the ACCOUNT's state, which covers a mailbox that is armed but whose
  //     rows have not been backfilled yet, and
  //   * the ROW's own sealed markers, which cover the case where this export's
  //     actor holds `mail:conversations:read` but not `mail:accounts:read` and
  //     therefore cannot resolve the account at all.
  //
  // An unresolvable account is NOT treated as encrypted on its own: the
  // multi-app export orchestrator is routinely invoked with conversation scope
  // and nothing else, and blanking every subject in that configuration would
  // break the export for org mailboxes that are not in scope for this feature.
  // The row signal is what carries the guarantee in that configuration, and a
  // row holding ciphertext is exactly the row whose plaintext must not ship.
  const encryptedAccounts = new Map<string, boolean | null>()
  const isEncryptedAccount = async (accountId: unknown): Promise<boolean | null> => {
    if (typeof accountId !== "string" || accountId.length === 0) return null
    const cached = encryptedAccounts.get(accountId)
    if (cached !== undefined) return cached
    let encrypted: boolean | null = null
    try {
      const acct: { owner_type?: string; encryption_state?: string } | null = JSON.parse(
        await ctx.db_findOne("accounts", accountId),
      )
      if (acct) encrypted = mailAccountContentSuppressed(acct)
    } catch {
      encrypted = null
    }
    encryptedAccounts.set(accountId, encrypted)
    return encrypted
  }

  /** A conversation row that carries ciphertext is encrypted, whoever owns it. */
  const isSealedRow = (row: Record<string, unknown>): boolean =>
    Number(row.enc_version ?? 0) >= 1 ||
    row.subject_ciphertext != null ||
    row.snippet_ciphertext != null

  const projected: Array<Record<string, string>> = []
  for (const row of ranged) {
    const encrypted = (await isEncryptedAccount(row.account_id)) === true || isSealedRow(row)
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of MAIL_EXPORT_COLUMNS) {
      if (encrypted && (outKey === "subject" || outKey === "snippet")) {
        out[outKey] = ""
        continue
      }
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    projected.push(out)
  }
  if (format === "csv") {
    const header = MAIL_EXPORT_COLUMNS.map(([k]) => k).join(",")
    const body = projected
      .map((r) => MAIL_EXPORT_COLUMNS.map(([k]) => mailCsvCell(r[k])).join(","))
      .join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}
void exportMail
