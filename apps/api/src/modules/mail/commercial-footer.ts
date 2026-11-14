// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a commercial mail carries at the moment it leaves, added after the send
 * check so nothing here reaches an approver's payload: the organization's legal
 * name and postal address, an opt-out link, "or reply stop", and the
 * `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058) built from
 * the same link.
 *
 * The identity lives in `organizations.settings.commercialIdentity`, written by
 * `config apply` (`email.commercialIdentity`) or the organization settings page.
 * Without a legal name and a postal address no commercial mail stages or sends.
 *
 * One link per send: `mintOptOutLink` stores the sha256 of a 32 byte random
 * token beside the fingerprint of the recipient's address (never the address),
 * and the org comes from that row when the link is opened. Links older than
 * three years are pruned daily.
 */
import { createHash, randomBytes } from "node:crypto"
import {
  type CommercialIdentity,
  commercialIdentitySchema,
  resolveLocale,
  type ShippedLocale,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb, withSystemReadReusingHeld } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { escapeHtml } from "~/lib/html-page"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { serverT } from "~/modules/i18n/server-i18n"
import { OPT_OUT_PATH } from "~/modules/mail/opt-out-path"
import { type DataSource, DEFAULT_COUNTRY_POLICY, hashEmail } from "~/modules/mail/suppressions"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** Where a person sets the identity, as the refusal names it. */
export const COMMERCIAL_IDENTITY_SETTING =
  "Settings > Organization > Commercial identity (or config_email, key commercialIdentity)"

export { DEFAULT_COUNTRY_POLICY }

/** How long an opt-out link keeps working. */
export const OPT_OUT_LINK_RETENTION_DAYS = 3 * 365

export interface CommercialFooter {
  body: string
  headers: Record<string, string>
}

export interface OptOutLink {
  url: string
  /** Who the link was made for: the footer reads whether they are owed the notice. */
  recipient?: string
}

/** The org's commercial identity, or null when it is unset or no longer valid. */
export async function readCommercialIdentity(
  orgId: string,
  db?: PrivilegedDb,
): Promise<CommercialIdentity | null> {
  const read = async (tx: PrivilegedDb) =>
    extractRows<{ v: unknown }>(
      await tx.execute(drizzleSql`
        SELECT settings -> 'commercialIdentity' AS v FROM ${K()}.organizations
         WHERE id = ${orgId}::uuid`),
    )
  const rows = db ? await read(db) : await withPrivilegedDb(orgId, "commercial-identity", read)
  const parsed = commercialIdentitySchema.safeParse(rows[0]?.v)
  if (!parsed.success) return null
  return {
    ...parsed.data,
    countryPolicy: parsed.data.countryPolicy ?? DEFAULT_COUNTRY_POLICY,
  }
}

/** True when the org lacks what a commercial mail must state. */
export async function commercialIdentityMissing(orgId: string): Promise<boolean> {
  return (await readCommercialIdentity(orgId)) === null
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** A well-formed link token: 32 bytes, base64url. Anything else is never looked up. */
export function isOptOutToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token)
}

/** A new opt-out link for one recipient of one send. */
export async function mintOptOutLink(orgId: string, recipient: string): Promise<OptOutLink> {
  const token = randomBytes(32).toString("base64url")
  await withPrivilegedDb(orgId, "opt-out-link-mint", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${K()}.suppression_links (token_hash, org_id, email_hash)
      VALUES (${tokenHash(token)}, ${orgId}::uuid, ${hashEmail(orgId, recipient)})`),
  )
  const base = (await orgPublicBaseUrl(orgId)).replace(/\/$/, "")
  return { url: `${base}${OPT_OUT_PATH}/${token}`, recipient }
}

/**
 * Whether the person at `recipient` is owed the notice of where their address
 * came from (GDPR Art. 14) in this commercial mail, and from what source: their
 * first commercial mail, when no contact at that address records its source as
 * given by them (`direct`) and none was sent the notice yet. An unknown source
 * counts as someone else's, so the notice goes. Null when nothing is owed.
 */
export async function art14NoticeDue(
  orgId: string,
  recipient: string,
  db?: PrivilegedDb,
): Promise<{ source: DataSource | null } | null> {
  const read = async (tx: PrivilegedDb) =>
    extractRows<{ data_source: DataSource | null; art14_notice_at: string | null }>(
      await tx.execute(drizzleSql`
        SELECT data_source, art14_notice_at::text AS art14_notice_at FROM ${K()}.contacts
         WHERE org_id = ${orgId}::uuid AND lower(email) = ${recipient.trim().toLowerCase()}`),
    )
  const rows = db ? await read(db) : await withSystemReadReusingHeld("art14-notice-read", read)
  if (rows.some((r) => r.art14_notice_at !== null)) return null
  if (rows.length > 0 && rows.every((r) => r.data_source === "direct")) return null
  const known = rows.find((r) => r.data_source === "third_party" || r.data_source === "enrichment")
  return { source: known?.data_source ?? null }
}

/** Records that the notice went out to `recipient`, on every contact at that address. */
export async function markArt14NoticeSent(
  orgId: string,
  recipient: string,
  db?: PrivilegedDb,
): Promise<void> {
  const write = (tx: PrivilegedDb) =>
    tx.execute(drizzleSql`
      UPDATE ${K()}.contacts SET art14_notice_at = now()
       WHERE org_id = ${orgId}::uuid AND lower(email) = ${recipient.trim().toLowerCase()}
         AND art14_notice_at IS NULL`)
  if (db) await write(db)
  else await withPrivilegedDb(orgId, "art14-notice-mark", write)
}

