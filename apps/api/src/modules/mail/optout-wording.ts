// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An inbound reply that asks to stop receiving mail ("unsubscribe", "stop",
// "ne plus recevoir", "abmelden" ...) becomes a proposal, never an opt-out by
// itself: one pending `mail:suppression_add` with reason `reply` for a person to
// approve. Matching is code, not the model, so it is the same on every mailbox.
//
// What is read: the new text of a plaintext, non-sealed, non-bulk inbound
// message (the quoted history cut off), when that text is short (under
// OPT_OUT_MAX_WORDS words) or the phrase stands on a line of its own. A long
// reply that merely mentions "stop" proposes nothing. A sealed mailbox's mail is
// never read: its reply still stops the one send it answers, and an opt-out
// then needs a person.
//
// Where it runs: beside the bulk detection of the sync's page write
// (page-write.ts). A failure is logged and never stops the sync.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { QUOTE_TRIMMED_MARKER, stripQuotedHistory } from "~/lib/email/strip-quoted"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { effectiveVisibility } from "~/modules/approvals/resource-owner"
import { isMachineAddress } from "~/modules/mail/sender-contacts"
import { hashEmail, isSuppressedHash } from "~/modules/mail/suppressions"

const log = rootLogger.child({ module: "mail-optout-wording" })

/** A reply of this many words or more proposes only when the phrase has a line of its own. */
export const OPT_OUT_MAX_WORDS = 60

/**
 * What asks to stop, per language, lowercased with accents removed. A trailing `*` matches any
 * ending ("desinscri*" is "désinscrire", "désinscrivez-moi", "désinscription").
 */
export const OPT_OUT_PHRASES: Readonly<
  Record<"en" | "fr" | "de" | "es" | "it", readonly string[]>
> = {
  en: [
    "unsubscrib*",
    "stop",
    "opt out",
    "opt-out",
    "remove me",
    "take me off",
    "stop emailing me",
    "no more emails",
    "do not contact me",
  ],
  fr: [
    "ne plus recevoir",
    "desinscri*",
    "desabonn*",
    "retirez-moi",
    "ne me contactez plus",
    "ne plus etre contacte*",
  ],
  de: ["abmelden", "abbestellen", "austragen", "keine e-mails mehr", "keine werbung"],
  es: [
    "darme de baja",
    "dar de baja",
    "darse de baja",
    "no quiero recibir",
    "cancelar suscripcion",
  ],
  it: ["disiscrivi*", "cancellami", "annulla iscrizione", "non voglio piu ricevere", "rimuovetemi"],
}

