// SPDX-License-Identifier: FSL-1.1-ALv2
import { IMAP_AUTH_FAILED_PREFIX, imapLoginFailure, normalizeAppPassword } from "@liaison/shared"
import { rootLogger } from "~/lib/logger"
import { validateExternalHost } from "~/modules/apps/sandbox/host-validation"
import {
  appendSentCopy,
  type ImapCapabilities,
  type ImapClientLike,
  type ImapReconcileInput,
  type ImapReconcileResult,
  type ImapWriteBackInput,
  type ImapWriteBackResult,
  probeImapCapabilities,
  reconcileInbox,
  writeBackToImap,
} from "~/modules/apps/sandbox/imap-mailbox"
import { MAIL_HEADER_ALLOWLIST } from "~/modules/mailbox-crypto/header-allowlist"

const log = rootLogger.child({ module: "imap-bridge" })
const IMAP_FETCH_TIMEOUT_MS = 30_000
// Hard cap on a single downloaded message body. IMAP host/port/credentials are
// tenant-controlled, so a malicious or buggy server could stream a multi-GB
// message and exhaust the single-process API. Mirrors the HTTP fetch cap in
// rpc-bridge.ts (readResponseBody). Bodies that exceed the cap are abandoned
// (no body persisted) rather than buffered into host memory.
const IMAP_MAX_BODY_BYTES = 1_000_000
// Hard cap on the aggregate of all downloaded bodies in a single fetch batch.
// batchSize bounds message count but not bytes; this bounds the sum so a batch
// of many near-cap messages cannot still exhaust memory.
const IMAP_MAX_BATCH_BODY_BYTES = 10_000_000
// Bound body-download retries so a permanently un-downloadable ("poison")
// message cannot wedge the sync forever. A transient failure still retries (the
// cursor is held below the failed UID and `done` stays false), but after this
// many consecutive failed attempts for the SAME UID within one sync we treat the
// body as a deterministic drop — push the message with an empty body and let the
// cursor advance past it, exactly like the oversize-body branch. Without this
// bound a single poison UID pins the cursor below it and keeps `done=false` on
// every sync, re-fetching the same window indefinitely.
const IMAP_MAX_BODY_FETCH_ATTEMPTS = 3

export interface RawEmailAttachment {
  filename: string
  mimeType: string
  sizeBytes: number
  /** Raw bytes base64-encoded. Present when the attachment fit within the per-message byte cap. */
  bytesBase64: string
  disposition: "inline" | "attachment"
  /** Content-ID stripped of angle brackets, for inline parts referenced via `cid:`. */
  contentId?: string
  /** Original Content-ID value including angle brackets. */
  originalContentId?: string
}

export interface RawEmailMessage {
  externalMessageId: string
  externalProviderId: string
  externalThreadId: string
  from: { name?: string; email: string }
  to: Array<{ name?: string; email: string }>
  cc: Array<{ name?: string; email: string }>
  bcc: Array<{ name?: string; email: string }>
  subject: string
  textBody: string
  htmlBody: string
  snippet: string
  headers: Record<string, string>
  inReplyTo: string | null
  references: string[]
  labels: string[]
  isRead: boolean
  isStarred: boolean
  sentAt: string
  /** Attachments extracted from the MIME body. Absent when the body was oversized and dropped. */
  attachments?: RawEmailAttachment[]
}

/**
 * Read an IMAP body stream into a single Buffer, enforcing a hard per-message
 * byte cap and a running aggregate cap across the batch. Returns the buffer on
 * success, or `null` when either cap is exceeded — in which case the stream is
 * destroyed and the body is dropped rather than buffered.
 */
export async function readImapBody(
  content: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  opts: { maxBodyBytes: number; remainingBatchBytes: number },
): Promise<{ buffer: Buffer | null; bytesRead: number }> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of content) {
    const buf = Buffer.from(chunk)
    totalBytes += buf.byteLength
    if (totalBytes > opts.maxBodyBytes || totalBytes > opts.remainingBatchBytes) {
      // Stop reading and discard — do not concat oversized buffers.
      try {
        content.destroy?.(new Error("imap_body_too_large"))
      } catch {
        /* stream may not support destroy */
      }
      return { buffer: null, bytesRead: totalBytes }
    }
    chunks.push(buf)
  }
  return { buffer: Buffer.concat(chunks), bytesRead: totalBytes }
}

/**
 * Compute the next IMAP UID cursor without skipping any message.
 *
 * Servers are not required to return UIDs in ascending order within a range,
 * and a body-download failure must not consume its UID (it has to be retried
 * on the next sync). So the cursor advances to the largest UID we are certain
 * was fully processed AND that sits below any failed UID. If a failure occurs
 * at or below every success, the cursor does not advance past it.
 *
 * @param startCursor       the incoming cursor (0 for a full/initial walk)
 * @param maxSuccessfulUid  the highest UID whose body was processed (0 if none)
 * @param minFailedUid      the lowest UID whose body fetch failed (+Infinity if none)
 */