/** The notice line, in the recipient's language. */
export function art14NoticeLine(
  identity: CommercialIdentity,
  source: DataSource | null,
  locale: ShippedLocale = "en",
): string {
  const key =
    source === "enrichment"
      ? "mail.commercialFooter.noticeEnrichment"
      : source === "third_party"
        ? "mail.commercialFooter.noticeThirdParty"
        : "mail.commercialFooter.noticeUnknown"
  return serverT(locale, key, { name: identity.legalName })
}

/** The org and address fingerprint a link was made for; null for an unknown token. */
export async function resolveOptOutToken(
  token: string,
): Promise<{ orgId: string; emailHash: string } | null> {
  if (!isOptOutToken(token)) return null
  const rows = await withSystemDb("opt-out-link-resolve", async (tx) =>
    extractRows<{ org_id: string; email_hash: string }>(
      await tx.execute(drizzleSql`
        SELECT org_id::text AS org_id, email_hash FROM ${K()}.suppression_links
         WHERE token_hash = ${tokenHash(token)}`),
    ),
  )
  const row = rows[0]
  return row ? { orgId: row.org_id, emailHash: row.email_hash } : null
}

/** Deletes links older than the retention; returns how many went. */
export async function pruneOptOutLinks(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - OPT_OUT_LINK_RETENTION_DAYS * 86_400_000)
  // An org being moved keeps its links as they are until the move ends.
  const rows = await sweepSkippingMoving((notMoving) =>
    withSystemDb("opt-out-link-prune", async (tx) =>
      extractRows<{ token_hash: string }>(
        await tx.execute(drizzleSql`
          DELETE FROM ${K()}.suppression_links WHERE created_at < ${cutoff.toISOString()}::timestamptz
            AND ${notMoving(drizzleSql.raw("org_id"))}
          RETURNING token_hash`),
      ),
    ),
  )
  return rows.length
}

/** The headers a mail client's unsubscribe button uses, from the mail's one link. */
export function optOutHeaders(link: OptOutLink): Record<string, string> {
  return {
    "List-Unsubscribe": `<${link.url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  }
}

/**
 * The language a recipient reads the footer in: their contact's recorded
 * language (`metadata.language`, else `metadata.locale`, as contacts keep
 * fields with no column of their own), else the organization's language,
 * else English.
 */
export async function recipientLocale(orgId: string, recipient: string): Promise<ShippedLocale> {
  const rows = await withPrivilegedDb(orgId, "commercial-footer-locale", async (tx) =>
    extractRows<{ contact: string | null; org: string | null }>(
      await tx.execute(drizzleSql`
        SELECT (SELECT COALESCE(c.metadata ->> 'language', c.metadata ->> 'locale')
                  FROM ${K()}.contacts c
                 WHERE c.org_id = o.id AND lower(c.email) = ${recipient.trim().toLowerCase()}
                   AND jsonb_typeof(c.metadata) = 'object'
                   AND COALESCE(c.metadata ->> 'language', c.metadata ->> 'locale') IS NOT NULL
                 ORDER BY c.updated_at DESC LIMIT 1) AS contact,
               o.default_locale AS org
          FROM ${K()}.organizations o WHERE o.id = ${orgId}::uuid`),
    ),
  )
  return resolveLocale(rows[0]?.contact, rows[0]?.org)
}

/** The footer's lines, in the recipient's language. */
export function footerLines(
  identity: CommercialIdentity,
  url: string,
  locale: ShippedLocale = "en",
  notice?: string,
): string[] {
  return [
    `${identity.legalName}, ${identity.postalAddress}`,
    ...(notice ? [notice] : []),
    serverT(locale, "mail.commercialFooter.optOut", { name: identity.legalName, url }),
  ]
}

/**
 * The body with the commercial footer: plain lines after a text body, an
 * escaped block before `</body>` of an HTML body (or at its end). `notice` is
 * an extra line (where the recipient's address came from); when it is not
 * given and the link names its recipient, the line is added when that person
 * is owed it (`art14NoticeDue`). `locale` is the recipient's language
 * (`recipientLocale`).
 * Throws when the identity is unset: a commercial mail never leaves without it.
 */
export async function applyCommercialFooter(
  orgId: string,
  body: string,
  opts: { kind: "text" | "html"; link: OptOutLink; notice?: string; locale?: ShippedLocale },
  identity?: CommercialIdentity,
): Promise<CommercialFooter> {
  const id = identity ?? (await readCommercialIdentity(orgId))
  if (!id) throw new Error("commercial_identity_missing")
  const locale = opts.locale ?? "en"
  let notice = opts.notice
  if (notice === undefined && opts.link.recipient) {
    const due = await art14NoticeDue(orgId, opts.link.recipient)
    if (due) notice = art14NoticeLine(id, due.source, locale)
  }
  const lines = footerLines(id, opts.link.url, locale, notice)
  const headers = optOutHeaders(opts.link)
  if (opts.kind === "text") {
    return { body: `${body.replace(/\s+$/, "")}\n\n--\n${lines.join("\n")}\n`, headers }
  }
  const block =
    `<div style="margin-top:24px;font-size:12px;color:#666">` +
    lines
      .map((line) => {
        const escaped = escapeHtml(line)
        const href = escapeHtml(opts.link.url)
        return `<p style="margin:4px 0">${escaped.replace(href, `<a href="${href}">${href}</a>`)}</p>`
      })
      .join("") +
    `</div>`
  const at = body.search(/<\/body\s*>/i)
  return {
    body: at >= 0 ? `${body.slice(0, at)}${block}${body.slice(at)}` : `${body}${block}`,
    headers,
  }
}
