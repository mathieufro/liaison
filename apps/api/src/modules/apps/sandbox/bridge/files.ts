// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  SANDBOX_FETCH_MAX_REDIRECTS,
  sandboxEgressOverrides,
  sandboxEgressPolicy,
  validateSandboxFetchUrl,
} from "~/modules/apps/sandbox/bridge/shared"
import { maybeDemoBoxtalResponse } from "~/modules/demo/boxtal/responder"
import { maybeDemoPaymentsResponse } from "~/modules/demo/worlds/saas/payments/provider"

/** Headers a sandbox may set on a `files_importFromUrl` download. */
const IMPORT_HEADER_ALLOWLIST = new Set(["authorization", "accept"])

/** File attachments: import, attach, reparent, list and byte reads. */
export function createFilesMethods(ctx: BridgeContext): Record<string, any> {
  const {
    assertMailboxNotResetMidRun,
    appName,
    auditActorType,
    bridgeActingAgentId,
    bridgeOptions,
    callerScopes,
    inheritedActor,
    manifest,
    orgId,
    requireCapability,
    schemaName,
    txDb,
    userId,
  } = ctx
  /**
   * A mail file belongs to one mailbox; a run that started before that mailbox
   * was reset must not add or move files into it (see
   * `assertMailboxNotResetMidRun`). Resolves the mailbox from the destination
   * parent: a message, conversation or draft row, or an account id for
   * outbound staging. A parent that no longer exists resolves to nothing, and
   * the callers' own visibility checks refuse it.
   */
  async function assertMailParentNotResetMidRun(
    targetEntityType: string,
    targetEntityId: string,
  ): Promise<void> {
    if (appName !== "mail") return
    const { resolveParent } = await import("~/modules/files/service")
    const parent = resolveParent(orgId, appName, targetEntityType)
    if (!parent) return
    if (parent.tableName === "accounts") {
      await assertMailboxNotResetMidRun([targetEntityId])
      return
    }
    if (!["messages", "conversations", "drafts"].includes(parent.tableName)) return
    const ps = drizzleSql.raw(`"${schemaRef(parent.schemaRef)}"`)
    const pt = drizzleSql.raw(`"${parent.tableName}"`)
    const pj = drizzleSql.raw(`"${parent.joinOn}"`)
    const owning = extractRows<{ account_id: string | null }>(
      await txDb.execute(
        drizzleSql`SELECT account_id::text AS account_id FROM ${ps}.${pt} WHERE ${pj}::text = ${targetEntityId} LIMIT 1`,
      ),
    )
    await assertMailboxNotResetMidRun([owning[0]?.account_id])
  }

  // One-shot passes minted by `files_importFromUrl` when a provider-contract op stores onto its
  // caller's parent: `files_importAttachment` accepts that cross-app target only with a live pass
  // (a sandbox calling `files_importAttachment` itself never holds one).
  const callerTargetPasses = new Set<string>()

  // The ONE caller record a provider-contract dispatch may store onto: the op's file target, bound
  // by the kernel from the caller's own params (provider-contracts/file-target.ts). Any other record
  // of the caller (another entity type, another row) stays out of reach, as does any op of the
  // contract without a file target.
  const isBoundCallerTarget = (
    targetApp: string,
    targetEntityType: string,
    targetEntityId: string,
  ): boolean => {
    const bound = bridgeOptions?.contractFileTarget
    return (
      bound != null &&
      typeof bridgeOptions?.contractCallerApp === "string" &&
      bound.app === bridgeOptions.contractCallerApp &&
      targetApp === bound.app &&
      targetEntityType === bound.entityType &&
      typeof targetEntityId === "string" &&
      targetEntityId.toLowerCase() === bound.entityId.toLowerCase()
    )
  }

  // Parent-row visibility for an import. The dispatch's bound caller record is checked to exist in
  // this org through a privileged read: the provider runs under its own scopes only, so the caller's
  // row is not visible to it, and the kernel already tied that ONE record to the caller's own params.
  // Every other target is checked under the calling RLS context.
  const parentRowVisible = async (
    query: ReturnType<typeof drizzleSql>,
    boundCallerTarget: boolean,
  ): Promise<boolean> => {
    const { extractRows } = await import("~/db")
    if (!boundCallerTarget) return extractRows<{ id: string }>(await txDb.execute(query)).length > 0
    const { withPrivilegedDb } = await import("~/db/privileged")
    return withPrivilegedDb(
      orgId,
      "files: bound contract caller target",
      async (pdb) => extractRows<{ id: string }>(await pdb.execute(query)).length > 0,
    )
  }

  const methods: Record<string, any> = {
    /**
     * Persist an attachment from an inbound sandbox handler. Body bytes are
     * passed base64-encoded. Returns the created file row JSON.
     *
     * Authorization:
     *  - `targetApp` MUST equal the calling sandbox app (`appName`); apps cannot
     *    write files into other apps' parents.
     *  - `(targetApp, targetEntityType)` MUST be a registered fileParent.
     *  - `targetEntityId` MUST be a UUID and the parent row MUST be visible
     *    under the calling RLS context.
     *  - `bytesBase64` is capped per call (25 MB) and per bridge instance
     *    (35 MB cumulative), mirroring `files_getAttachmentBytes`.
     *  - `mimeType` is rejected if it contains CR/LF.
     */
    files_importAttachment: (() => {
      const PER_CALL_MAX = 25 * 1024 * 1024
      const PER_SEND_MAX = 35 * 1024 * 1024
      // Ledger lives in bridgeOptions when provided (session bridge rebuilds
      // this closure per call — a local counter would reset every invocation
      // and silently void the cross-call cap).
      const ledger = bridgeOptions?.attachmentBytesLedger?.importAttachment ?? { cumulative: 0 }
      const IDENT_RE = /^[a-z][a-z0-9_-]*$/
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      return async (paramsJson: string): Promise<string> => {
        const { randomUUID } = await import("node:crypto")
        const { putObject, sanitizeFilename } = await import("~/infra/storage/object-storage")
        const { resolveParent } = await import("~/modules/files/service")
        const KS = drizzleSql.raw(schemaRef("kernel"))
        const p = JSON.parse(paramsJson) as {
          targetApp: string
          targetEntityType: string
          targetEntityId: string
          filename: string
          mimeType: string
          bytesBase64: string
          disposition?: "inline" | "attachment"
          contentId?: string | null
          ordinal?: number
          callerTargetPass?: string
          /** Downloaded from a provider (files_importFromUrl): no member uploaded it. */
          fromNetwork?: boolean
        }
        const pass = typeof p.callerTargetPass === "string" ? p.callerTargetPass : ""
        const viaPass = pass !== "" && callerTargetPasses.delete(pass)
        if (
          p.targetApp !== appName &&
          !(viaPass && isBoundCallerTarget(p.targetApp, p.targetEntityType, p.targetEntityId))
        ) {
          throw new Error("forbidden: cross-app file import")
        }
        if (!IDENT_RE.test(p.targetApp) || !IDENT_RE.test(p.targetEntityType)) {
          throw new Error("invalid_target")
        }
        if (!UUID_RE.test(p.targetEntityId)) {
          throw new Error("invalid_target_entity_id")
        }
        const parent = resolveParent(orgId, p.targetApp, p.targetEntityType)
        if (!parent) throw new Error("forbidden: unknown parent")
        // Visibility check on the parent row (see parentRowVisible).
        const { schemaRef: sr } = await import("~/db/schema-ref")
        const parentSchema = sr(parent.schemaRef)
        const ps = drizzleSql.raw(`"${parentSchema}"`)
        const pt = drizzleSql.raw(`"${parent.tableName}"`)
        const pj = drizzleSql.raw(`"${parent.joinOn}"`)
        const visible = await parentRowVisible(
          drizzleSql`SELECT ${pj}::text AS id FROM ${ps}.${pt} WHERE ${pj}::text = ${p.targetEntityId} LIMIT 1`,
          p.targetApp !== appName,
        )
        if (!visible) throw new Error("forbidden: parent not visible")
        await assertMailParentNotResetMidRun(p.targetEntityType, p.targetEntityId)
        if (typeof p.mimeType !== "string" || /[\r\n]/.test(p.mimeType)) {
          throw new Error("invalid_mime_type")
        }
        const received = Buffer.from(p.bytesBase64, "base64")
        if (received.byteLength > PER_CALL_MAX) {
          throw new Error("file_too_large")
        }
        if (ledger.cumulative + received.byteLength > PER_SEND_MAX) {
          throw new Error("file_too_large")
        }
        // The org's storage quota, before any byte is stored: a call a person or an
        // agent starts is refused at the quota. Mail sync and other system ingest,
        // and a legal record's file, are stored anyway (and still counted).
        const { loadOrgSettings, noteStoredOrgUsage, storageQuotaExemption, wouldExceedOrgQuota } =
          await import("~/modules/files/service")
        const { withPrivilegedReusing } = await import("~/db/privileged")
        const exemption = storageQuotaExemption({
          actorType: auditActorType,
          actingAgentId: bridgeActingAgentId,
          parent,
        })
        if (
          exemption === null &&
          (await withPrivilegedReusing(txDb, orgId, "files_importAttachment quota", async (qtx) =>
            wouldExceedOrgQuota(qtx, orgId, await loadOrgSettings(qtx, orgId), received.byteLength),
          ))
        ) {
          throw Object.assign(
            new Error(
              "storage_quota_exceeded: the organization's storage limit is reached; the file was not saved",
            ),
            { code: "STORAGE_QUOTA_EXCEEDED" },
          )
        }
        const fileId = randomUUID()
        // Virus scan when the operator runs clamd (CLAMAV_HOST); off, a no-op.
        // An infected attachment is replaced by a text notice and the original
        // kept under a quarantine key, sealed like the mailbox's own files when
        // the mailbox is end-to-end encrypted (lib/clamav.ts).
        const { quarantineStorageKey, scanInboundAttachment } = await import("~/lib/clamav")
        const scan = await scanInboundAttachment(
          { filename: p.filename || "attachment", mimeType: p.mimeType, bytes: received },
          { orgId, where: p.targetApp },
        )
        const bytes = Buffer.from(scan.attachment.bytes)
        const mimeType = scan.attachment.mimeType
        const disposition = scan.quarantined ? "attachment" : (p.disposition ?? "attachment")
        const safeName = sanitizeFilename(scan.attachment.filename)
        const storageKey = `orgs/${orgId}/${p.targetApp}/${p.targetEntityType}/${p.targetEntityId}/${fileId}/${safeName}`
        // Attachment sealing, HOST SIDE (spec section 5.8, Task 7.2). This is
        // deliberately not a new sandbox-facing surface: the handler still hands
        // us base64 and never sees a key. When the owning mailbox is a personal
        // one whose owner holds an active identity, what reaches the bucket is
        // STREAM ciphertext, and the row carries the envelope the owner's
        // browser needs to open it. `null` means "not mailbox content"; a
        // mailbox that must be sealed but cannot be THROWS here rather than
        // storing readable bytes.
        const { maybeSealAttachmentForMail } = await import(
          "~/modules/mailbox-crypto/attachment-seal"
        )
        const sealed = await maybeSealAttachmentForMail({
          tx: txDb,
          schemaName,
          app: p.targetApp,
          entityType: p.targetEntityType,
          entityId: p.targetEntityId,
          orgId,
          userId,
          fileId,
          bytes,
        })
        await putObject({
          key: storageKey,
          body: sealed ? sealed.body : bytes,
          contentType: mimeType,
        })
        if (scan.quarantined) {
          const quarantineId = randomUUID()
          const quarantineKey = quarantineStorageKey(
            orgId,
            quarantineId,
            sanitizeFilename(p.filename || "attachment"),
          )
          const sealedOriginal = await maybeSealAttachmentForMail({
            tx: txDb,
            schemaName,
            app: p.targetApp,
            entityType: p.targetEntityType,
            entityId: p.targetEntityId,
            orgId,
            userId,
            fileId: quarantineId,
            bytes: received,
          })
          await putObject({
            key: quarantineKey,
            body: sealedOriginal ? sealedOriginal.body : received,
            contentType: "application/octet-stream",
          })
          const { emitSecurityEvent } = await import("~/modules/security/security-events")
          await emitSecurityEvent({
            kind: "malware_quarantined",
            orgId,
            detail: {
              where: p.targetApp,
              entityType: p.targetEntityType,
              entityId: p.targetEntityId,
              signature: scan.signature,
              quarantineKey,
              sealed: sealedOriginal !== null,
            },
          })
        }
        ledger.cumulative += received.byteLength
        const contentId =
          p.contentId && !scan.quarantined
            ? p.contentId.replace(/^<+/, "").replace(/>+$/, "").trim() || null
            : null
        const originalContentId = scan.quarantined ? null : (p.contentId ?? null)
        // Resolve a real uploader user id when available; otherwise leave NULL
        // for system-ingested files (FK is nullable in schema).
        const UUID_USER_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        // A file downloaded from a provider (`files_importFromUrl`) came from
        // outside the org, whoever's run fetched it (modules/files/origin.ts).
        const uploaderId = p.fromNetwork !== true && UUID_USER_RE.test(userId) ? userId : null
        // kernel.files is FORCE RLS with NO liaison_rls INSERT policy ("INSERT/
        // DELETE are kernel-only; liaison_admin BYPASSRLS handles them"). When
        // this bridge runs under a SYSTEM/privileged tx (inbound mail/ticket
        // attachment sync) the INSERT on txDb succeeds; but when an AGENT calls a
        // tool that materializes a file (e.g. mail:export_conversations, scope
        // mail:conversations:read), txDb is the RLS-restricted connection and the
        // INSERT is silently denied → HTTP 500. Authorization for the write is the
        // parent-visibility RLS check above (the caller proved it can see the
        // destination parent under its own RLS); the row insert itself is a
        // kernel-privileged operation. So perform the INSERT under a privileged
        // DB context — mirroring files_attachToParent, which already routes its
        // kernel.files copy through withPrivilegedDb for the same reason.
        await withPrivilegedReusing(
          txDb,
          orgId,
          "files_importAttachment kernel.files insert",
          async (pdb) => {
            await pdb.execute(drizzleSql`
            INSERT INTO ${KS}.files
              (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
               storage_key, uploaded_by, disposition, content_id, original_content_id, ordinal,
               enc_version, content_key_wrapped, content_key_epk, enc_key_id, chunk_size,
               chunk_count, plaintext_length, nonce_prefix)
            VALUES (
              ${fileId}, ${orgId}, ${p.targetApp}, ${p.targetEntityType}, ${p.targetEntityId},
              ${safeName}, ${mimeType}, ${bytes.byteLength},
              ${storageKey}, ${uploaderId}, ${disposition}, ${contentId}, ${originalContentId}, ${p.ordinal ?? 0},
              ${sealed?.columns.encVersion ?? 0}, ${sealed?.columns.contentKeyWrapped ?? null},
              ${sealed?.columns.contentKeyEpk ?? null}, ${sealed?.columns.encKeyId ?? null},
              ${sealed?.columns.chunkSize ?? null}, ${sealed?.columns.chunkCount ?? null},
              ${sealed?.columns.plaintextLength ?? null}, ${sealed?.columns.noncePrefix ?? null}
            )
          `)
            // Standard kernel `file:create` event (same shape as files/service.ts
            // upload) so event consumers — the thumbnail pipeline — fire for
            // bridge-imported attachments (mail ingest goes through this path).
            await pdb.queueEvent({
              app: "kernel",
              entity: "file",
              action: "create",
              entityId: fileId,
              orgId,
              actorId: uploaderId ?? "00000000-0000-0000-0000-000000000000",
              actorType: uploaderId ? "user" : "system",
              // A11: a privileged handle of its own, so the bridge's captured
              // agent is named here rather than read from a frame this callback
              // does not have.
              agentId: bridgeActingAgentId,
              data: {
                id: fileId,
                app: p.targetApp,
                entityType: p.targetEntityType,
                entityId: p.targetEntityId,
                filename: safeName,
                mimeType,
                sizeBytes: bytes.byteLength,
                storageKey,
              },
            })
            await noteStoredOrgUsage(pdb, orgId)
          },
        )
        const { createHash: hashOf } = await import("node:crypto")
        return JSON.stringify({
          id: fileId,
          filename: safeName,
          mimeType,
          sizeBytes: bytes.byteLength,
          // The stored plaintext's fingerprint, so an app that cannot hold binary bytes (an
          // import from a URL) can still record what it stored.
          sha256: hashOf("sha256").update(bytes).digest("hex"),
          storageKey,
          disposition,
          contentId,
          ...(scan.quarantined ? { quarantined: { signature: scan.signature } } : {}),
        })
      }
    })(),

    /**
     * Import a file the app's UPSTREAM API points at (a fresh signed URL — e.g.
     * a Boxtal shipping-label PDF) onto one of the calling app's OWN parents,
     * downloading HOST-SIDE. The sandbox `fetch` primitive decodes bodies as
     * UTF-8 text, so a sandboxed app cannot pull binary bytes itself; this
     * bridge is the binary-safe path: same target validation + kernel.files
     * insert as `files_importAttachment`, same egress policy as `ctx.fetch`
     * (app-manifest domain allowlist + private-net protection + DNS pinning via
     * `fetchWithPinnedHost`, re-validated on every redirect hop). The bytes
     * are stored by `files_importAttachment` itself (size ledger, mailbox
     * sealing, disposition, content id, ordinal). An upstream that needs the
     * app's credential takes it in `headers`; one that wraps the file in JSON
     * names the base64 field in `jsonBase64Field`.
     */
    files_importFromUrl: async (argsJson: string): Promise<string> => {
      const PER_CALL_MAX = 25 * 1024 * 1024
      const IDENT_RE = /^[a-z][a-z0-9_-]*$/
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const { resolveParent } = await import("~/modules/files/service")
      const p = JSON.parse(argsJson) as {
        targetApp: string
        targetEntityType: string
        targetEntityId: string
        url: string
        filename: string
        mimeType?: string
        /** Opt-in: clear every PDF page's /Rotate flag before storing. For
         *  print-destined imports (carrier labels) whose generator stamps a
         *  spurious rotation that makes viewers AND printers render the
         *  content sideways (Boxtal FedEx labels, prod 2026-07-20). */
        pdfStripRotation?: boolean
        /** Request headers for the upstream, `IMPORT_HEADER_ALLOWLIST` only. */
        headers?: Record<string, string>
        /**
         * A connection credential the host adds, as `ctx.fetch`'s `auth`
         * (fetch-auth.ts): the app never holds the token. Only to a host of that
         * connection's own domains; never with an `authorization` header.
         */
        auth?: unknown
        /** The response is JSON carrying the file as base64/base64url in this field. */
        jsonBase64Field?: string
        disposition?: "inline" | "attachment"
        contentId?: string | null
        ordinal?: number
        /**
         * `"first-hop-only"`: `headers` (the credential) go to the first host only; redirects
         * are followed with no request headers; every hop's host must be an EXACT allow-list
         * entry (a `*.` wildcard entry never matches in this mode). For an upstream that answers
         * with a redirect to a storage host (presigned URL) that must never see the token.
         */
        credentials?: "first-hop-only"
        /** Per-call budget for the whole download (default 60 s, at most 120 s). */
        timeoutMs?: number
      }
      // A provider-contract op with a file target may store onto that one CALLER record (the
      // caller handed it over in the dispatch); any other cross-app target is refused.
      if (
        p.targetApp !== appName &&
        !isBoundCallerTarget(p.targetApp, p.targetEntityType, p.targetEntityId)
      ) {
        throw new Error("forbidden: cross-app file import")
      }
      if (!IDENT_RE.test(p.targetApp) || !IDENT_RE.test(p.targetEntityType)) {
        throw new Error("invalid_target")
      }
      if (!UUID_RE.test(p.targetEntityId)) {
        throw new Error("invalid_target_entity_id")
      }
      if (p.credentials !== undefined && p.credentials !== "first-hop-only") {
        throw new Error("invalid_credentials_mode")
      }
      const firstHopOnly = p.credentials === "first-hop-only"
      const parent = resolveParent(orgId, p.targetApp, p.targetEntityType)
      if (!parent) throw new Error("forbidden: unknown parent")
      {
        const { schemaRef: sr } = await import("~/db/schema-ref")
        const parentSchema = sr(parent.schemaRef)
        const ps = drizzleSql.raw(`"${parentSchema}"`)
        const pt = drizzleSql.raw(`"${parent.tableName}"`)
        const pj = drizzleSql.raw(`"${parent.joinOn}"`)
        const visible = await parentRowVisible(
          drizzleSql`SELECT ${pj}::text AS id FROM ${ps}.${pt} WHERE ${pj}::text = ${p.targetEntityId} LIMIT 1`,
          p.targetApp !== appName,
        )
        if (!visible) throw new Error("forbidden: parent not visible")
      }
      await assertMailParentNotResetMidRun(p.targetEntityType, p.targetEntityId)
      // Same egress policy as `ctx.fetch`: allowlist + no-DNS validation now,
      // pinned-host fetch (single resolution, private-IP reject, per-hop
      // allowlist re-check) for the actual download.
      const allowPrivateHostsInTest = manifest.network?.allowPrivateHostsInTest ?? false
      // The declared hosts the install row granted (context.ts collectAllowedDomains).
      const { allowedDomains } = await ctx.egress()
      // first-hop-only: each hop host must be listed exactly (no wildcard reach).
      const exactHost = (u: string | URL) => {
        const host = new URL(u).hostname
        if (!allowedDomains.some((d) => !d.startsWith("*.") && d === host)) {
          throw new Error(`Domain not in allowlist (exact host required): ${host}`)
        }
      }
      if (firstHopOnly) exactHost(p.url)
      await validateSandboxFetchUrl(p.url, allowedDomains, allowPrivateHostsInTest, appName)
      // Request headers are limited to credentials and content negotiation for
      // the allowlisted upstream (`ctx.fetch` sends the same bearer to the same
      // hosts). A credentialed request never follows a redirect, so the token
      // cannot be carried to a host it was not issued for.
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(p.headers ?? {})) {
        if (!IMPORT_HEADER_ALLOWLIST.has(name.toLowerCase())) {
          throw new Error(`invalid_header: ${name}`)
        }
        if (typeof value !== "string" || /[\r\n]/.test(value)) {
          throw new Error(`invalid_header: ${name}`)
        }
        headers[name] = value
      }
      if (p.auth !== undefined && p.auth !== null) {
        if (Object.keys(headers).some((h) => h.toLowerCase() === "authorization")) {
          throw new Error("invalid_header: authorization is set by auth")
        }
        const [{ parseFetchAuth, injectFetchAuth }, { createFetchAuthDeps }] = await Promise.all([
          import("~/modules/apps/sandbox/bridge/fetch-auth"),
          import("~/modules/apps/sandbox/bridge/egress"),
        ])
        const auth = parseFetchAuth(p.auth)
        if (auth?.exchange) throw new Error("invalid_auth: a download takes no token exchange")
        if (auth?.grant)
          throw new Error("invalid_auth: a download takes no client credentials grant")
        if (auth?.scheme.startsWith("query:")) {
          throw new Error("invalid_auth: a download sends its credential in a header")
        }
        const { manifest: granted } = await ctx.egress()
        const deps = createFetchAuthDeps(ctx, async () => {
          throw new Error("invalid_auth: a download takes no token exchange")
        })
        if (auth) await injectFetchAuth(p.url, headers, auth, { ...deps, manifest: granted })
      }
      const credentialed = Object.keys(headers).some((h) => h.toLowerCase() === "authorization")
      const timeoutMs = Math.min(Math.max(Number(p.timeoutMs) || 60_000, 1_000), 120_000)
      const hops: Array<{ host: string; status: number }> = []
      // DEMO INSTANCE ONLY, the gate `ctx.fetch` applies (egress.ts): a demo org's download from
      // a Boxtal host (its booking's specimen label) is answered in-process and never put on the
      // wire. One module-local boolean on a normal deployment.
      // The card-payments stand-in too: a demo org's download from the payments host is answered
      // (or refused) in-process, whatever app asks.
      const demoResponse =
        (await maybeDemoBoxtalResponse({
          orgId,
          url: p.url,
          method: "GET",
          body: undefined,
          headers,
        })) ??
        (await maybeDemoPaymentsResponse({
          orgId,
          appName,
          allowedDomains,
          url: p.url,
          method: "GET",
          body: undefined,
          headers,
        }))
      const response =
        demoResponse ??
        (await fetchWithPinnedHost(
          p.url,
          { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) },
          {
            // A credentialed request follows redirects only in first-hop-only mode, where the
            // headers are dropped after the first host.
            maxRedirects: credentialed && !firstHopOnly ? 0 : SANDBOX_FETCH_MAX_REDIRECTS,
            headersOnFirstHopOnly: firstHopOnly,
            fetchImpl: sandboxEgressOverrides.fetch ?? undefined,
            ...sandboxEgressPolicy(appName),
            allowPrivateHostsInTest,
            onHopValidate: async (next) => {
              if (firstHopOnly) exactHost(next)
              validateSandboxFetchUrl(next, allowedDomains, allowPrivateHostsInTest, appName)
            },
            onHopResponse: (h) => {
              hops.push({ host: h.url.hostname, status: h.status })
            },
          },
        ))
      if (!response.ok) {
        throw new Error(`import_fetch_failed: upstream returned ${response.status}`)
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "")
      if (Number.isFinite(declaredLength) && declaredLength > PER_CALL_MAX) {
        await response.body?.cancel().catch(() => {})
        throw new Error("file_too_large")
      }
      let bytes: Buffer
      if (typeof p.jsonBase64Field === "string" && p.jsonBase64Field) {
        // The upstream wraps the file in JSON as a base64 or base64url string
        // (Gmail `attachments.get` returns `{ size, data }`). Decoded here so
        // the file never has to pass through the sandbox heap or its 1 MB
        // response cap.
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
        const encoded = body?.[p.jsonBase64Field]
        if (typeof encoded !== "string" || encoded.length === 0) {
          throw new Error("import_fetch_failed: empty body")
        }
        bytes = Buffer.from(encoded, "base64url")
      } else if (response.body) {
        // Streamed under the cap: an upstream that lies about (or omits) its length is cut off
        // at 25 MB instead of being buffered whole.
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > PER_CALL_MAX) {
            await reader.cancel().catch(() => {})
            throw new Error("file_too_large")
          }
          chunks.push(value)
        }
        bytes = Buffer.concat(chunks)
      } else {
        bytes = Buffer.from(await response.arrayBuffer())
      }
      if (bytes.byteLength === 0) throw new Error("import_fetch_failed: empty body")
      if (firstHopOnly) {
        // Audit line: hosts, size, fingerprint, statuses. Never headers, never the URL's query
        // (a presigned URL's signature), never the body.
        const { createHash } = await import("node:crypto")
        const { rootLogger } = await import("~/lib/logger")
        rootLogger.child({ module: "sandbox-egress" }).info(
          {
            app: appName,
            orgId,
            hops,
            size: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          "files_importFromUrl: first-hop-only download",
        )
      }
      if (p.pdfStripRotation === true) {
        const { stripPdfRotation } = await import("~/modules/pdf/normalize")
        bytes = await stripPdfRotation(bytes)
      }
      if (bytes.byteLength > PER_CALL_MAX) throw new Error("file_too_large")
      const mimeType =
        typeof p.mimeType === "string" && p.mimeType && !/[\r\n]/.test(p.mimeType)
          ? p.mimeType
          : (response.headers.get("content-type")?.split(";")[0]?.trim() ??
            "application/octet-stream")
      if (/[\r\n]/.test(mimeType)) throw new Error("invalid_mime_type")
      // Stored through the same path as an inbound attachment: one size ledger,
      // one kernel.files insert, and the mailbox sealing a personal mailbox's
      // file must get before it reaches the bucket.
      const { randomUUID: mintPass } = await import("node:crypto")
      const callerTargetPass = p.targetApp !== appName ? mintPass() : undefined
      if (callerTargetPass) callerTargetPasses.add(callerTargetPass)
      return await methods.files_importAttachment(
        JSON.stringify({
          ...(callerTargetPass ? { callerTargetPass } : {}),
          targetApp: p.targetApp,
          targetEntityType: p.targetEntityType,
          targetEntityId: p.targetEntityId,
          filename: p.filename || "attachment",
          mimeType,
          bytesBase64: bytes.toString("base64"),
          disposition: p.disposition ?? "attachment",
          contentId: p.contentId ?? null,
          ordinal: p.ordinal ?? 0,
          fromNetwork: true,
        }),
      )
    },

    /**
     * Copy a file the calling sandbox can see onto one of its OWN app parents.
     * The destination app MUST equal the calling sandbox app (mirrors the
     * `files_importAttachment` cross-app guard); the SOURCE may be any file
     * visible under the caller's RLS context (a ticket attachment, knowledge
     * doc, Drive-imported file, gated-op output). Delegates all validation —
     * RLS read-check, file-type denylist, write-scope, quota, idempotency —
     * to the generic `attachFileToParent` service.
     */
    files_attachToParent: async (argsJson: string): Promise<string> => {
      const p = JSON.parse(argsJson) as {
        sourceFileId: string
        targetApp: string
        targetEntityType: string
        targetEntityId: string
      }
      if (p.targetApp !== appName) {
        throw new Error("forbidden: cross-app file attach")
      }
      await assertMailParentNotResetMidRun(p.targetEntityType, p.targetEntityId)
      const { attachFileToParent } = await import("~/modules/files/attach")
      const { withPrivilegedReusing } = await import("~/db/privileged")
      const { withReleasedSavepoint } = await import("~/db/savepoint")
      // The destination is ALWAYS this bridge's OWN app (enforced just above), so
      // the destination write-scope check must run under this app's OPERATING
      // scopes, not the original caller's attribution scopes. They differ on the
      // cross-app path: when app B invokes this app via an install-approved
      // cross-app call, the RLS/operating actor is `${appName}:*` (data-visibility
      // switches to the target app) while `callerScopes` stays B's scopes for
      // attribution. Using B's scopes here wrongly fails closed —
      // e.g. invoicing's gated `documents_send_to_customer` → `mail:compose`
      // staging the PDF on mail's `outbound_staging` (writeScope
      // `mail:conversations:write`, which invoicing's caller never holds) →
      // `Forbidden: missing write scope on destination` ([[BL-186]]). The
      // operating scopes live on the bridge actor (`inheritedActor.scopes`):
      // `${appName}:*` cross-app, the user's real scopes on the direct path
      // (so a direct agent still genuinely needs the destination write scope —
      // no behavior change there). The source read stays RLS-gated (attach step
      // 1), so this only authorizes attaching a readable file onto THIS app's
      // own surface under an already-authorized dispatch.
      const operatingScopes = inheritedActor.scopes ?? callerScopes ?? []
      const res = await attachFileToParent(
        {
          sourceFileId: p.sourceFileId,
          target: {
            app: p.targetApp,
            entityType: p.targetEntityType,
            entityId: p.targetEntityId,
          },
        },
        {
          rlsTx: txDb,
          // On the bridge's transaction when it already is a privileged one of
          // this org (a headless sync), in a driver savepoint so a lost unique
          // race on the copy rolls back alone; else on its own transaction.
          privileged: (reason, fn) =>
            withPrivilegedReusing(txDb, orgId, reason, (tx) =>
              Object.is(tx, txDb) ? withReleasedSavepoint(tx, fn) : fn(tx),
            ),
          orgId,
          userId,
          // Carry the real actor category so the audit `file:create` event is
          // not mis-recorded as a human upload (agents run as a user). This is
          // the AUDIT half of X10's split: `attachFileToParent` reads it for
          // nothing but the emitted event, so nothing about the write moves.
          actorType: auditActorType,
          scopes: operatingScopes,
        },
      )
      return JSON.stringify(res)
    },

    /**
     * Move files the calling sandbox app owns from one of its entities to
     * another (e.g. an outbound-send handler relinking staged attachment
     * copies onto the persisted message once its id is known). Scoped to the
     * calling app + org — a sandbox cannot touch another app's files.
     *
     * The destination is validated exactly like `files_importAttachment`: it
     * must be a registered `fileParent` of THIS app, its entity id must be a
     * UUID, and the parent row must be visible under RLS. Without this a buggy
     * handler could relocate files onto an arbitrary or non-existent entity id
     * — changing their RLS visibility or orphaning them outside the projection.
     */
    files_reparent: async (argsJson: string): Promise<string> => {
      const p = JSON.parse(argsJson) as {
        fileIds: string[]
        targetEntityType: string
        targetEntityId: string
      }
      if (!Array.isArray(p.fileIds) || p.fileIds.length === 0) {
        return JSON.stringify({ moved: 0 })
      }
      const IDENT_RE = /^[a-z][a-z0-9_-]*$/
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!IDENT_RE.test(p.targetEntityType)) {
        throw new Error("invalid_target")
      }
      if (!UUID_RE.test(p.targetEntityId)) {
        throw new Error("invalid_target_entity_id")
      }
      const { resolveParent } = await import("~/modules/files/service")
      const parent = resolveParent(orgId, appName, p.targetEntityType)
      if (!parent) throw new Error("forbidden: unknown destination parent")
      // RLS visibility check on the destination parent row.
      const parentSchema = schemaRef(parent.schemaRef)
      const ps = drizzleSql.raw(`"${parentSchema}"`)
      const pt = drizzleSql.raw(`"${parent.tableName}"`)
      const pj = drizzleSql.raw(`"${parent.joinOn}"`)
      const vis = extractRows<{ id: string }>(
        await txDb.execute(
          drizzleSql`SELECT ${pj}::text AS id FROM ${ps}.${pt} WHERE ${pj}::text = ${p.targetEntityId} LIMIT 1`,
        ),
      )
      if (vis.length === 0) throw new Error("forbidden: destination parent not visible")
      await assertMailParentNotResetMidRun(p.targetEntityType, p.targetEntityId)
      const { withPrivilegedDb } = await import("~/db/privileged")
      const KS = drizzleSql.raw(schemaRef("kernel"))
      const requested = drizzleSql.join(
        p.fileIds.map((id) => drizzleSql`${String(id)}`),
        drizzleSql`, `,
      )
      // The files moved are the ones the caller can READ where they are now, under
      // the bridge's own transaction: moving a file onto a parent the caller sees
      // changes who can read it, so a file the caller cannot see stays put.
      const readable = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          SELECT id::text AS id FROM ${KS}.files
          WHERE org_id = ${orgId} AND app = ${appName} AND id::text IN (${requested})`),
      ).map((r) => r.id)
      if (readable.length === 0) return JSON.stringify({ moved: 0 })
      const idList = drizzleSql.join(
        readable.map((id) => drizzleSql`${id}`),
        drizzleSql`, `,
      )
      await withPrivilegedDb(orgId, "files:reparent", async (tx) => {
        await tx.execute(drizzleSql`
          UPDATE ${KS}.files
          SET entity_type = ${p.targetEntityType}, entity_id = ${p.targetEntityId}
          WHERE org_id = ${orgId} AND app = ${appName} AND id::text IN (${idList})`)
      })
      return JSON.stringify({ moved: readable.length })
    },

    /**
     * List metadata for files parented to a given (app, entityType, entityId).
     * Used by outbound sandbox handlers to enumerate attachments before
     * fetching each one's bytes via `files_getAttachmentBytes`.
     *
     * `app` is forced to the calling sandbox app — cross-app enumeration is
     * not permitted.
     */
    files_listAttachments: async (parentJson: string): Promise<string> => {
      const KS = drizzleSql.raw(schemaRef("kernel"))
      const p = JSON.parse(parentJson) as {
        app: string
        entityType: string
        entityId: string
      }
      if (p.app !== appName) {
        throw new Error("forbidden: cross-app listing")
      }
      const rows = extractRows<{
        id: string
        filename: string
        mime_type: string
        size_bytes: number | string
        disposition: "inline" | "attachment"
        content_id: string | null
        ordinal: number
        analysis_status: string | null
        analysis_summary: string | null
      }>(
        await txDb.execute(drizzleSql`
          SELECT id::text AS id, filename, mime_type, size_bytes, disposition,
                 content_id, ordinal, analysis_status, analysis_summary
          FROM ${KS}.files
          WHERE app = ${p.app} AND entity_type = ${p.entityType} AND entity_id = ${p.entityId}
            AND org_id = ${orgId}
          ORDER BY ordinal ASC, id ASC
        `),
      )
      return JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          mimeType: r.mime_type,
          sizeBytes: Number(r.size_bytes),
          disposition: r.disposition,
          contentId: r.content_id,
          ordinal: r.ordinal,
          analysisStatus: r.analysis_status,
          analysisSummary: r.analysis_summary,
        })),
      )
    },

    /**
     * Outbound attachment bytes bridge. Returns base64-encoded bytes for a
     * single file gated by:
     *
     *   1. The file row must be visible under the caller's RLS context.
     *   2. The file's `app` must match the calling sandbox app.
     *   3. `allowedParents` is REQUIRED and the file's parent must be in it —
     *      so a handler reads only the specific staged/attachment files of the
     *      send it is performing, never any same-app file in the org.
     *   4. Per-call cap of 25 MB.
     *   5. Per-send cap of 35 MB accumulated across all reads in this bridge
     *      instance.
     */
    files_getAttachmentBytes: (() => {
      const PER_CALL_MAX = 25 * 1024 * 1024
      const PER_SEND_MAX = 35 * 1024 * 1024
      // See files_importAttachment: shared ledger survives per-call rebuilds.
      const ledger = bridgeOptions?.attachmentBytesLedger?.getAttachmentBytes ?? { cumulative: 0 }
      return async (paramsJson: string): Promise<string> => {
        const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
        const KS = drizzleSql.raw(schemaRef("kernel"))
        const p = JSON.parse(paramsJson) as {
          fileId: string
          // REQUIRED — the file's parent must appear here. Without it the only
          // gate would be `row.app === appName`, which grants org-wide same-app
          // file read; the send path must narrow to its own files.
          allowedParents?: Array<{ app: string; entityType: string; entityId: string }>
        }
        if (!p.allowedParents || p.allowedParents.length === 0) {
          throw new Error("forbidden: allowedParents is required")
        }
        const rows = extractRows<{
          id: string
          app: string
          entity_type: string
          entity_id: string
          filename: string
          mime_type: string
          size_bytes: number | string
          storage_key: string
          enc_version: number | string | null
        }>(
          await txDb.execute(drizzleSql`
            SELECT id::text AS id, app, entity_type, entity_id, filename,
                   mime_type, size_bytes, storage_key, enc_version
            FROM ${KS}.files WHERE id = ${p.fileId} AND org_id = ${orgId} LIMIT 1
          `),
        )
        const row = rows[0]
        if (!row) throw new Error("forbidden")
        if (row.app !== appName) {
          throw new Error("forbidden: cross-app bytes read")
        }
        if (p.allowedParents && p.allowedParents.length > 0) {
          const allowed = p.allowedParents.some(
            (a) =>
              a.app === row.app && a.entityType === row.entity_type && a.entityId === row.entity_id,
          )
          if (!allowed) throw new Error("forbidden")
        }
        const result = await getObjectBytes(row.storage_key, { maxBytes: PER_CALL_MAX })
        if (ledger.cumulative + result.bytes.byteLength > PER_SEND_MAX) {
          throw new Error("file_too_large")
        }
        ledger.cumulative += result.bytes.byteLength
        return JSON.stringify({
          filename: row.filename,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          bytesBase64: result.bytes.toString("base64"),
          // Task 9.9. `enc_version > 0` means these bytes are STREAM ciphertext
          // the host cannot open, so a caller that is about to put them in an
          // outgoing message must refuse or ask the mailbox owner's browser for
          // the readable copy. Reporting it is what makes that refusal possible:
          // without this field the send path sees ordinary bytes and mails an
          // unreadable blob while reporting success.
          encVersion: Number(row.enc_version ?? 0),
        })
      }
    })(),

    /**
     * Read one of the calling app's OWN files (a PDF or an image, judged by its bytes) with the org's media-analysis
     * model, answering `prompt`. Declared capability `files.analyzeDocument`.
     *
     * Same path as the agent's `analyze_media`: the demo refusal, the credit pre-check and usage,
     * the size caps, and the org's toggle for the `apps` surface (admins can switch it off;
     * zero spend then). The prompt is the app's own question, so the answer is never stored on
     * the file row (a briefed analysis). The answer is text drawn from the file: the app treats it
     * as outside content and validates whatever it keeps.
     *
     * Only files whose `app` is the caller, in this org and visible under the calling RLS
     * context; never another app's file. Returns `{ text, model }` or `{ error: { code, message } }`.
     */
    files_analyzeDocument: async (paramsJson: string): Promise<string> => {
      requireCapability("files.analyzeDocument")
      const p = JSON.parse(paramsJson || "{}") as { fileId?: unknown; prompt?: unknown }
      const fail = (code: string, message: string) => JSON.stringify({ error: { code, message } })
      const { UUID_RE } = await import("~/lib/uuid")
      if (typeof p.fileId !== "string" || !UUID_RE.test(p.fileId)) {
        return fail("invalid_params", "fileId must be a file id.")
      }
      if (
        typeof p.prompt !== "string" ||
        !p.prompt.trim() ||
        p.prompt.length > ANALYZE_PROMPT_MAX
      ) {
        return fail("invalid_params", `prompt must be 1 to ${ANALYZE_PROMPT_MAX} characters.`)
      }
      const KS = drizzleSql.raw(schemaRef("kernel"))
      const row = extractRows<{ app: string }>(
        await txDb.execute(drizzleSql`
          SELECT app FROM ${KS}.files
          WHERE id = ${p.fileId} AND org_id = ${orgId} LIMIT 1
        `),
      )[0]
      if (!row || row.app !== appName) return fail("not_found", "No such file of this app.")
      const { defaultMediaAnalysisToolDeps, handleAnalyzeMedia } = await import(
        "~/modules/agent/media/media-analysis-tool"
      )
      const result = await handleAnalyzeMedia(
        { fileId: p.fileId, context: p.prompt },
        { orgId, userId, db: txDb },
        defaultMediaAnalysisToolDeps,
        // Judged on the sniffed bytes, not the stored mime type: images and PDFs only, so the
        // slow video job is never reached from this seam.
        { surface: "apps", kinds: ["image", "document"] },
      )
      if ("summary" in result) return JSON.stringify({ text: result.summary, model: result.model })
      if ("error" in result) return JSON.stringify({ error: result.error })
      return fail("unsupported", "This file needs the slow analysis path, which apps cannot use.")
    },
  }
  return methods
}

/** Longest question an app may ask about its own file. */
const ANALYZE_PROMPT_MAX = 2000