export function computeNextImapCursor(
  startCursor: number,
  maxSuccessfulUid: number,
  minFailedUid: number,
): number {
  if (maxSuccessfulUid > 0 && maxSuccessfulUid < minFailedUid) {
    return maxSuccessfulUid
  }
  if (minFailedUid !== Number.POSITIVE_INFINITY) {
    return Math.max(startCursor, minFailedUid - 1)
  }
  return Math.max(startCursor, maxSuccessfulUid)
}

export function deriveExternalThreadId(
  references: string | undefined,
  inReplyTo: string | undefined,
  ownMessageId: string,
): string {
  if (references && references.trim().length > 0) {
    const refs = references.trim().split(/\s+/)
    if (refs.length > 0 && refs[0].length > 0) return refs[0]
  }
  if (inReplyTo && inReplyTo.trim().length > 0) return inReplyTo.trim()
  return ownMessageId
}

/** Which folder a message was read from: the INBOX, or the Sent folder. */
export type ImapFolderRole = "inbox" | "sent"

function mapImapFlags(flags: Set<string>, folder: ImapFolderRole): string[] {
  const labels: string[] = []
  if (!flags.has("\\Seen")) labels.push("UNREAD")
  if (flags.has("\\Flagged")) labels.push("STARRED")
  if (flags.has("\\Answered")) labels.push("ANSWERED")
  if (flags.has("\\Draft")) labels.push("DRAFT")
  labels.push(folder === "sent" ? "SENT" : "INBOX")
  return labels
}

/**
 * The provider id of an IMAP message: its UID, prefixed for the Sent folder
 * (UIDs are per folder, so INBOX 5 and Sent 5 are different messages).
 */
export function imapProviderId(uid: number | string, folder: ImapFolderRole): string {
  return folder === "sent" ? `sent:${uid}` : String(uid)
}

/**
 * The headers a message's classification reads: the mailbox header allowlist, and
 * the auto-reply markers an ordinary mailbox keeps. A sealed mailbox's write seals
 * anything not on the allowlist, as for every provider.
 */
const IMAP_INGEST_HEADERS = [
  ...MAIL_HEADER_ALLOWLIST,
  "x-autoreply",
  "x-autorespond",
  "x-auto-response-suppress",
] as const

/**
 * A `HEADER.FIELDS` fetch answers one raw block: unfold it into a lowercased map.
 * A header given twice joins with a comma, as RFC 5322 reads a repeated field.
 */
