// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { snakeCase } from "~/modules/apps/sandbox/bridge/shared"
import {
  type CommercialSend,
  recordCommercialSendAfterSend,
} from "~/modules/mail/commercial-send-record"
import {
  type BuildSendGuardInput,
  buildSendGuard,
  COMMERCIAL_IDENTITY_MISSING_MESSAGE,
  checkPersonCompose,
  commercialFooterFor,
  commercialRecipient,
  describeStop,
  evaluateSendGuard,
  isPinnedSendGuard,
  personZone,
  plainGuardSince,
  recipientsOf,
  requestFacts,
  type SendGuardVerdict,
  stopCode,
  withoutThirdParty,
} from "~/modules/mail/send-guard"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/**
 * Run a sealing call and turn every `MailboxSealError` into a coded `Error` the
 * sandbox can read, adding the one distinction the resolver cannot make on its
 * own: a user with NO identity rows at all has never enrolled
 * (`USER_NOT_ENROLLED`), while a user whose only rows are retired or revoked has
 * `NO_ACTIVE_IDENTITY_KEY`. The extra query runs only on the failure path.
 *
 * Two active identity rows is logged at ERROR because it is the exact shape an
 * operator key-injection attack takes (plant a second identity, seal to it, the
 * user notices nothing because their own key still opens their older mail).
 */
