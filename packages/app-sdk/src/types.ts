// SPDX-License-Identifier: FSL-1.1-ALv2
import type { EffectsBridge } from "./effects"
export interface DbClient {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  delete(entity: string, id: string): Promise<void>
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
}

export interface ConnectionClient {
  getToken(identifier?: string): Promise<string>
  getAccounts(): Promise<
    Array<{
      id: string
      ownerType: "user" | "org"
      ownerId: string | null
      identifier: string
      displayName: string | null
    }>
  >
  /**
   * Read this app's credentials-connection map, filtered to the fields declared
   * in `credentialFields`. For a **credentials** connection only — `getToken`
   * throws "No access token stored" because that path reads `accessTokenEncrypted`
   * (empty for credentials connections, whose secrets live in
   * `credentialsEncrypted`). The host enforces the manifest declaration + the
   * caller's RLS actor context. A non-credentials connection returns `{}`.
   */
  getCredentials(identifier?: string): Promise<Record<string, string>>
  /**
   * The NON-SECRET part of a credentials connection: `values` holds the fields
   * the manifest marks `readable: true` (never a `password` field), `missing`
   * names every declared field with no value stored. Works on every executor;
   * send the secrets with `ctx.fetch(url, { auth })` instead of reading them.
   */
  getSettings(identifier?: string): Promise<ConnectionSettings>
}

export interface ConnectionSettings {
  values: Record<string, string>
  missing: string[]
}

/**
 * A credential the host adds to a `ctx.fetch` request, so app code never holds
 * it. Only sent to a host of that connection's own `allowedDomains`; every
 * injected value is redacted from the answer.
 *
 * - `"header:<Name>"`: the header carries the oauth2 connection's token, or for a
 *   credentials connection the one field in `fields`.
 * - `"bearer"`: `Authorization: Bearer <token or field>`; with `exchange`, a
 *   client-credentials token the host obtains (Basic of `exchange.fields` POSTed
 *   to `exchange.url`), caches until shortly before it expires, and drops on a
 *   401 answer so a retry exchanges again.
 * - `"basic"`: `Authorization: Basic base64(fields[0]:fields[1])` of a credentials
 *   connection.
 */
export interface FetchAuth {
  connection: string
  /** Which account, as for `getToken(identifier)`. */
  identifier?: string
  scheme: `header:${string}` | "bearer" | "basic"
  fields?: string[]
  exchange?: {
    url: string
    method?: "POST" | "GET"
    fields: [string, string]
    /** Default `accessToken`. */
    tokenField?: string
    /** Seconds; default `expiresIn`. */
    expiresInField?: string
  }
}

export interface Logger {
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
  debug(msg: string, data?: unknown): void
}

/** What `ctx.time.civil` answers: the date and clock a person in `zone` reads at that instant. */
export interface CivilTime {
  /** `YYYY-MM-DD` */
  date: string
  year: number
  month: number
  day: number
  /** 0 to 23 */
  hour: number
  minute: number
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number
  /** The zone the answer was computed in. */
  zone: string
}