export function parseImapHeaders(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) return {}
  const text =
    raw instanceof Uint8Array
      ? Buffer.from(raw).toString("utf8")
      : typeof raw === "string"
        ? raw
        : null
  if (text === null) return typeof raw === "object" ? (raw as Record<string, string>) : {}
  const out: Record<string, string> = {}
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`
  }
  return out
}

export function normalizeImapMessage(
  msg: any,
  uidValidity: number,
  folder: ImapFolderRole = "inbox",
): RawEmailMessage {
  const envelope = msg.envelope ?? {}
  // A message with no Message-ID gets one unique to its folder and UID
  // generation: INBOX 5, Sent 5 and INBOX 5 after a UIDVALIDITY reset are
  // different messages, and the import dedupes by this id.
  const messageId =
    envelope.messageId ?? `<unknown-${folder === "sent" ? "sent-" : ""}${uidValidity}-${msg.uid}>`
  const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags ?? [])

  const mapAddress = (address: any) => ({
    name: address?.name || undefined,
    email: (address?.address ?? address?.email ?? "").toLowerCase(),
  })

  const references = envelope.references as string | undefined
  const inReplyTo = envelope.inReplyTo as string | undefined
  const textBody = msg.textBody ?? ""

  const rawAttachments: RawEmailAttachment[] | undefined = Array.isArray(msg.attachments)
    ? (msg.attachments as RawEmailAttachment[])
    : undefined

  return {
    externalMessageId: messageId,
    externalProviderId: imapProviderId(msg.uid, folder),
    externalThreadId: deriveExternalThreadId(references, inReplyTo, messageId),
    from: mapAddress(envelope.from?.[0] ?? {}),
    to: (envelope.to ?? []).map(mapAddress),
    cc: (envelope.cc ?? []).map(mapAddress),
    bcc: (envelope.bcc ?? []).map(mapAddress),
    subject: envelope.subject ?? "",
    textBody,
    htmlBody: msg.htmlBody ?? "",
    snippet: textBody.slice(0, 200),
    headers: parseImapHeaders(msg.headers),
    inReplyTo: inReplyTo ?? null,
    references: references ? references.trim().split(/\s+/).filter(Boolean) : [],
    labels: mapImapFlags(flags, folder),
    isRead: flags.has("\\Seen"),
    isStarred: flags.has("\\Flagged"),
    sentAt: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
    attachments: rawAttachments,
  }
}

/**
 * Per-attachment byte cap for IMAP ingest. mailparser decodes all attachment
 * bytes eagerly from the RFC 2822 body buffer; we accept each decoded
 * attachment only when it fits within this limit, to avoid loading multi-MB
 * files into the QuickJS sandbox via the bridge. Attachments exceeding the cap
 * are silently dropped (metadata is not recorded either, since we have no
 * providerAttachmentId for IMAP unlike Gmail which supplies one).
 */
const IMAP_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * Extract attachments from a mailparser-parsed message. Only non-body parts
 * with a filename are included. Attachments whose decoded bytes exceed
 * `IMAP_MAX_ATTACHMENT_BYTES` are dropped to bound memory usage.
 */
export function extractImapAttachments(parsed: {
  attachments?: Array<{
    filename?: string
    contentType?: string
    size?: number
    content?: Buffer | Uint8Array
    contentDisposition?: string
    cid?: string
    contentId?: string
  }>
}): RawEmailAttachment[] {
  const result: RawEmailAttachment[] = []
  for (const att of parsed.attachments ?? []) {
    if (!att.filename) continue
    const bytes = Buffer.isBuffer(att.content)
      ? att.content
      : att.content
        ? Buffer.from(att.content)
        : Buffer.alloc(0)
    if (bytes.byteLength > IMAP_MAX_ATTACHMENT_BYTES) continue
    const rawCid = att.contentId ?? (att.cid ? `<${att.cid}>` : undefined)
    const disposition: "inline" | "attachment" =
      att.contentDisposition === "inline" || (Boolean(att.cid) && !att.contentDisposition)
        ? "inline"
        : "attachment"
    result.push({
      filename: att.filename,
      mimeType: att.contentType || "application/octet-stream",
      sizeBytes: typeof att.size === "number" ? att.size : bytes.byteLength,
      bytesBase64: bytes.toString("base64"),
      disposition,
      contentId: att.cid ? att.cid.replace(/^<|>$/g, "") : undefined,
      originalContentId: rawCid,
    })
  }
  return result
}

export type ImapCredentials = { host: string; port: number; username: string; password: string }

/**
 * A refused or failed sign-in as the error the sync stores: a refusal names its
 * code from the closed set (`IMAP authentication failed: app_password_required`),
 * too many connections is its own transient error, the rest keep their cause.
 */
export function imapConnectError(err: {
  message?: string
  responseText?: string
  response?: string
  serverResponseCode?: string
  responseCode?: string
  authenticationFailed?: boolean
}): Error {
  const text = [err.message, err.responseText, err.response].filter(Boolean).join(" ")
  const code = err.serverResponseCode ?? err.responseCode ?? null
  const failure = imapLoginFailure(text, code)
  if (failure === "too_many_connections") return new Error("IMAP too many connections")
  if (failure) return new Error(`${IMAP_AUTH_FAILED_PREFIX}: ${failure}`)
  if (err.authenticationFailed || /\bauth/i.test(err.message ?? "")) {
    return new Error(`${IMAP_AUTH_FAILED_PREFIX}: wrong_password`)
  }
  if (err.message?.includes("timeout")) return new Error("IMAP timeout")
  return new Error(`IMAP connection refused: ${err.message}`)
}

/**
 * The 'error' event of an ImapFlow client: logged, the client closed. ImapFlow
 * emits it when a connection cannot be recovered (a socket timeout on a slow or
 * stalled server, a reset); the close rejects whatever operation was waiting on
 * it, so the sync fails and is retried. Without a listener Node throws the
 * event as an uncaught exception, which ends the whole API process.
 */
export function attachImapErrorHandler(client: {
  on(event: "error", listener: (err: Error) => void): unknown
  close(): void
}): void {
  client.on("error", (err: Error) => {
    log.warn(
      { err: err?.message, code: (err as { code?: string })?.code },
      "IMAP connection error; closing the connection",
    )
    try {
      client.close()
    } catch {
      /* already closed */
    }
  })
}

/**
 * Connect and sign in, with a bounded timeout. On any failure (including the
 * timeout winning the race) the half-open client and the timer are cleaned up,
 * otherwise repeated failing syncs leak sockets/FDs and timers.
 */
export async function openImapClient(
  credentials: ImapCredentials,
  connectTimeoutMs: number = IMAP_FETCH_TIMEOUT_MS,
) {
  const validatedHost = await validateExternalHost(credentials.host, "IMAP")

  const { ImapFlow } = await import("imapflow")
  const secure = credentials.port === 993
  const client = new ImapFlow({
    host: validatedHost.address,
    port: credentials.port,
    // An app password pasted as Google shows it, in groups of four, signs in without its spaces.
    auth: { user: credentials.username, pass: normalizeAppPassword(credentials.password) },
    secure,
    doSTARTTLS: !secure,
    tls: validatedHost.servername
      ? { servername: validatedHost.servername, minVersion: "TLSv1.2" }
      : { minVersion: "TLSv1.2" },
    logger: false,
    emitLogs: false,
  })
  // Before connect(): an error emitted at any point must never be uncaught.
  attachImapErrorHandler(client)

  let connectTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error("IMAP connection timeout")),
          connectTimeoutMs,
        )
      }),
    ])
  } catch (err: any) {
    // Force-close the client; connect() may still be in flight or half-open.
    try {
      client.close()
    } catch {
      /* already closed */
    }
    throw imapConnectError(err)
  } finally {
    if (connectTimer) clearTimeout(connectTimer)
  }
  return client
}

/**
 * Whether the stored login opens the mailbox: a sign-in, then a logout. Throws
 * the same errors as a sync's connect. Proves the connection controls the
 * account (a credentials save does not check the password).
 */
export async function imapVerifyLogin(credentials: ImapCredentials): Promise<void> {
  const client = await openImapClient(credentials)
  await client.logout().catch(() => {})
}

/**
 * One page of a sync stops starting new messages after this long, and returns
 * what it has: the job that called it has a 60 s budget for the whole run (the
 * page's writes included), and a slow server or a few large messages must not
 * spend it. The rest is the next page's.
 */
export const IMAP_PAGE_SOFT_BUDGET_MS = 20_000
/**
 * Hard bound on one bridge call, connect included: past it the connection is
 * closed (which fails the call) instead of holding the job beyond its budget.
 */
export const IMAP_CALL_HARD_TIMEOUT_MS = 45_000
/** Bytes asked per round trip: a message under the body cap comes in one. */
const IMAP_DOWNLOAD_CHUNK_BYTES = IMAP_MAX_BODY_BYTES + 1
/** Cap on each text part read from a message too large to download whole. */
const IMAP_MAX_TEXT_PART_BYTES = 256 * 1024

/** The parts of an ImapFlow client a sync page uses. */
export interface ImapFetchClient extends ImapClientLike {
  /** False once the connection is closed (ImapFlow). */
  usable?: boolean
  download(
    range: string,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number; chunkSize?: number },
  ): Promise<{
    content?: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }
  }>
}

export interface ImapFetchOptions {
  mode: "full" | "incremental"
  cursor?: string
  batchSize: number
  mailbox?: string
  /** Which folder: the INBOX (default) or the server's Sent folder (SPECIAL-USE). */
  folder?: ImapFolderRole
  /** Also read back the INBOX state (flags, membership) the last sync saw. */
  reconcile?: ImapReconcileInput
  /**
   * "newest": walk the folder from its newest message down (a first import),
   * one page of UIDs below `before` per call. Without it, a page is the oldest
   * UIDs above `cursor` (new mail since the last sync).
   */
  order?: "newest"
  /** Newest-first walk: only UIDs below this (null: from the top). */
  before?: string
  /**
   * Newest-first walk: only UIDs above this (a catch-up: new mail above the
   * cursor, or a gap left by an earlier catch-up). Null: down to the bottom.
   */
  above?: string
}

export interface ImapFetchResult {
  messages: RawEmailMessage[]
  /** Where the next page starts; null when the range is drained. */
  nextCursor: string | null
  /**
   * The highest UID processed so far (no UID below it is left behind), also
   * when the range is drained: where the next incremental sync starts. Null
   * when nothing was processed and no cursor came in. On the first page of a
   * newest-first walk: the folder's highest UID (`highest`).
   */
  cursor: string | null
  done: boolean
  uidValidity: number
  /** What the server supports (special folders, Gmail, IDLE, CONDSTORE). */
  capabilities: ImapCapabilities
  /** The folder asked for does not exist on this server (no Sent folder). */
  noFolder?: boolean
  /** The INBOX state, when `reconcile` was asked for. */
  reconcile?: ImapReconcileResult
  /** Newest-first walk: the next page's `before`; null when the walk is done. */
  nextBefore?: string | null
  /**
   * Newest-first walk, first page: the folder's highest UID when the walk
   * started (null for an empty folder). Mail above it is the incremental
   * sync's, so the walk and the incremental sync never miss a UID between them.
   */
  highest?: string | null
}

/** The UIDs a SEARCH found, ascending (ImapFlow answers false on a failed search). */
async function searchUids(
  client: ImapFetchClient,
  query: Record<string, unknown>,
): Promise<number[]> {
  const found = await client.search(query, { uid: true })
  if (!Array.isArray(found)) return []
  return (found as unknown[])
    .map((u) => Number(u))
    .filter((u) => Number.isInteger(u) && u > 0)
    .sort((a, b) => a - b)
}

interface BodyStructureNode {
  part?: string
  type?: string
  disposition?: string
  childNodes?: BodyStructureNode[]
}

/**
 * The text parts of a message, by IMAP part number, from its BODYSTRUCTURE:
 * the first text/plain and text/html that are not attachments. A single-part
 * message has no part number; its body is part "1".
 */
export function findImapTextParts(node: BodyStructureNode | undefined | null): {
  plain?: string
  html?: string
} {
  const out: { plain?: string; html?: string } = {}
  const visit = (n: BodyStructureNode | undefined | null) => {
    if (!n) return
    if (Array.isArray(n.childNodes) && n.childNodes.length > 0) {
      for (const child of n.childNodes) visit(child)
      return
    }
    if (String(n.disposition ?? "").toLowerCase() === "attachment") return
    const type = String(n.type ?? "").toLowerCase()
    const part = n.part ?? "1"
    if (type === "text/plain" && !out.plain) out.plain = part
    if (type === "text/html" && !out.html) out.html = part
  }
  visit(node)
  return out
}

async function readText(
  content: AsyncIterable<Uint8Array> | undefined,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  if (!content) return { text: "", bytes: 0 }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of content) {
    const buf = Buffer.from(chunk)
    bytes += buf.byteLength
    chunks.push(buf)
    if (bytes >= maxBytes) break
  }
  return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), bytes }
}

interface ImapBody {
  textBody: string
  htmlBody: string
  attachments?: RawEmailAttachment[]
  bytes: number
}

/**
 * The body of a message too large to download whole: its text parts only,
 * each capped, attachments left on the server. Two bounded round trips instead
 * of the whole message (a 25 MB attachment took 85 s from Gmail).
 */
async function downloadTextParts(
  client: ImapFetchClient,
  uid: number,
  bodyStructure: BodyStructureNode | undefined,
): Promise<ImapBody> {
  const parts = findImapTextParts(bodyStructure)
  const body: ImapBody = { textBody: "", htmlBody: "", bytes: 0 }
  for (const [key, part] of [
    ["textBody", parts.plain],
    ["htmlBody", parts.html],
  ] as const) {
    if (!part) continue
    const res = await client.download(String(uid), part, {
      uid: true,
      maxBytes: IMAP_MAX_TEXT_PART_BYTES,
      chunkSize: IMAP_MAX_TEXT_PART_BYTES,
    })
    const { text, bytes } = await readText(res?.content, IMAP_MAX_TEXT_PART_BYTES)
    body[key] = text
    body.bytes += bytes
  }
  return body
}

/** A whole message under the cap, parsed; null when it turns out larger. */
async function downloadWholeMessage(
  client: ImapFetchClient,
  uid: number,
  remainingBatchBytes: number,
): Promise<ImapBody | null> {
  const res = await client.download(String(uid), undefined, {
    uid: true,
    maxBytes: IMAP_MAX_BODY_BYTES + 1,
    chunkSize: IMAP_DOWNLOAD_CHUNK_BYTES,
  })
  // A message the server no longer has resolves to `{}` (no content).
  if (!res?.content) return { textBody: "", htmlBody: "", bytes: 0 }
  const { buffer, bytesRead } = await readImapBody(res.content, {
    maxBodyBytes: IMAP_MAX_BODY_BYTES,
    remainingBatchBytes,
  })
  if (buffer === null) return null
  const { simpleParser } = await import("mailparser")
  const parsed = await simpleParser(buffer)
  const attachments = extractImapAttachments(parsed)
  return {
    textBody: parsed.text ?? "",
    htmlBody: typeof parsed.html === "string" ? parsed.html : "",
    ...(attachments.length > 0 ? { attachments } : {}),
    bytes: bytesRead,
  }
}

/**
 * One page of a folder, on an open client. Bounded whatever the folder's size:
 * the UIDs of the page are chosen by a SEARCH (never a FETCH over 1:*), their
 * envelopes read in one FETCH that completes before any body is downloaded
 * (ImapFlow runs one command at a time: a download issued inside a FETCH loop
 * waits for that FETCH forever), a message larger than the body cap is read as
 * its text parts only, and the page stops starting new messages once
 * `softBudgetMs` has passed or the batch's bytes are spent. The folder is
 * opened read-only (EXAMINE): a sync never changes the mailbox.
 */
export async function fetchImapPage(
  client: ImapFetchClient,
  opts: ImapFetchOptions,
  budget: { softBudgetMs?: number; now?: () => number; capabilities?: ImapCapabilities } = {},
): Promise<ImapFetchResult> {
  const now = budget.now ?? Date.now
  const softBudgetMs = budget.softBudgetMs ?? IMAP_PAGE_SOFT_BUDGET_MS
  const started = now()
  const folder: ImapFolderRole = opts.folder ?? "inbox"
  const capabilities = budget.capabilities ?? (await probeImapCapabilities(client))
  const path = folder === "sent" ? capabilities.folders.sent : (opts.mailbox ?? "INBOX")
  if (!path) {
    return {
      messages: [],
      nextCursor: null,
      cursor: opts.cursor ?? null,
      done: true,
      uidValidity: 0,
      capabilities,
      noFolder: true,
      ...(opts.order === "newest" ? { nextBefore: null, highest: null } : {}),
    }
  }
  const lock = await client.getMailboxLock(path, { readOnly: true })
  try {
    const mailbox = client.mailbox as { uidValidity?: bigint | number } | undefined
    const uidValidity = Number(mailbox?.uidValidity ?? 0)
    const newest = opts.order === "newest"
    const startCursor = opts.cursor ? Number(opts.cursor) : 0
    const before = opts.before ? Number(opts.before) : null
    const above = opts.above ? Number(opts.above) : 0

    // The page's UIDs, in the order they are processed.
    let candidates: number[] = []
    let leftAfterPage = 0
    let highest: number | null = null
    if (newest) {
      // `n:*` also matches the highest UID when n is above it: filtered out.
      const range = before === null ? `${above + 1}:*` : `${above + 1}:${before - 1}`
      const below =
        before !== null && before - 1 <= above
          ? []
          : (
              await searchUids(
                client,
                above === 0 && before === null ? { all: true } : { uid: range },
              )
            ).filter((u) => u > above && (before === null || u < before))
      if (before === null) highest = below.length > 0 ? below[below.length - 1] : null
      candidates = below.slice(-opts.batchSize).reverse()
      leftAfterPage = below.length - candidates.length
    } else {
      // `n:*` also matches the highest UID when n is above it: filtered out.
      const above = (await searchUids(client, { uid: `${startCursor + 1}:*` })).filter(
        (u) => u > startCursor,
      )
      candidates = above.slice(0, opts.batchSize)
      leftAfterPage = above.length - candidates.length
    }

    // Envelopes first, in ONE command run to its end; bodies after.
    const rows = new Map<number, any>()
    if (candidates.length > 0) {
      for await (const row of client.fetch(
        candidates,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          size: true,
          headers: [...IMAP_INGEST_HEADERS],
        },
        { uid: true },
      )) {
        rows.set(Number(row.uid), row)
      }
    }

    const messages: RawEmailMessage[] = []
    let processed = 0
    // Ascending pages: the highest UID done; newest-first: the lowest.
    let lastDone = 0
    let batchBodyBytes = 0
    for (const uid of candidates) {
      if (processed > 0 && now() - started >= softBudgetMs) break
      const row = rows.get(uid)
      if (!row) {
        // Expunged between the SEARCH and the FETCH: nothing to import.
        processed++
        lastDone = uid
        continue
      }
      const size = Number(row.size ?? 0)
      const whole = size <= IMAP_MAX_BODY_BYTES
      const expected = whole ? size : IMAP_MAX_TEXT_PART_BYTES * 2
      // The batch's bytes are spent: this message is the next page's.
      if (processed > 0 && expected > IMAP_MAX_BATCH_BODY_BYTES - batchBodyBytes) break

      let body: ImapBody = { textBody: "", htmlBody: "", bytes: 0 }
      let lostConnection = false
      for (let attempt = 1; attempt <= IMAP_MAX_BODY_FETCH_ATTEMPTS; attempt++) {
        try {
          const full = whole
            ? await downloadWholeMessage(client, uid, IMAP_MAX_BATCH_BODY_BYTES - batchBodyBytes)
            : null
          if (full === null) {
            log.info({ uid, size }, "IMAP message over the body cap: reading its text parts only")
          }
          body = full ?? (await downloadTextParts(client, uid, row.bodyStructure))
          break
        } catch (err) {
          if (client.usable === false) {
            // The connection is gone: no retry can pass on it. The page ends
            // here; this message is the next page's.
            lostConnection = true
            log.warn({ uid, err: (err as Error)?.message }, "IMAP connection lost during a page")
            break
          }
          if (attempt < IMAP_MAX_BODY_FETCH_ATTEMPTS) {
            log.warn(
              { uid, attempt, maxAttempts: IMAP_MAX_BODY_FETCH_ATTEMPTS },
              "Failed to fetch IMAP message body — retrying",
            )
            continue
          }
          // A message whose body fails every attempt is imported without it, so
          // one un-downloadable UID cannot stall the mailbox's sync forever.
          log.warn(
            { uid, attempts: IMAP_MAX_BODY_FETCH_ATTEMPTS },
            "Failed to fetch IMAP message body after max attempts — dropping body to avoid sync stall",
          )
        }
      }
      if (lostConnection) {
        if (processed === 0) throw new Error("IMAP connection lost")
        break
      }
      batchBodyBytes += body.bytes
      messages.push(
        normalizeImapMessage(
          {
            ...row,
            uid,
            textBody: body.textBody,
            htmlBody: body.htmlBody,
            attachments: body.attachments,
          },
          uidValidity,
          folder,
        ),
      )
      processed++
      lastDone = uid
    }

    const pageDone = processed === candidates.length && leftAfterPage === 0

    // The INBOX read-back runs after the new mail: only UIDs at or below the
    // previous cursor are compared, the new ones are this page's.
    let reconcile: ImapReconcileResult | undefined
    if (opts.reconcile && folder === "inbox") {
      try {
        reconcile = await reconcileInbox(
          client,
          { ...opts.reconcile, cursor: opts.cursor ?? null },
          capabilities,
        )
      } catch (err) {
        log.warn({ err: (err as Error).message }, "IMAP INBOX read-back failed; retried next sync")
      }
    }

    if (newest) {
      return {
        messages,
        nextCursor: null,
        cursor: highest !== null ? String(highest) : (opts.cursor ?? null),
        done: pageDone,
        uidValidity,
        capabilities,
        nextBefore: pageDone ? null : String(processed > 0 ? lastDone : (before ?? 0)),
        ...(before === null ? { highest: highest !== null ? String(highest) : null } : {}),
        ...(reconcile ? { reconcile } : {}),
      }
    }

    const nextCursorNum = computeNextImapCursor(
      startCursor,
      processed > 0 ? lastDone : 0,
      Number.POSITIVE_INFINITY,
    )
    return {
      messages,
      nextCursor: pageDone ? null : String(nextCursorNum),
      cursor: nextCursorNum > 0 ? String(nextCursorNum) : null,
      done: pageDone,
      uidValidity,
      capabilities,
      ...(reconcile ? { reconcile } : {}),
    }
  } finally {
    lock.release()
  }
}

type ImapClientOpener = (
  credentials: ImapCredentials,
  connectTimeoutMs: number,
) => Promise<ImapClientLike & { logout(): Promise<unknown>; close(): void }>

let testOpener: ImapClientOpener | null = null

/**
 * Test access: open a fake server's client instead of a network connection,
 * so a test drives the whole path (the bridge's option parsing, `imapFetch`,
 * the page) to a fake server. Production code never calls it.
 */
export const ImapBridgeTestAccess = {
  setOpener(fn: ImapClientOpener | null): void {
    testOpener = fn
  },
}

/** One page of a folder (`fetchImapPage`), on its own connection, under the call's hard bound. */
export async function imapFetch(
  credentials: ImapCredentials,
  opts: ImapFetchOptions,
): Promise<ImapFetchResult> {
  return withImapClient(
    credentials,
    (client, capabilities) => fetchImapPage(client as ImapFetchClient, opts, { capabilities }),
    IMAP_CALL_HARD_TIMEOUT_MS,
    testOpener ?? openImapClient,
  )
}

/** Bound on one write-back or Sent copy, connect included. */
const IMAP_OPERATION_TIMEOUT_MS = 40_000

/**
 * Run `fn` on a fresh connection, within `timeoutMs` from the start of the
 * connect. At the bound the connection is CLOSED, not logged out: a LOGOUT
 * would queue behind the stalled command and wait as long as it does.
 */
export async function withImapClient<T>(
  credentials: ImapCredentials,
  fn: (client: ImapClientLike, capabilities: ImapCapabilities) => Promise<T>,
  timeoutMs: number = IMAP_OPERATION_TIMEOUT_MS,
  open: (
    credentials: ImapCredentials,
    connectTimeoutMs: number,
  ) => Promise<ImapClientLike & { logout(): Promise<unknown>; close(): void }> = openImapClient,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  const client = await open(credentials, Math.min(IMAP_FETCH_TIMEOUT_MS, timeoutMs))
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const like = client as ImapClientLike
    const work = (async () => fn(like, await probeImapCapabilities(like)))()
    // The work's own rejection after a timeout is expected and handled here.
    work.catch(() => {})
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true
            try {
              client.close()
            } catch {
              /* already closed */
            }
            reject(new Error("IMAP timeout"))
          },
          Math.max(0, deadline - Date.now()),
        )
      }),
    ])
  } catch (err) {
    const e = err as { message?: string; responseStatus?: string; responseText?: string }
    // The server answered NO / BAD to a command: retrying the same command fails the same way.
    if (e.responseStatus === "NO" || e.responseStatus === "BAD") {
      throw new Error(`IMAP rejected: ${e.responseText ?? e.message}`)
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    if (!timedOut) await client.logout().catch(() => {})
  }
}

/** One item's outcome in a write-back batch: done, or refused by the server. */
export type ImapWriteBackItemResult = ImapWriteBackResult | { error: string }

/**
 * Write several conversations' state in Liaison back to the server
 * (imap-mailbox.ts), in ONE session: a bulk archive must not log in once per
 * conversation (slow, and providers throttle repeated logins). A command the
 * server refuses (NO / BAD) fails only its own item; a lost connection or a
 * timeout fails the whole batch, which the job retries (the writes are
 * idempotent).
 */
export async function imapWriteBack(
  credentials: ImapCredentials,
  items: ImapWriteBackInput[],
): Promise<{ results: ImapWriteBackItemResult[]; capabilities: ImapCapabilities }> {
  return withImapClient(credentials, async (client, capabilities) => {
    const results: ImapWriteBackItemResult[] = []
    for (const item of items) {
      try {
        results.push(await writeBackToImap(client, capabilities, item))
      } catch (err) {
        const e = err as { message?: string; responseStatus?: string; responseText?: string }
        if (e.responseStatus !== "NO" && e.responseStatus !== "BAD") throw err
        results.push({ error: `IMAP rejected: ${e.responseText ?? e.message}` })
      }
    }
    return { results, capabilities }
  })
}

/** File a copy of a message sent over SMTP in Sent, unless the server does it. */
export async function imapAppendSent(
  credentials: ImapCredentials,
  raw: Buffer,
  messageId: string,
): Promise<string> {
  return withImapClient(credentials, (client, capabilities) =>
    appendSentCopy(client, capabilities, raw, messageId),
  )
}

// E2E IMAP fixture: when TICKETS_E2E_IMAP_FAKE=redis is set, the ticket sync
// fetcher reads parsed messages from Redis instead of opening a real IMAP
// connection. The test harness stages messages under the worker's own
// REDIS_PREFIX so cross-process tests can drive inbound matching without
// running a localhost IMAP server.
export async function fetchFromImapFixture(
  accountEmail: string,
  opts: { mode: "incremental" | "initial"; cursor?: string },
): Promise<{
  messages: Array<{
    messageId?: string
    subject?: string
    from?: { email: string; name?: string }
    to?: Array<{ email: string; name?: string }>
    cc?: Array<{ email: string; name?: string }>
    textBody?: string
    htmlBody?: string
    inReplyTo?: string
    references?: string[]
    sentAt?: string
    headers?: Record<string, string | string[]>
  }>
  cursor?: string
  uidValidity?: string
}> {
  if (process.env.TICKETS_E2E_IMAP_FAKE !== "redis") {
    return { messages: [], cursor: opts.cursor }
  }
  // ioredis is configured with keyPrefix=REDIS_PREFIX, so command keys here are
  // automatically prefixed. The test harness uses an unprefixed ioredis client
  // and prepends env.redisPrefix manually; both end up at the same Redis key.
  const { redis } = await import("~/lib/redis")
  const { rootLogger } = await import("~/lib/logger")
  const log = rootLogger.child({ module: "imap-fixture" })
  const lower = accountEmail.toLowerCase()
  const queueKey = `tickets:imap-fixture:${lower}:queue`
  const uidValidityKey = `tickets:imap-fixture:${lower}:uidValidity`
  const cursorKey = `tickets:imap-fixture:${lower}:cursor`
  log.info({ accountEmail, queueKey }, "fetchFromImapFixture invoked")

  const raws = await redis.lrange(queueKey, 0, -1)
  log.info({ queueKey, count: raws.length }, "fetchFromImapFixture queue read")
  if (raws.length > 0) {
    await redis.del(queueKey)
  }
  const messages = raws
    .map((raw) => {
      try {
        return JSON.parse(raw) as Awaited<
          ReturnType<typeof fetchFromImapFixture>
        >["messages"][number]
      } catch {
        return null
      }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)

  const uidValidity = (await redis.get(uidValidityKey)) ?? undefined
  let cursor: string | undefined
  if (messages.length > 0) {
    cursor = String(Date.now())
    await redis.set(cursorKey, cursor, "EX", 3600)
  } else {
    cursor = (await redis.get(cursorKey)) ?? undefined
  }

  return { messages, cursor, uidValidity }
}