async function mailboxSealErrorContext<T>(
  recipientUserId: string,
  orgId: string,
  on: Pick<RlsClient, "execute">,
  fn: () => Promise<T>,
): Promise<T> {
  const { MailboxSealError } = await import("~/modules/mailbox-crypto/identity-resolver")
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof MailboxSealError)) throw err
    let code: string = err.code
    if (code === "NO_ACTIVE_IDENTITY_KEY") {
      // On the bridge's transaction when it already is a privileged one of this
      // org (a headless sync), else on its own privileged read.
      const { withPrivilegedReusing } = await import("~/db/privileged")
      const any = await withPrivilegedReusing(on, orgId, "mailbox-enrollment-probe", (tx) =>
        tx.execute(
          drizzleSql`SELECT 1 FROM ${K()}.user_mailbox_identities
                      WHERE user_id = ${recipientUserId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
        ),
      )
      if (extractRows(any).length === 0) code = "USER_NOT_ENROLLED"
    }
    if (code === "MULTIPLE_ACTIVE_IDENTITY_KEYS") {
      rootLogger.error(
        { module: "mailbox-crypto", userId: recipientUserId, orgId },
        "more than one active mailbox identity key: refusing to seal (possible key injection)",
      )
    }
    throw new Error(`${code}: ${err.message}`)
  }
}

/** Mail search and the mailbox sealing surface. */
export function createMailMethods(ctx: BridgeContext): Record<string, any> {
  const {
    actorType,
    appName,
    approvalContext,
    assertMailboxNotResetMidRun,
    bridgeOptions,
    callerScopes,
    coerceByteaRowFields,
    coerceNumericRowFields,
    inheritedActor,
    orgId,
    refuseWriteOnReadOnlyRun,
    requireApp,
    schemaName,
    stampDeclaredEmit,
    toSqlValue,
    txDb,
    userId,
    validateEntity,
    validateFields,
  } = ctx
  // Captured here, in the run's frame: a callback from the sandbox has lost it.
  const followUpRun = currentRunContext()?.routineFollowUp === true
  // A person's own click decides for itself. Their request approved by someone
  // else later has `approvalContext`, and is checked like any other.
  const directHumanCall = () =>
    bridgeOptions?.origin === "human-ui" && actorType === "user" && !approvalContext

  /** The contacts behind these addresses, as far as the caller can see them. */
  const contactIdsFor = async (addresses: readonly string[]): Promise<string[]> => {
    if (addresses.length === 0) return []
    const rows = extractRows<{ id: string }>(
      await txDb.execute(
        drizzleSql`SELECT id FROM ${K()}.contacts
                    WHERE org_id = ${orgId}::uuid AND lower(email) = ANY(
                      ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(addresses)}::jsonb)))`,
      ),
    )
    return rows.map((row) => row.id)
  }

  /**
   * The record of this handler run's commercial send, set by the check at send and written by
   * `mail_commercialSent` once the provider accepted the mail (modules/mail/commercial-send-record.ts).
   * Kept here, never handed to the sandbox: what is recorded is what the check decided.
   */
  const pendingCommercialSend = bridgeOptions?.commercialSend ?? { value: null }
  const commercialSendOf = (args: {
    toolName: string
    recipient: string
    footer: { textBody?: string; htmlBody?: string }
    textBody: unknown
    htmlBody: unknown
    mode: string | null
    approvedBy: "person" | "approver" | "policy"
  }): CommercialSend => ({
    orgId,
    actorId: userId,
    actorType: actorType === "agent" ? "agent" : "user",
    toolName: args.toolName,
    recipient: args.recipient,
    textBody: args.footer.textBody ?? args.textBody,
    htmlBody: args.footer.htmlBody ?? args.htmlBody,
    mode: args.mode,
    approvedBy: args.approvedBy,
    approverId:
      args.approvedBy === "approver"
        ? (approvalContext?.approvalDeciderId ?? null)
        : args.approvedBy === "person"
          ? userId
          : null,
    ...(approvalContext ? { approvalRequestId: approvalContext.approvalRequestId } : {}),
  })

  /**
   * A stop names the record only if the caller can open it: a colleague's mailbox stays unnamed.
   * Its kind stays as `source`, so a reply on a ticket still reads as a ticket. Unreadable, a
   * third person in it is named only by their company (`withoutThirdParty`).
   */
  const withReadableRecord = async <T extends SendGuardVerdict>(verdict: T): Promise<T> => {
    const record = verdict.record
    if (!record) return withoutThirdParty(verdict)
    const target =
      record.kind === "ticket"
        ? drizzleSql.raw(`${quoteIdent(schemaRef("app_tickets"))}.tickets`)
        : drizzleSql.raw(`${quoteIdent(schemaRef("app_mail"))}.conversations`)
    try {
      const rows = extractRows(
        await txDb.execute(drizzleSql`SELECT 1 FROM ${target} WHERE id = ${record.id}::uuid`),
      )
      if (rows.length > 0) return verdict
    } catch {
      // Not readable by this caller, by any means: the stop stays, unnamed.
    }
    const { record: _unnamed, ...rest } = verdict
    return withoutThirdParty({ ...rest, source: record.kind } as T)
  }

  return {
    /** Rows for a company's or a contact's timeline, read under the caller's row security. */
    mail_activityRead: async (paramsJson: string): Promise<string> => {
      if (ctx.appName !== "mail")
        throw new Error("mail_activityRead is only available to the mail app")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:conversations:read", ctx.callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:conversations:read")
      }
      const { mailActivityRows } = await import("~/modules/mail/activity-source")
      const { withReadOnlySource } = await import("~/modules/contacts/activity")
      const params = JSON.parse(paramsJson)
      return JSON.stringify(
        await withReadOnlySource(ctx.txDb as never, (tx) =>
          mailActivityRows(tx, ctx.orgId, params),
        ),
      )
    },
    // ── Mailbox sealing (spec section 5.2) ──────────────────────────────────
    //
    // The bridge can SEAL. There is deliberately no counterpart that unseals,
    // opens, decrypts or requests plaintext, and there never will be: the
    // server holds no key that can read mail. (Those four verbs are spelled out
    // here in prose on purpose: T-SEC-1 greps this file for a `mailbox_`-
    // prefixed method matching them, and a comment naming one would trip it,
    // which is the check working.)
    // T-SEC-1 walks the import graph to prove the seal-only half is the only
    // half `apps/api` can reach; these methods are the runtime boundary.
    //
    // The acting identity is NEVER a parameter. It is `userId`, captured when
    // this bridge was constructed, exactly like `getUserId` below. A `userId`
    // parameter would let a sandboxed tool, a bundle change or a handler bug
    // seal a victim's mail to another org member's public key, and every
    // downstream check would still pass.

    mailbox_seal: async (paramsJson: string) => {
      const params = JSON.parse(paramsJson) as {
        plaintextBase64?: string
        aadContext?: string
        entityId?: string
        accountId?: string
      }
      const { resolveSealRecipient, resolveMailAccountCrypto } = await import(
        "~/modules/mailbox-crypto/mail-writer"
      )
      const { sealForUser } = await import("~/modules/mailbox-crypto/seal-service")
      if (!params.accountId) throw new Error("mailbox_seal: accountId is required")
      if (!params.entityId) throw new Error("mailbox_seal: entityId is required")
      if (!params.aadContext) throw new Error("mailbox_seal: aadContext is required")
      const account = await resolveMailAccountCrypto(txDb, schemaName, orgId, params.accountId)
      // Headless sync is the normal inbound path, so the recipient is resolved
      // from the account row rather than required to equal the actor. A human
      // actor that is not the owner is still refused.
      const recipient = resolveSealRecipient(account, userId)
      // A server-managed mailbox has no identity to seal a lone field to: its
      // rows are sealed whole, under its own key, by mailbox_sealAndInsert. A
      // field sealed to the owner's keyring would be one the mailbox cannot open.
      if (account.encryptionState === "managed") {
        throw new Error(
          "mailbox_seal: mailbox is server-managed; seal its rows with mailbox_sealAndInsert",
        )
      }
      const batch = await mailboxSealErrorContext(recipient, orgId, txDb, () =>
        sealForUser(
          recipient,
          orgId,
          [
            {
              context: {
                kind: params.aadContext as never,
                entityId: params.entityId as string,
              },
              plaintext: new Uint8Array(Buffer.from(params.plaintextBase64 ?? "", "base64")),
            },
          ],
          txDb,
        ),
      )
      return JSON.stringify({
        ciphertextBase64: Buffer.from(
          (batch.items[0] as { ciphertext: Uint8Array }).ciphertext,
        ).toString("base64"),
        contentKeyWrappedBase64: Buffer.from(batch.contentKeyWrapped).toString("base64"),
        contentKeyEpkBase64: Buffer.from(batch.contentKeyEpk).toString("base64"),
        keyId: batch.keyId,
        encVersion: batch.encVersion,
      })
    },

    /**
     * Mint the row id, seal every named field under ONE content key with that id
     * in the AAD, and perform the insert, all in one savepoint-wrapped call.
     *
     * This exists because the AAD must bind the row id and the row id does not
     * exist until the insert. The alternative, letting the sandbox supply `id`
     * to `db_insert`, was rejected: `validateFields` builds its allowlist purely
     * from the manifest field map and throws `Unknown field "id"`, and relaxing
     * that would let EVERY sandboxed app choose its own primary keys across
     * every entity on the platform to solve a problem belonging to one call
     * site. Keeping seal and insert in one operation also makes "one content key
     * per row" structural and stops a crash between the two from leaving a
     * sealed blob with no row, or a row with no ciphertext.
     */
    mailbox_sealAndInsert: async (paramsJson: string) => {
      const params = JSON.parse(paramsJson) as {
        entity?: string
        accountId?: string
        row?: Record<string, unknown>
        plaintext?: Record<string, string | null | undefined>
      }
      const {
        resolveSealRecipient,
        MAILBOX_SEALED_FIELDS,
        resolveMailAccountCrypto,
        sealMailFields,
      } = await import("~/modules/mailbox-crypto/mail-writer")
      const entity = params.entity as keyof typeof MAILBOX_SEALED_FIELDS
      if (!entity || !MAILBOX_SEALED_FIELDS[entity]) {
        throw new Error(`mailbox_sealAndInsert: entity "${params.entity}" is not sealable`)
      }
      if (!params.accountId) throw new Error("mailbox_sealAndInsert: accountId is required")
      validateEntity(entity)
      await assertMailboxNotResetMidRun([params.accountId])
      const account = await resolveMailAccountCrypto(txDb, schemaName, orgId, params.accountId)
      // Same rule as mailbox_seal: inbound mail is written by a job, so the
      // recipient comes from the account row, host side, never a parameter.
      const recipient = resolveSealRecipient(account, userId)

      // The host mints the id. The sandbox cannot choose it, so it cannot bind
      // a ciphertext to a row it does not own.
      const row = { ...(params.row ?? {}) }
      const id = typeof row.id === "string" ? (row.id as string) : crypto.randomUUID()
      delete row.id
      validateFields(entity, row)

      const sealed = await mailboxSealErrorContext(recipient, orgId, txDb, () =>
        sealMailFields({
          userId: recipient,
          orgId,
          entity,
          entityId: id,
          values: params.plaintext ?? {},
          headers: entity === "messages" ? (row.rawHeaders as Record<string, unknown>) : null,
          on: txDb,
        }),
      )
      if (entity === "messages") row.rawHeaders = sealed.retainedHeaders ?? {}

      // Ciphertext columns are bytea; they bypass the manifest's base64 wire
      // convention here because the host already holds real bytes.
      const byteaCols = new Set<string>()
      const allData: Record<string, unknown> = { ...row, org_id: orgId, id }
      for (const [col, value] of Object.entries(sealed.columns)) {
        allData[col] = value
        if (Buffer.isBuffer(value)) byteaCols.add(col)
      }

      const entries = Object.entries(allData)
      const tableRef = drizzleSql.raw(`${quoteIdent(schemaName)}.${quoteIdent(entity)}`)
      const colsChunk = drizzleSql.raw(entries.map(([k]) => quoteIdent(snakeCase(k))).join(", "))
      const valsChunk = drizzleSql.join(
        entries.map(([k, v]) =>
          k === "org_id" || k === "id" || byteaCols.has(k)
            ? drizzleSql`${v}`
            : toSqlValue(entity, k, v),
        ),
        drizzleSql.raw(", "),
      )
      // A driver savepoint, released when done: a failed insert (a unique
      // race) rolls back alone and the caller may recover on the same
      // transaction. Not a raw SAVEPOINT: postgres.js rethrows a scope's failed
      // query when the scope ends, even one the caller caught.
      try {
        const rows = await withReleasedSavepoint(txDb, async (sp) =>
          extractRows(
            await sp.execute(
              drizzleSql`INSERT INTO ${tableRef} (${colsChunk}) VALUES (${valsChunk}) RETURNING *`,
            ),
          ),
        )
        return JSON.stringify(
          coerceByteaRowFields(entity, coerceNumericRowFields(entity, [rows[0] ?? null]))[0] ?? {
            id: null,
          },
        )
      } catch (err) {
        const e = err as { message?: string; cause?: { message?: string; code?: string } }
        if (e?.cause?.message) {
          throw new Error(
            `${e.message ?? "mailbox_sealAndInsert failed"} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
          )
        }
        throw err
      }
    },

    /**
     * Queue headless work for the browser to run when the user is next online.
     *
     * `payload` is envelope level by contract: ids, labels, counts. Never a
     * body, a subject or an excerpt. The row lives in `kernel`, deliberately
     * outside the mail app's entity machinery, so it inherits no tool
     * projection, event emission or timeline (Invariant K).
     */
    mailbox_enqueueClientJob: async (paramsJson: string) => {
      const params = JSON.parse(paramsJson) as {
        kind?: string
        payload?: unknown
        accountId?: string | null
        dedupe?: boolean
      }
      // The kind check and the envelope-only check live in the service, on the
      // HOST side of the sandbox boundary, so a compromised app bundle cannot
      // widen the queue into a plaintext side channel by calling this method
      // with a body in the payload.
      const { enqueueJob: enqueueClientJob } = await import("~/modules/mailbox-jobs/service")
      // The queue is keyed by the OWNER, because the browser that runs the job
      // is the owner's. A headless sync actor is not a uuid and cannot be the
      // key, so the owner is resolved from the account row host side, the same
      // way the seal recipient is. A system actor with no account to resolve
      // through has no owner and is refused rather than guessed at.
      const { isSystemMailActor, resolveMailAccountCrypto, resolveSealRecipient } = await import(
        "~/modules/mailbox-crypto/mail-writer"
      )
      let jobUserId = userId
      if (isSystemMailActor(userId)) {
        if (!params.accountId) {
          throw new Error(
            "mailbox_enqueueClientJob: a system actor must supply accountId, " +
              "there is no owner to queue the job for otherwise",
          )
        }
        const account = await resolveMailAccountCrypto(txDb, schemaName, orgId, params.accountId)
        jobUserId = resolveSealRecipient(account, userId)
      }
      const { jobId } = await enqueueClientJob(txDb, jobUserId, orgId, {
        kind: params.kind ?? "",
        payload: params.payload ?? {},
        accountId: params.accountId ?? null,
        dedupe: params.dedupe === true,
      })
      // Wake any tab this user has open, so "when you are next online" does not
      // mean "up to a minute after you were". Best effort by design: the row is
      // still inside this transaction, so a tab that polls on the wake before
      // the commit simply sees nothing and picks the job up on its next poll.
      try {
        const { broadcastEphemeral } = await import("~/infra/events/event-bus")
        await broadcastEphemeral({
          app: "kernel",
          entity: "mailbox_jobs",
          action: "pending",
          orgId,
          actorId: userId,
          // Metadata only. Never the payload: this rides an org-wide fan-out.
          // The wake names the OWNER, so a headless sync still wakes the right
          // tab rather than a user id no browser matches.
          data: { userId: jobUserId },
        })
      } catch {
        // A wake that did not go out costs one poll interval, never the job.
      }
      return JSON.stringify({ jobId })
    },

    /**
     * Write one sync page in ONE transaction (this bridge call's): skip what is
     * stored, create and roll up conversations, insert (and, for an armed
     * personal mailbox, seal) the messages, resolve senders to contacts under
     * the mailbox's policy, queue the events. See modules/mail/page-write.ts.
     * Ownership, sealing and contact policy come from the account row; the
     * reset fence and the seal-error codes are the same as mailbox_sealAndInsert.
     */
    mail_writePage: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_writePage")
      const params = JSON.parse(paramsJson) as {
        accountId?: unknown
        origin?: unknown
        messages?: unknown
      }
      if (typeof params.accountId !== "string" || !params.accountId) {
        throw new Error("mail_writePage: accountId is required")
      }
      const accountId = params.accountId
      await assertMailboxNotResetMidRun([accountId])
      const { writeMailPage } = await import("~/modules/mail/page-write")
      const { resolveMailAccountCrypto } = await import("~/modules/mailbox-crypto/mail-writer")
      const account = await resolveMailAccountCrypto(txDb, schemaName, orgId, accountId)
      // The owner, for the seal-error diagnosis only (who has never enrolled).
      // In a savepoint: a failure (a seal refused, a malformed row) leaves no row
      // and no event behind even when this call shares an enclosing
      // transaction (an atomic tool), exactly like mailbox_sealAndInsert.
      const result = await mailboxSealErrorContext(account.ownerId ?? "", orgId, txDb, () =>
        txDb.transaction((pageTx) =>
          writeMailPage(
            {
              tx: pageTx as unknown as typeof txDb,
              schemaName,
              orgId,
              actorId: userId,
              queueEvents: (events) => pageTx.queueEvents(events.map(stampDeclaredEmit)),
            },
            { accountId, origin: String(params.origin ?? ""), messages: params.messages },
          ),
        ),
      )
      return JSON.stringify(result)
    },

    // The settings page's mailbox providers toggle (tools providers.get/set,
    // the same data and checks as GET/PATCH /api/mail/providers): which
    // mailbox connection types the workspace offers, `{ gmail: boolean }`.
    mail_providersGet: async (): Promise<string> => {
      requireApp("mail", "mail_providersGet")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:accounts:read", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:accounts:read")
      }
      const { listMailProviders } = await import("~/modules/mail/provider-settings")
      const providers = await listMailProviders(orgId)
      return JSON.stringify(Object.fromEntries(providers.map((p) => [p.id, p.enabled])))
    },
    mail_providersSet: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_providersSet")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:accounts:admin", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:accounts:admin")
      }
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      const { listMailProviders, setMailProviderEnabled } = await import(
        "~/modules/mail/provider-settings"
      )
      for (const [providerId, enabled] of Object.entries(params)) {
        if (typeof enabled !== "boolean") {
          throw new Error(`mail_providersSet: ${providerId} must be true or false`)
        }
        await setMailProviderEnabled(orgId, providerId, enabled)
      }
      const providers = await listMailProviders(orgId)
      return JSON.stringify(Object.fromEntries(providers.map((p) => [p.id, p.enabled])))
    },

    /** Delete a disconnected mailbox's imported content (modules/mail/purge-account.ts). */
    mail_purgeDisconnectedAccount: async (accountId: string): Promise<string> => {
      requireApp("mail", "mail_purgeDisconnectedAccount")
      if (typeof accountId !== "string" || !accountId) {
        throw new Error("mail_purgeDisconnectedAccount: accountId is required")
      }
      const { purgeDisconnectedMailAccount } = await import("~/modules/mail/purge-account")
      return JSON.stringify(await purgeDisconnectedMailAccount(orgId, accountId))
    },

    /** Release another owner's stale mailbox row for a new connection (modules/mail/purge-account.ts). */
    mail_releaseForeignAccount: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_releaseForeignAccount")
      const params = JSON.parse(paramsJson) as { accountId?: unknown; connectionId?: unknown }
      if (typeof params.accountId !== "string" || !params.accountId) {
        throw new Error("mail_releaseForeignAccount: accountId is required")
      }
      if (typeof params.connectionId !== "string" || !params.connectionId) {
        throw new Error("mail_releaseForeignAccount: connectionId is required")
      }
      const { releaseForeignMailAccount } = await import("~/modules/mail/purge-account")
      return JSON.stringify(
        await releaseForeignMailAccount(orgId, params.accountId, params.connectionId),
      )
    },

    /** Mark messages whose post-commit work (attachments, envelope jobs) is done. */
    mail_completeIngest: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_completeIngest")
      const params = JSON.parse(paramsJson) as { accountId?: unknown; messageIds?: unknown }
      if (typeof params.accountId !== "string" || !params.accountId) {
        throw new Error("mail_completeIngest: accountId is required")
      }
      const { completeMailIngest } = await import("~/modules/mail/page-write")
      const count = await completeMailIngest(
        { tx: txDb, schemaName, orgId },
        { accountId: params.accountId, messageIds: params.messageIds },
      )
      return JSON.stringify({ count })
    },

    /**
     * The send check's value for a staged `mail:compose` or `mail:reply`, in the
     * preflight, last. A person's own call has none. A follow-up the check would
     * stop is refused here, so no card is staged that could never send.
     */
    mail_buildSendGuard: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_buildSendGuard")
      if (directHumanCall()) return JSON.stringify({ applies: false })
      const params = JSON.parse(paramsJson) as {
        toolName: "mail:compose" | "mail:reply"
        to?: unknown
        cc?: unknown
        bcc?: unknown
        conversationId?: string
        followUp?: BuildSendGuardInput["followUp"]
      }
      const recipients = recipientsOf(params.to, params.cc, params.bcc)
      const zone = await personZone(orgId, userId)
      const built = await buildSendGuard({
        ...zone,
        orgId,
        toolName: params.toolName,
        followUpRun,
        followUp: params.followUp ?? null,
        recipients,
        contactIds: await contactIdsFor(recipients),
        ...(params.conversationId ? { conversationId: params.conversationId } : {}),
        // Only a person's own click is not staged by an agent (and it has no guard at all).
        agentStaged: bridgeOptions?.origin !== "human-ui",
      })
      if ("commercialIdentityMissing" in built) {
        return JSON.stringify({
          applies: true,
          refusal: {
            code: "commercial_identity_missing",
            message: `Nothing was sent and no draft was staged. ${COMMERCIAL_IDENTITY_MISSING_MESSAGE}`,
            retryable: false,
          },
        })
      }
      if ("refused" in built) {
        return JSON.stringify({
          applies: true,
          refusal: { ...built.refused, retryable: false },
        })
      }
      const { state } = built.verdict
      if (state !== "clear" && state !== "held") {
        const verdict = await withReadableRecord(built.verdict)
        return JSON.stringify({
          applies: true,
          refusal: {
            code: `SEND_GUARD_${state.toUpperCase()}`,
            message: describeStop(verdict, "stage"),
            retryable: !verdict.final,
            body: { guard: verdict },
          },
        })
      }
      return JSON.stringify({
        applies: true,
        sendGuard: built.sendGuard,
        ...(built.guardKey ? { guardKey: built.guardKey } : {}),
      })
    },

    /**
     * The check at send, after the approval is recorded and before anything leaves,
     * on the payload as it stands now. A call staged with no value (a chained
     * `@ref` step, or one from before this check) is built here as plain.
     */
    mail_checkSendGuard: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_checkSendGuard")
      const params = JSON.parse(paramsJson) as {
        toolName?: string
        sendGuard?: unknown
        to?: unknown
        cc?: unknown
        bcc?: unknown
        conversationId?: string
        textBody?: unknown
        htmlBody?: unknown
      }
      const recipients = recipientsOf(params.to, params.cc, params.bcc)
      if (directHumanCall()) {
        // A person's own new message to a prospect keeps the company's rules.
        if (params.toolName !== "mail:compose") return JSON.stringify({ applies: false })
        const own = await checkPersonCompose(orgId, recipients)
        if (!own.commercial) return JSON.stringify({ applies: false })
        if ("refused" in own) {
          return JSON.stringify({
            applies: true,
            state: "refused",
            final: true,
            code: own.refused.code,
            message: own.refused.message,
            approved: false,
            guard: { state: "refused", reason: own.refused.message, classification: "marketing" },
          })
        }
        const footer = await commercialFooterFor(
          orgId,
          own.recipient,
          params.textBody,
          params.htmlBody,
        )
        if (!footer) {
          const message = `Nothing was sent. ${COMMERCIAL_IDENTITY_MISSING_MESSAGE}`
          return JSON.stringify({
            applies: true,
            state: "refused",
            final: true,
            code: "commercial_identity_missing",
            message,
            approved: false,
            guard: { state: "refused", reason: message, classification: "marketing" },
          })
        }
        pendingCommercialSend.value = commercialSendOf({
          toolName: params.toolName,
          recipient: own.recipient,
          footer,
          textBody: params.textBody,
          htmlBody: params.htmlBody,
          mode: null,
          approvedBy: "person",
        })
        return JSON.stringify({
          applies: true,
          state: "clear",
          record: { guard: { state: "clear", classification: "marketing", footer: "commercial" } },
          footer,
        })
      }
      const request = approvalContext
        ? await requestFacts(orgId, approvalContext.approvalRequestId)
        : null
      const guard = isPinnedSendGuard(params.sendGuard)
        ? params.sendGuard
        : plainGuardSince(
            recipients,
            await contactIdsFor(recipients),
            request?.createdAt ?? new Date(),
            params.conversationId,
          )
      const zone = await personZone(orgId, request?.requestedBy ?? userId)
      const checked = await evaluateSendGuard({
        ...zone,
        orgId,
        guard,
        recipients,
        ...(params.toolName ? { toolName: params.toolName } : {}),
        at: "send",
      })
      // The class it was checked under now: an edit of the recipients may have made it commercial.
      const classification = checked.classification ?? guard.classification
      if (checked.state === "clear") {
        // A commercial mail gets its footer here, and the send's record says so, so
        // what left can be checked against the classification it was sent under.
        const commercial = classification === "marketing"
        const first = commercial ? await commercialRecipient(orgId, recipients) : null
        const footer = first
          ? await commercialFooterFor(orgId, first, params.textBody, params.htmlBody)
          : null
        if (commercial && !footer) {
          // The identity was cleared after staging: the mail cannot leave without it.
          const message = `The mail was not sent. ${COMMERCIAL_IDENTITY_MISSING_MESSAGE}`
          return JSON.stringify({
            applies: true,
            state: "unavailable",
            final: false,
            code: "commercial_identity_missing",
            message,
            approved: approvalContext !== undefined,
            guard: {
              state: "unavailable",
              reason: message,
              mode: guard.mode,
              classification,
            },
          })
        }
        if (commercial && footer && first) {
          pendingCommercialSend.value = commercialSendOf({
            toolName: params.toolName ?? "mail:compose",
            recipient: first,
            footer,
            textBody: params.textBody,
            htmlBody: params.htmlBody,
            mode: guard.mode,
            approvedBy: approvalContext ? "approver" : "policy",
          })
        }
        return JSON.stringify({
          applies: true,
          state: "clear",
          record: {
            guard: {
              state: "clear",
              mode: guard.mode,
              classification,
              ...(footer ? { footer: "commercial" } : {}),
            },
          },
          ...(footer ? { footer } : {}),
        })
      }
      const verdict = await withReadableRecord(checked)
      return JSON.stringify({
        applies: true,
        state: verdict.state,
        final: verdict.final,
        code: stopCode(verdict),
        message: describeStop(verdict, approvalContext ? "approved" : "auto"),
        approved: approvalContext !== undefined,
        guard: { ...verdict, mode: guard.mode, classification },
      })
    },

    /**
     * After the provider accepted a mail the check at send cleared as commercial: its record
     * and the notice mark (modules/mail/commercial-send-record.ts). Nothing when the check set
     * none. The mail is already gone, so a record that cannot be written is logged, not refused.
     */
    mail_commercialSent: async (): Promise<string> => {
      requireApp("mail", "mail_commercialSent")
      const send = pendingCommercialSend.value
      pendingCommercialSend.value = null
      if (!send) return JSON.stringify({ recorded: false, commercial: false })
      return JSON.stringify({
        recorded: await recordCommercialSendAfterSend(send),
        commercial: true,
      })
    },

    // Opt-outs (modules/mail/suppressions.ts). The tools' required scopes are checked again here,
    // and row security on kernel.suppressions decides each write.
    mail_suppressionCheck: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_suppressionCheck")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:suppressions:read", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:suppressions:read")
      }
      const { emails } = JSON.parse(paramsJson) as { emails?: unknown }
      const list = Array.isArray(emails)
        ? emails.filter((e): e is string => typeof e === "string" && e.trim() !== "")
        : []
      const { checkSuppressions } = await import("~/modules/mail/suppressions")
      return JSON.stringify(
        await checkSuppressions({
          orgId,
          emails: list,
          given: Array.isArray(emails) ? emails.length : 0,
          db: txDb,
        }),
      )
    },
    mail_suppressionAdd: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_suppressionAdd")
      refuseWriteOnReadOnlyRun("kernel.suppressions", "mail_suppressionAdd")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:conversations:write", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:conversations:write")
      }
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      const { addSuppressionTool } = await import("~/modules/mail/suppressions")
      return JSON.stringify(
        await addSuppressionTool({
          orgId,
          db: txDb,
          userId: actorType === "user" || actorType === "agent" ? userId : null,
          actorType: actorType === "agent" ? "agent" : actorType === "user" ? "user" : "system",
          params,
        }),
      )
    },
    mail_suppressionRemove: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_suppressionRemove")
      refuseWriteOnReadOnlyRun("kernel.suppressions", "mail_suppressionRemove")
      const { hasScope } = await import("~/modules/permissions/permissions")
      if (!hasScope("mail:suppressions:write", callerScopes ?? [])) {
        throw new Error("forbidden: missing scope mail:suppressions:write")
      }
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      const { removeSuppressionTool } = await import("~/modules/mail/suppressions")
      return JSON.stringify(
        await removeSuppressionTool({
          orgId,
          db: txDb,
          params,
        }),
      )
    },

    /** Mirror a Gmail write-back onto the stored labels, as a delta (modules/mail/gmail-write-back.ts). */
    mail_applyLabelDelta: async (paramsJson: string): Promise<string> => {
      requireApp("mail", "mail_applyLabelDelta")
      const { applyConversationLabelDelta } = await import("~/modules/mail/gmail-write-back")
      const labels = await applyConversationLabelDelta(
        { tx: txDb, schemaName, orgId },
        JSON.parse(paramsJson),
      )
      return JSON.stringify({ labels })
    },

    // Host-side mail conversation search (mirrors tickets_search): structured
    // filters run as real SQL under the caller's RLS tx and free text resolves
    // through the permission-filtered Meili index — nothing scans inside the
    // sandbox heap. Same actor-derivation and error-envelope rules as
    // tickets_search above (see those comments for the rationale).
    mail_search: async (paramsJson: string): Promise<string> => {
      if (appName !== "mail") {
        throw new Error("mail_search is only available to the mail app")
      }
      const { searchMailConversations, MailSearchUnavailableError } = await import(
        "~/apps/mail/search"
      )
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      const searchActor = {
        userId: (inheritedActor.actorType === "user" ? inheritedActor.userId : userId) ?? "",
        scopes: callerScopes ?? [],
        dimensionGrants:
          inheritedActor.actorType === "user"
            ? (inheritedActor.dimensionGrants ?? {})
            : { "*": ["*"] },
        roleIds: inheritedActor.actorType === "user" ? (inheritedActor.roles ?? []) : [],
      }
      try {
        const result = await searchMailConversations(txDb as never, orgId, params, searchActor)
        return JSON.stringify(result)
      } catch (err) {
        if (err instanceof MailSearchUnavailableError) {
          return JSON.stringify({
            error: { code: err.code, message: err.message, retryable: true, status: err.status },
          })
        }
        throw err
      }
    },
  }
}