export interface AppContext {
  userId: string
  orgId: string
  db: DbClient
  emit(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    /**
     * Optional top-level metadata used by the kernel attention translator's
     * axis-extraction (e.g. `{ market: "EU", currency: "EUR" }`). Recipient
     * resolvers read string/number/boolean values from `event.metadata` and
     * match them against user attention rules' `filters` map.
     */
    metadata?: Record<string, unknown>
  }): Promise<void>
  enqueueJob(jobName: string, payload: unknown): Promise<void>
  resolveContact(params: {
    email?: string
    name?: string
    externalId?: string
    /**
     * I11 — when set with `externalId`, instead of resolving/creating a
     * contact, the kernel removes this app's entry from
     * `kernel.contacts.external_ids.<callingApp>` for any contact carrying
     * that external id. The contact row itself is preserved. Returns
     * `{ cleared: <count> }` when used in this mode.
     */
    clear?: boolean
  }): Promise<unknown>
  connections: Record<string, ConnectionClient>
  /**
   * List this app's externally-linked `kernel.contacts`, keyset-paginated by
   * contact id. Each entry carries the calling app's own external id (the value
   * stored under `kernel.contacts.external_ids.<callingApp>`), or `null` when
   * the contact has no external id for this app. `nextCursor` is `null` when the
   * final page has been reached; otherwise pass it back as `cursor` to fetch the
   * next page. The kernel bridge implements this (see `rpc-bridge.ts`
   * `findKernelContactsByExternalId`); the Shopify reconcile job consumes it.
   */
  listContactsByExternalId(
    limit?: number,
    cursor?: string,
  ): Promise<{
    contacts: Array<{ id: string; externalId: string | null }>
    nextCursor: string | null
  }>
  /**
   * Outbound HTTP to a host the manifest allows. `body` is a string, or `{multipart}`: the host
   * assembles a multipart/form-data body from text fields and files the app may read (by kernel
   * file id; up to 25 MB; a part may pin `expectSha256`), and the answer then carries `upload`
   * (each part's size and SHA-256). `timeoutMs` may only tighten the default, except for a
   * multipart upload, which may ask for up to 120 s.
   */
  fetch(
    url: string,
    opts?: {
      method?: string
      headers?: Record<string, string>
      body?: string | { multipart: FetchMultipartPart[] }
      timeoutMs?: number
      /** A connection credential the host adds (see `FetchAuth`). */
      auth?: FetchAuth
      /**
       * `{ "<placeholder>": "<config key>" }`: the host writes each declared config
       * secret into the string body where its placeholder (12 to 128 characters)
       * stands, verbatim. Only to a host of the connection that declares the key.
       */
      configSecrets?: Record<string, string>
    },
  ): Promise<{
    status: number
    headers: Record<string, string>
    body: string
    upload?: {
      size: number
      parts: Array<{ name: string; size: number; sha256: string; fileId?: string }>
    }
  }>
  logger: Logger
  /**
   * Read-only accessor over the app's kernel-managed `apps.config` store. Used
   * by a credentials-connection app's connect handler to read the
   * kernel-minted webhook secret (declared via `webhookSecretConfigKey`) and
   * forward it to the provider's subscription API. There is no write
   * counterpart — the kernel owns config mutation.
   */
  config: {
    get(key: string): Promise<unknown>
    /** Whether `key` holds a value; for a secret, without reading it. */
    has(key: string): Promise<boolean>
    /**
     * Store a secret the PROVIDER minted (returned once by its API) under a key the manifest
     * declares in `connections.<c>.appSecretConfigKeys`. Encrypted by the kernel; read back only
     * through `get` (and the app's webhook verifier). Never put it in a tool result.
     */
    setSecret(key: string, value: string): Promise<void>
  }
  /**
   * Invoke the kernel agent runtime. Requires the `agent.run` capability
   * declared in `app.manifest.json`. Streams agent parts to `params.channel`
   * (must be under `apps/<appName>/`) and returns the finalized result.
   *
   * `paramsJson` must be `JSON.stringify` of:
   *   `{ threadId: string; prompt: string; modelId?: string|null; channel?: string }`.
   * Returns `JSON.stringify` of either
   *   `{ result: { messageId, creditCost, finishReason }, userMessageId: string }`
   * or `{ error: { code, message, retryable } }`.
   *
   * Flat shape (not `ctx.agent.run`) matches the runtime convention used by
   * existing apps' `SandboxCtx` interfaces (mail, tickets).
   */
  agent_run(paramsJson: string): Promise<string>
  /**
   * Publish a message to a Redis pub/sub channel under the app's namespace.
   * Requires the `realtime.publish` capability declared in
   * `app.manifest.json`. `channel` must start with `apps/<appName>/`; the
   * host adds the Redis key prefix and the calling org, so `apps/<appName>/x`
   * is published on `<prefix>apps/<appName>/orgs/<orgId>/x`. A subscriber
   * listens on that org-scoped name.
   *
   * Returns `JSON.stringify` of `{ ok: true }` or `{ error: {...} }`.
   */
  realtime_publish(channel: string, payloadJson: string): Promise<string>
  /**
   * Set the Liaison-side scopes a user holds within the calling app's own
   * namespace (e.g. an admin tool in the Shopify app grants
   * `shopify:refunds:create` to a teammate). Requires the
   * `grants.setUserScopes` capability declared in `app.manifest.json`. The
   * kernel forces the namespace from the calling app's authenticated name;
   * scopes outside `<appName>:*` throw. Diff is recorded in
   * `kernel.app_scope_grant_audit`.
   *
   * `scopesJson` is `JSON.stringify` of `string[]` — the *full* set of
   * in-namespace scopes the user should hold after the call (replace
   * semantics within the namespace). Returns `JSON.stringify` of
   * `{ ok: true }` or `{ error: {...} }`.
   */
  grants_setUserScopes(userId: string, scopesJson: string): Promise<string>
  /**
   * Bulk-blob primitive (Phase 16 Task A7). Requires the `bulk.fetch`
   * capability declared in `app.manifest.json`. Use this to ingest large
   * bulk-operation result URLs (e.g. Shopify's bulk operations) without
   * violating the sandbox memory envelope: the host streams the URL to a
   * temp file under a per-org quota and exposes a host-paginated async
   * iterator.
   *
   *   const { blobId, sizeBytes } = await ctx.bulk.fetchToBlob(url, { headers })
   *   for await (const batch of ctx.bulk.iterateJsonl(blobId, { batchSize: 50 })) { … }
   *   await ctx.bulk.deleteBlob(blobId)
   *
   * Broken JSONL lines yield an in-band sentinel
   *   `{ __error: "JsonlParseError", line: <raw>, batchIndex: <n> }`
   * and iteration continues — callers decide whether to abort.
   */
  bulk: {
    fetchToBlob(
      url: string,
      opts?: { headers?: Record<string, string> },
    ): Promise<{ blobId: string; sizeBytes: number }>
    iterateJsonl(blobId: string, opts?: { batchSize?: number }): AsyncIterable<unknown[]>
    deleteBlob(blobId: string): Promise<void>
  }
  /**
   * K1 — Post an app-originated message into a thread. Exactly one of
   * `thread_id` or `contact_id` must be set. Requires `messages.post`
   * capability declared in `app.manifest.json`. The kernel stamps the
   * resulting message with `origin_app_id` = calling app and
   * `origin_kind = "app_post"`.
   */
  messages: {
    post(params: {
      thread_id?: string
      contact_id?: string
      body: string
      attachment_file_ids?: string[]
      metadata?: Record<string, unknown>
    }): Promise<{ message_id: string; thread_id: string }>
  }
  /**
   * K2 — Render a PDF host-side from a template declared in
   * `app.manifest.json#pdf_templates`. Requires the `pdf.render` capability.
   * The resulting file is stored in the kernel files module under the
   * calling app's ownership. `pdf_a3` defaults to true (10-year legal
   * archival; pdf-lib + Ghostscript normalization pass).
   */
  pdf: {
    render(params: {
      template_kind: string
      data: Record<string, unknown>
      pdf_a3?: boolean
      /**
       * Optional download name for the stored file (e.g. an invoice number).
       * Sanitised host-side and forced to a single `.pdf` extension. When
       * omitted, the file is named after the template kind
       * (`invoicing_invoice_v1.pdf`); pass a real name when the document has an
       * identity a human will download.
       */
      filename?: string
      /**
       * Optionally LINK the rendered file onto one of the calling app's OWN
       * rows, in the SAME committed transaction the host uses to write the file
       * row. `table`/`column` MUST be a field the app declares in its manifest
       * schema (the host validates + rejects anything else — no cross-app or
       * arbitrary writes); `row_id` is the row whose `column` is set to the new
       * file id. Use this when the rendered file must be visible to a
       * subsequent CROSS-APP reader before the calling handler's own tx commits
       * — e.g. invoicing's on-demand `documents_send_to_customer` render must
       * commit `documents.pdf_file_id` before `mail:composeForApp` reads the PDF
       * (whose RLS visibility joins on that column), or the send fails closed
       * with "Source file not visible to caller" ([[BL-191]]).
       */
      link?: { table: string; column: string; row_id: string }
      /**
       * Produce a PDF/A-3B file natively: XMP metadata, sRGB OutputIntent, embedded fonts only,
       * trailer ID, plus the associated files and XMP extension schemas below. Replaces the
       * best-effort `pdf_a3` normalisation for that call.
       */
      pdfa?: "3b"
      /** Associated files embedded in the PDF/A-3 (at most 4, 5 MB each), bytes as base64. */
      attachments?: Array<{
        name: string
        mime: string
        bytesBase64: string
        afRelationship: "Data" | "Source" | "Alternative" | "Supplement" | "Unspecified"
        description?: string
      }>
      /** XMP extension schemas; each is declared in a pdfaExtension description automatically. */
      xmp?: {
        extensions: Array<{
          schema: string
          namespaceUri: string
          prefix: string
          properties: Array<{
            name: string
            value: string
            description: string
            category?: "external" | "internal"
          }>
        }>
      }
      /**
       * Attach the stored file to one of the calling app's OWN registered fileParents instead of
       * the default `pdf` parent. With `entityId` the parent row must be visible to the calling
       * handler; without it the host mints a fresh id (returned as `parent_entity_id`) for the row
       * the app then inserts.
       */
      parent?: {
        entityType: string
        entityId?: string
        /**
         * Without `entityId`: also insert the parent row (the fileParent's own table, joined on
         * `id`) in the host's committed file-write transaction, with these declared fields plus
         * the file id / SHA-256 / size in the named columns. For a file a cross-app reader needs
         * before the calling handler commits.
         */
        commitRow?: {
          values: Record<string, string | number | boolean | null>
          fileIdColumn?: string
          sha256Column?: string
          sizeColumn?: string
        }
      }
    }): Promise<{
      file_id: string
      byte_size: number
      page_count: number
      pdf_a3_normalized?: boolean
      /** SHA-256 (hex) of the stored bytes. */
      sha256?: string
      pdfa?: "3b" | null
      parent_entity_type?: string
      parent_entity_id?: string
    }>
  }
  /**
   * K3 — Allocate the next integer in a named sequence within the calling
   * app's namespace. Participates in the ambient tool-handler tx via
   * Postgres advisory lock; throwing rolls back the allocation. Keys
   * must start with the calling app's id. Requires `sequences.allocate`.
   */
  sequences: {
    allocate(params: { key: string }): Promise<{ value: number }>
  }
  /**
   * The wall clock of an instant in a named IANA zone, read on the host: the sandbox has no `Intl`
   * and no zone table, and `new Date()` only knows UTC. No capability needed.
   */
  time: {
    /**
     * `timezone` is an IANA name. `UTC`, the column default of issuer and org zones, means "not
     * set": the organization's zone answers, and UTC when it has none. `Etc/UTC` is UTC, exactly.
     * `at` (ISO date-time or epoch milliseconds) defaults to now. An unknown zone rejects with
     * `code: "invalid_timezone"`.
     */
    civil(params: { timezone: string; at?: string | number }): Promise<CivilTime>
  }
  /**
   * The effect ledger: an outside call claimed before it runs and stored after,
   * so a job run twice calls out once. Use it through `appEffectOnce` from
   * `@liaison/app-sdk/effects`, which runs the steps in order. Keys are scoped
   * to the app and the organization.
   */
  effects: EffectsBridge
  /**
   * K6 — Post-approval re-entry signal. `undefined` on first invocation;
   * populated on the kernel's re-invocation of a previously-gated tool
   * after a user approve decision. Read this to skip threshold/precondition
   * checks that should fire only at submission time.
   */
  approval?: {
    approvalRequestId: string
    approvalDeciderId: string
    toolName: string
  }
}

/** One part of a `ctx.fetch` multipart upload: a text field, or a kernel file the app may read. */
export type FetchMultipartPart =
  | { name: string; value: string }
  | { name: string; fileId: string; filename?: string; contentType?: string; expectSha256?: string }

/**
 * The envelope `ctx.executeTool` returns to an app that declares non-empty
 * `cross_app_calls[]` in its manifest (the K4 contract).
 */
export type CrossAppEnvelope =
  | { status: "completed"; result: unknown }
  | { status: "pending_approval"; approval_id: string }
  | {
      status: "error"
      error: { code: string; message: string; retryable?: boolean }
    }

/**
 * A webhook-upstream probe job's return value: the newest upstream activity the
 * provider reports (null when there is none), or why the probe did not run.
 */
export type UpstreamProbeResult =
  | { upstreamActivityAt: string | null }
  | { probed: false; reason: string }

/** A webhook handler's reply: the HTTP status and an optional plain-text body. */
export interface WebhookResult {
  status: number
  body?: string
}