/** Lowercase, accents removed, apostrophes and spaces made plain. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[   ]/g, " ")
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** One phrase as a pattern on whole words: "stop" is not "stopped" nor "nonstop". */
function phrasePattern(phrase: string): RegExp {
  const open = phrase.endsWith("*")
  const body = (open ? phrase.slice(0, -1) : phrase).split(/[\s]+/).map(escapeRe).join("[\\s-]+")
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${body}${open ? "\\p{L}*" : ""}(?=$|[^\\p{L}\\p{N}])`,
    "u",
  )
}

const PATTERNS: ReadonlyArray<{ phrase: string; re: RegExp }> = Object.values(OPT_OUT_PHRASES)
  .flat()
  .map((phrase) => ({ phrase, re: phrasePattern(phrase) }))

/** The text a person typed in this message: the quoted history after it cut off. */
export function newTextOf(body: string): string {
  const { text, trimmedChars } = stripQuotedHistory(body)
  const head = trimmedChars > 0 ? text.slice(0, text.lastIndexOf(QUOTE_TRIMMED_MARKER)) : text
  // A quote that starts the body leaves its own lines in the head: they are not new text either.
  return head
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
}

const wordsIn = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/** A line that is the phrase alone, give or take punctuation and a "please". */
function standsAlone(line: string, re: RegExp): boolean {
  const bare = line
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\b(please|merci|svp|bitte|por favor|per favore|thanks|thank you)\b/g, " ")
    .trim()
  if (!bare) return false
  const m = re.exec(bare)
  if (!m) return false
  return bare.replace(re, " ").trim() === ""
}

/**
 * The opt-out phrase this message's new text asks with, or null. Short text proposes on the
 * phrase anywhere in it; longer text only when the phrase stands on a line of its own.
 */
export function optOutPhraseIn(body: string | null | undefined): string | null {
  if (!body) return null
  const text = normalize(newTextOf(body))
  const short = wordsIn(text) < OPT_OUT_MAX_WORDS
  const lines = text.split(/\n/)
  for (const { phrase, re } of PATTERNS) {
    if (short ? re.test(text) : lines.some((line) => standsAlone(line, re))) return phrase
  }
  return null
}

/** One inbound message that asked to stop. */
export interface OptOutCandidate {
  email: string
  /** The stored message's id: the proposal's source. */
  messageId: string
}

/** The mailbox the message came into: who the proposal is raised for. */
export interface OptOutMailbox {
  id: string
  ownerType: string
  ownerId: string | null
}

/**
 * Raise one pending `mail:suppression_add` per sender that asked to stop and has neither opted
 * out already nor a proposal waiting (one per sender, keyed by the address's hash). The request is
 * raised for the mailbox's owner (a shared mailbox: whoever connected it). A personal mailbox's
 * proposal is decided by its owner alone, as any approval about a personal mailbox is (the reply
 * is theirs, and so is who wrote it); a shared mailbox's goes to the mail approvers. Nothing is
 * suppressed here. Never throws: a failure is logged and the sync goes on.
 */
export async function proposeOptOuts(
  orgId: string,
  mailbox: OptOutMailbox,
  candidates: readonly OptOutCandidate[],
): Promise<string[]> {
  const raised: string[] = []
  const bySender = new Map<string, OptOutCandidate>()
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase()
    if (!email.includes("@") || isMachineAddress(email) || bySender.has(email)) continue
    bySender.set(email, { email, messageId: c.messageId })
  }
  if (bySender.size === 0) return raised
  try {
    const facts = await withPrivilegedDb(orgId, "mail-optout-proposal-facts", async (tx) => {
      const K = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
      const M = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))
      const emails = JSON.stringify([...bySender.keys()])
      const own = extractRows<{ email: string }>(
        await tx.execute(drizzleSql`
          SELECT lower(email) AS email FROM ${K}.users
           WHERE org_id = ${orgId}::uuid AND user_type = 'member'
             AND lower(email) IN (SELECT jsonb_array_elements_text(${emails}::jsonb))
          UNION
          SELECT lower(email_address) FROM ${M}.accounts
           WHERE org_id = ${orgId}::uuid
             AND lower(email_address) IN (SELECT jsonb_array_elements_text(${emails}::jsonb))`),
      ).map((r) => r.email)
      const waiting = extractRows<{ email: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT lower(tool_params->>'email') AS email FROM ${K}.approval_requests
           WHERE org_id = ${orgId}::uuid AND tool_name = 'mail:suppression_add'
             AND status IN ('pending', 'approving')
             AND lower(tool_params->>'email') IN (SELECT jsonb_array_elements_text(${emails}::jsonb))`),
      ).map((r) => r.email)
      // The person the request is raised for: the mailbox's owner, or whoever connected a shared
      // mailbox, while they are an active member.
      const found = extractRows<{
        id: string
        owner_type: string | null
        visibility: string | null
      }>(
        await tx.execute(drizzleSql`
          SELECT u.id::text AS id, a.owner_type, a.visibility
            FROM ${M}.accounts a
            LEFT JOIN ${K}.connected_accounts ca
              ON ca.org_id = a.org_id AND ca.id = a.connected_account_id
            JOIN ${K}.users u
              ON u.org_id = a.org_id
             AND u.id = CASE WHEN a.owner_type = 'user' THEN a.owner_id ELSE ca.created_by END
           WHERE a.org_id = ${orgId}::uuid AND a.id = ${mailbox.id}::uuid
             AND u.status = 'active' AND u.user_type = 'member'`),
      )[0]
      return {
        own: new Set(own),
        waiting: new Set(waiting),
        requester: found?.id ?? null,
        personal:
          !!found && effectiveVisibility(found) === "personal" && found.owner_type === "user",
      }
    })
    if (!facts.requester) {
      log.warn(
        { orgId, accountId: mailbox.id },
        "opt-out reply: the mailbox has no active person to raise it for",
      )
      return raised
    }
    const { createHandlerApprovalRequest } = await import("~/modules/apps/execute-tool")
    const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
    const scopes = await withPrivilegedDb(
      orgId,
      "mail-optout-proposal-scopes",
      async (tx) =>
        (await loadEffectivePermissions(tx as never, facts.requester as string, orgId)).scopes,
    )
    for (const { email, messageId } of bySender.values()) {
      if (facts.own.has(email) || facts.waiting.has(email)) continue
      try {
        if (await isSuppressedHash(orgId, hashEmail(orgId, email))) continue
        const result = await createHandlerApprovalRequest({
          orgId,
          requestedBy: facts.requester,
          actorScopes: scopes,
          defaultAppName: "mail",
          origin: "system",
          ...(facts.personal ? { ownerOfResource: facts.requester } : {}),
          input: {
            tool_name: "mail:suppression_add",
            summary: `${email} asked to stop receiving mail`,
            summary_detail: {
              subtitle: "Opt-out asked in a reply",
              lines: [
                `${email} wrote asking to stop receiving mail.`,
                "Approve to stop commercial mail to them. Service messages (an invoice, an order) still go.",
                "Nothing is recorded until someone approves.",
              ],
            },
            current_payload: { email, reason: "reply", source: messageId },
          },
        })
        if (result.approval_id) raised.push(result.approval_id)
      } catch (err) {
        log.error(
          { err, orgId, accountId: mailbox.id },
          "opt-out reply: the proposal was not raised",
        )
      }
    }
  } catch (err) {
    log.error({ err, orgId, accountId: mailbox.id }, "opt-out reply: the senders could not be read")
  }
  return raised
}
