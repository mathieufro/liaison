// SPDX-License-Identifier: FSL-1.1-ALv2

import { z } from "zod"
import { UPSTREAM_CONNECTION_CLOSED } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  dropBearer,
  type FetchAuthDeps,
  type InjectedAuth,
  injectFetchAuth,
  matchesConnectionHost,
  parseConfigSecrets,
  parseFetchAuth,
  redactSecrets,
  substituteConfigSecrets,
} from "~/modules/apps/sandbox/bridge/fetch-auth"
import { readAppConfigValue } from "~/modules/apps/sandbox/bridge/identity"
import { buildMultipartBody, type MultipartUpload } from "~/modules/apps/sandbox/bridge/multipart"
import {
  SANDBOX_FETCH_MAX_REDIRECTS,
  sandboxEgressOverrides,
  sandboxEgressPolicy,
  validateSandboxFetchUrl,
} from "~/modules/apps/sandbox/bridge/shared"
import { maybeTestViesResponse } from "~/modules/apps/sandbox/bridge/test-vies"
import {
  type ImapCredentials,
  imapAppendSent,
  imapFetch,
  imapWriteBack,
} from "~/modules/apps/sandbox/imap-bridge"
import {
  hostFilesSentItself,
  IMAP_WRITE_BACK_MAX_ITEMS,
  SENT_COPY_DELAY_MS,
} from "~/modules/apps/sandbox/imap-mailbox"
import {
  buildRawSentMessage,
  type SmtpSendParams,
  type SmtpSendResult,
  smtpSend,
} from "~/modules/apps/sandbox/smtp-bridge"
import { maybeDemoBoxtalResponse } from "~/modules/demo/boxtal/responder"
import {
  assertDemoAppFetchAllowed,
  assertDemoEgressAllowed,
  DemoRestrictionError,
} from "~/modules/demo/demo-egress"
import { demoFixtureMessageId, isDemoFixtureDelivery } from "~/modules/demo/fixture-delivery"
import { maybeDemoShopifyResponse } from "~/modules/demo/shopify/provider"

// Per-fetch cap for a sandboxed `ctx.fetch`. Default 10s (tight, prod-safe). A
// deployment whose apps legitimately call a slow upstream — e.g. the KPI app
// proxying a warehouse-backed `kpi_run` that takes ~10-15s — can raise it via
// LIAISON_SANDBOX_FETCH_TIMEOUT_MS. Clamped to 120s so a hung upstream can't pin
// a worker indefinitely; in practice a fetch is also bounded by the tool's own
// execution budget (a 5s-default tool's handler is killed long before this).
const SANDBOX_FETCH_TIMEOUT_MS = (() => {
  const override = Number(process.env.LIAISON_SANDBOX_FETCH_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? Math.min(override, 120_000) : 10_000
})()
const SANDBOX_FETCH_MAX_RESPONSE_BYTES = 1_000_000
const SANDBOX_FETCH_MAX_REQUEST_BYTES = 1_000_000
/** A multipart upload (a file the app may read, sent to an allowed host) may carry up to 25 MB and
 *  ask for up to the egress maximum of 120 s: a provider ingesting a legal PDF is slower than a JSON
 *  call, and the bytes never cross into the sandbox, so the 1 MB string cap does not apply. */
export const SANDBOX_MULTIPART_MAX_REQUEST_BYTES = 25 * 1024 * 1024
const SANDBOX_EGRESS_MAX_TIMEOUT_MS = 120_000

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/** A connection the upstream closed or reset before answering (Bun's
 *  "The socket connection was closed unexpectedly", ECONNRESET, EPIPE). */
export function isConnectionDropped(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ConnectionClosed") return true
  return /socket connection was closed unexpectedly|socket hang up|ECONNRESET/i.test(err.message)
}

function upstreamConnectionClosed(url: string, cause: unknown): Error {
  let host = url
  try {
    host = new URL(url).hostname
  } catch {
    /* keep the raw url */
  }
  const err = new Error(`${host} closed the connection before answering. Try again in a moment.`, {
    cause,
  }) as Error & { status: number; code: string }
  err.status = 503
  err.code = UPSTREAM_CONNECTION_CLOSED
  return err
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel("response_too_large")
      throw new Error(`Response body exceeds ${maxBytes} bytes`)
    }

    chunks.push(value)
  }

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(merged)
}

/** External I/O: sandbox fetch, connection credentials, IMAP, SMTP and MCP connections. */
const egressLog = rootLogger.child({ module: "sandbox-egress" })

const imapWriteBackInputSchema = z.object({
  items: z
    .array(
      z.object({
        messageIds: z.array(z.string().max(1000)).max(500),
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        location: z.enum(["archive", "inbox", "trash"]).optional(),
      }),
    )
    .max(IMAP_WRITE_BACK_MAX_ITEMS),
})

/**
 * File the Sent copy of an SMTP send; failures are logged, never thrown. Hosts
 * known to file it themselves get none; the others are checked by Message-ID
 * only after SENT_COPY_DELAY_MS, so a server's own (asynchronous) filing is not
 * doubled.
 */
async function fileSentCopy(
  credentials: ImapCredentials,
  params: SmtpSendParams,
  messageId: string,
  context: { app: string; orgId: string },
): Promise<void> {
  if (hostFilesSentItself(credentials.host)) {
    egressLog.info(
      { ...context, outcome: "server_files_sent" },
      "sent copy for the IMAP Sent folder",
    )
    return
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, SENT_COPY_DELAY_MS))
    const raw = await buildRawSentMessage(params, messageId)
    const outcome = await imapAppendSent(credentials, raw, messageId)
    egressLog.info({ ...context, outcome }, "sent copy for the IMAP Sent folder")
  } catch (err) {
    egressLog.warn(
      { ...context, err: (err as Error).message },
      "could not file the sent message in the IMAP Sent folder",
    )
  }
}

export function createEgressMethods(ctx: BridgeContext): Record<string, any> {
  const {
    actorType,
    allowedDomains,
    appName,
    callerScopes,
    inheritedActor,
    manifest,
    orgId,
    resolveCredentials,
    txDb,
    userId,
  } = ctx
  /** Remember the connection the handler is about to call with (upstream-trace.ts). */
  const noteConnection = (name: string, identifier?: string): void => {
    const trace = ctx.bridgeOptions?.upstreamTrace
    if (trace) trace.connection = identifier ? { name, identifier } : { name }
  }
  /** A db read from a tx-less method (fetch) takes its own short transaction on a session bridge. */
  const shortDb = <T>(fn: (db: typeof txDb) => Promise<T>): Promise<T> =>
    ctx.bridgeOptions?.withShortTx ? ctx.bridgeOptions.withShortTx(fn) : fn(txDb)
  const authDeps: FetchAuthDeps = {
    manifest,
    orgId,
    userId,
    appName,
    readToken: async (connectionName, identifier) => {
      noteConnection(connectionName, identifier)
      const { resolveConnectionAccount } = await import("~/modules/apps/connections/service")
      const account = await shortDb((db) =>
        resolveConnectionAccount(db, orgId, userId, appName, connectionName, identifier, {
          actorType: actorType === "user" ? "user" : "system",
        }),
      )
      return { token: account.token, identifier: account.identifier }
    },
    readCredentials: (connectionName, identifier) => {
      noteConnection(connectionName, identifier)
      return resolveCredentials(connectionName, identifier ?? "")
    },
    readConfigSecret: async (key) => {
      const value = await shortDb((db) => readAppConfigValue(ctx, key, db))
      return typeof value === "string" && value.length > 0 ? value : null
    },
    send: (url, optsJson) => methods.fetch(url, optsJson),
  }
  const methods: Record<string, any> = {
    // --- Network fetch ---
    // `opts.auth` / `opts.configSecrets` put a credential or a config secret into the request
    // HERE, after the allowlist check, so the app never holds it (fetch-auth.ts).
    fetch: async (url: string, optsJson: string) => {
      const opts = JSON.parse(optsJson || "{}")
      const method = opts.method ?? "GET"
      const auth = parseFetchAuth(opts.auth)
      const configSecrets = parseConfigSecrets(opts.configSecrets)
      // A multipart body is assembled HERE from the parts the app names: text fields as given,
      // file parts read from kernel.files under this bridge's own RLS context (so only a file the
      // calling app may read can leave), capped at 25 MB, each part fingerprinted.
      let body = opts.body
      let upload: MultipartUpload | null = null
      if (
        body &&
        typeof body === "object" &&
        Array.isArray((body as { multipart?: unknown }).multipart)
      ) {
        // Fail before any bytes are read when the host is not allowed.
        await validateSandboxFetchUrl(
          url,
          allowedDomains,
          manifest.network?.allowPrivateHostsInTest ?? false,
          appName,
        )
        upload = await buildMultipartBody(
          ctx,
          (body as { multipart: unknown[] }).multipart,
          SANDBOX_MULTIPART_MAX_REQUEST_BYTES,
        )
        body = upload.body
      } else if (body !== undefined && body !== null && typeof body !== "string") {
        throw new Error("ctx.fetch: body must be a string or {multipart:[...]}")
      }
      // A caller may TIGHTEN its own deadline, never extend it. An app that knows one upstream
      // call is only worth 5s of its tool budget could not say so: this bridge hardcoded the
      // sandbox-wide ceiling, so `opts.timeoutMs` was accepted by the SDK, carried across the
      // IPC boundary, and then silently dropped here. Boxtal's label import is the case that
      // exposed it: 8 retries x the 10s ceiling is 80s of a 60s tool budget, which is how
      // print_pack held a worker for 39s in prod and timed the operator out at 30s.
      // Clamped to SANDBOX_FETCH_TIMEOUT_MS so an app can never pin a worker for longer than
      // the sandbox allows, which is the invariant the hardcoded value was protecting.
      const requestedTimeout = Number(opts.timeoutMs)
      const timeoutCeiling = upload ? SANDBOX_EGRESS_MAX_TIMEOUT_MS : SANDBOX_FETCH_TIMEOUT_MS
      const fetchTimeoutMs =
        Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.min(requestedTimeout, timeoutCeiling)
          : SANDBOX_FETCH_TIMEOUT_MS
      if (
        typeof body === "string" &&
        new TextEncoder().encode(body).byteLength > SANDBOX_FETCH_MAX_REQUEST_BYTES
      ) {
        throw new Error(`Request body exceeds ${SANDBOX_FETCH_MAX_REQUEST_BYTES} bytes`)
      }

      const allowPrivateHostsInTest = manifest.network?.allowPrivateHostsInTest ?? false

      // Run initial allowlist + scheme validation; pinned helper does private-net
      // + DNS-pin enforcement on every hop, with onHopValidate re-running the
      // sandbox allowlist on each redirect target.
      await validateSandboxFetchUrl(url, allowedDomains, allowPrivateHostsInTest, appName)

      // P4 (Phase 16 E2E) — test-mode actor marker.
      // When `LIAISON_TEST_INJECT_ACTOR=1` is set on the worker, the bridge
      // injects `X-Liaison-Actor: <userId>` on every outbound HTTP call sourced
      // from a sandboxed app. The Phase-16 mock Shopify server records this
      // header so `requestsFromUser(<userId>)` can assert per-user isolation
      // (e.g. "Bob got denied → zero outbound calls"). Production code path is
      // unaffected — Shopify still receives the shared offline token in
      // `Authorization`, matching real Shopify semantics.
      const headersWithActor: Record<string, string> = { ...(opts.headers ?? {}) }
      if (upload) {
        // The boundary is ours: an app-supplied content-type would not match the body.
        for (const k of Object.keys(headersWithActor)) {
          if (k.toLowerCase() === "content-type") delete headersWithActor[k]
        }
        headersWithActor["Content-Type"] = upload.contentType
      }
      if (process.env.LIAISON_TEST_INJECT_ACTOR === "1") {
        headersWithActor["X-Liaison-Actor"] = userId
      }

      // Host-side credentials, after the allowlist check (and before the demo
      // and test answerers, which recognise their fixture credential).
      let injected: InjectedAuth = { secrets: [] }
      if (auth) {
        injected = await injectFetchAuth(url, headersWithActor, auth, authDeps, fetchTimeoutMs)
        if (injected.failed) {
          // The token exchange failed: the app sees the token endpoint's answer.
          const failed = injected.failed
          return JSON.stringify({
            status: failed.status,
            headers: failed.headers,
            body: failed.body,
          })
        }
      }
      if (configSecrets) {
        const substituted = await substituteConfigSecrets(url, body, configSecrets, authDeps)
        body = substituted.body
        injected.secrets.push(...substituted.secrets)
      }
      const injectedFor = auth?.connection ?? null
      const injectedHost = injected.boundHost ?? null

      // DEMO INSTANCE ONLY. On a normal deployment this is one boolean read of
      // a module-local that is false, and the call path below is byte-identical
      // to what it was before demo mode existed. On the demo box, a demo org's
      // Shopify Admin traffic is answered from fixtures (or refused) and never
      // put on the wire; every other org and every other host falls straight
      // through. See modules/demo/shopify/provider.ts.
      const demoShopify = await maybeDemoShopifyResponse({
        url,
        method,
        body: typeof body === "string" ? body : undefined,
        orgId,
        headers: headersWithActor,
      })

      // DEMO INSTANCE ONLY, the same gate for Boxtal: a demo org's carrier
      // quotes and shipping orders are answered in-process (or refused), so
      // the commerce scenario can stage a label and no carrier is ever reached.
      const demoBoxtal = demoShopify
        ? null
        : await maybeDemoBoxtalResponse({
            url,
            method,
            body: typeof body === "string" ? body : undefined,
            orgId,
            headers: headersWithActor,
          })

      // TEST STACKS ONLY (LIAISON_TEST_VIES_STUB=1 under NODE_ENV test): the EU VIES VAT check
      // is answered by a stand-in, so a test never depends on the live service (test-vies.ts).
      const testVies = demoShopify || demoBoxtal ? null : maybeTestViesResponse(url)

      let response: Response
      if (demoShopify) {
        response = demoShopify
      } else if (demoBoxtal) {
        response = demoBoxtal
      } else if (testVies) {
        response = testVies
      } else {
        // Everything the fixture provider did NOT answer. A demo org's app
        // traffic to Pennylane, Boxtal, Meta, the VIES VAT service or anything
        // else a shipped manifest declares is refused HERE, before a connection
        // is opened, rather than leaving the box with a sentinel credential and
        // coming back as a confusing 401. Shopify never reaches this line: it
        // was answered above, so the fixture path is untouched and nothing is
        // checked twice. One module-local boolean on a normal deployment.
        await assertDemoAppFetchAllowed(orgId, url)
        // An idempotent read whose connection the upstream dropped mid-flight
        // ("The socket connection was closed unexpectedly") is retried once: a
        // pooled keep-alive socket the far end had already closed fails the
        // first use and succeeds on a fresh one. A write is never replayed.
        const idempotent = IDEMPOTENT_METHODS.has(String(method).toUpperCase())
        for (let attempt = 1; ; attempt++) {
          try {
            if (
              sandboxEgressOverrides.fetch &&
              sandboxEgressOverrides.fetchInterceptsHost?.(new URL(url).hostname)
            ) {
              // TEST-ONLY: a test fetch-impl is installed (see `SandboxBridgeTestAccess.setFetch`,
              // null in production) AND it has claimed this host. The URL already passed
              // `validateSandboxFetchUrl` above (allowlist + HTTPS), so call the mock
              // DIRECTLY — `fetchWithPinnedHost` does a real DNS `lookup()` before
              // invoking `fetchImpl`, which fails for unreachable third-party sandbox
              // hosts (e.g. Boxtal's `api.boxtal.build`) and would never reach the mock.
              // Hosts the mock does NOT claim (e.g. Shopify's live `*.myshopify.com`)
              // fall through to the real pinned-host path below, byte-identical to prod.
              response = await sandboxEgressOverrides.fetch(url, {
                method,
                headers: headersWithActor,
                body,
                signal: AbortSignal.timeout(fetchTimeoutMs),
              } as RequestInit)
            } else {
              response = await fetchWithPinnedHost(
                url,
                {
                  method,
                  headers: headersWithActor,
                  body,
                  signal: AbortSignal.timeout(fetchTimeoutMs),
                },
                {
                  maxRedirects: SANDBOX_FETCH_MAX_REDIRECTS,
                  fetchImpl: sandboxEgressOverrides.fetch ?? undefined,
                  ...sandboxEgressPolicy(appName),
                  allowPrivateHostsInTest,
                  onHopValidate: async (next) => {
                    await validateSandboxFetchUrl(
                      next,
                      allowedDomains,
                      allowPrivateHostsInTest,
                      appName,
                    )
                    // An injected credential follows a redirect only to its own connection's hosts.
                    if (injectedFor && !matchesConnectionHost(manifest, injectedFor, next)) {
                      throw new Error(
                        `Redirect to ${new URL(next).hostname} refused: not a host of connection "${injectedFor}"`,
                      )
                    }
                    // A credential bound to its account's own host follows no redirect elsewhere.
                    if (injectedHost && new URL(next).hostname.toLowerCase() !== injectedHost) {
                      throw new Error(
                        `Redirect to ${new URL(next).hostname} refused: not the host of this "${injectedFor}" account`,
                      )
                    }
                  },
                },
              )
            }
          } catch (err) {
            if (
              err instanceof Error &&
              (err.name === "TimeoutError" || err.name === "AbortError")
            ) {
              throw new Error(`Fetch timed out after ${fetchTimeoutMs}ms`)
            }
            if (err instanceof UnsafeOutboundUrlError && /too many redirects/i.test(err.message)) {
              throw new Error(`Too many redirects (max ${SANDBOX_FETCH_MAX_REDIRECTS})`)
            }
            if (isConnectionDropped(err)) {
              if (idempotent && attempt === 1) continue
              // Still dropped (or a write we must not replay): an upstream
              // outage, not our fault. Typed so it logs at warn and the caller
              // reads it as retryable.
              throw upstreamConnectionClosed(url, err)
            }
            throw err
          }
          break
        }
      }

      // The run's last upstream answer, host and status only (see upstream-trace.ts).
      const trace = ctx.bridgeOptions?.upstreamTrace
      if (trace) trace.last = { host: new URL(url).host, status: response.status }
      if (response.status === 401) dropBearer(injected.bearerKey)
      // Nothing the host injected comes back to the app, even when the upstream echoes it.
      const responseBody = redactSecrets(
        await readResponseBody(response, SANDBOX_FETCH_MAX_RESPONSE_BYTES),
        injected.secrets,
      )
      const headers: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        headers[k] = redactSecrets(v, injected.secrets)
      })
      if (upload) {
        // One audit line per upload: where, how much, which bytes, what came back. Never the
        // headers (they carry the provider token) and never a body.
        egressLog.info(
          {
            app: appName,
            orgId,
            host: new URL(url).hostname,
            size: upload.size,
            parts: upload.parts.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 })),
            status: response.status,
          },
          "sandbox multipart upload",
        )
        return JSON.stringify({
          status: response.status,
          headers,
          body: responseBody,
          upload: { size: upload.size, parts: upload.parts },
        })
      }
      return JSON.stringify({ status: response.status, headers, body: responseBody })
    },

    // --- Connections ---
    connections_getToken: async (connectionName: string, identifier?: string) => {
      noteConnection(connectionName, identifier)
      const { getTokenForConnection } = await import("~/modules/apps/connections/service")
      return getTokenForConnection(txDb, orgId, userId, appName, connectionName, identifier, {
        actorType: actorType === "user" ? "user" : "system",
      })
    },

    // The NON-SECRET part of a credentials connection: the values of the fields the manifest
    // marks `readable: true` (never a `password` field), and which declared fields hold no
    // value. Safe on every executor; the secrets themselves reach the provider through
    // `ctx.fetch` auth instead.
    connections_getSettings: async (connectionName: string, identifier?: string) => {
      const declaration = manifest.connections?.[connectionName]
      if (!declaration) {
        throw new Error(`Connection "${connectionName}" not declared in app manifest`)
      }
      noteConnection(connectionName, identifier)
      const creds = await resolveCredentials(connectionName, identifier ?? "")
      const values: Record<string, string> = {}
      const missing: string[] = []
      for (const field of declaration.credentialFields ?? []) {
        const v = (creds as Record<string, unknown>)[field.name]
        const present =
          typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v !== ""
        if (!present) {
          missing.push(field.name)
          continue
        }
        if (field.readable === true && field.type !== "password") values[field.name] = String(v)
      }
      return JSON.stringify({ values, missing })
    },

    connections_getAccounts: async (connectionName: string) => {
      const { listConnectionAccounts } = await import("~/modules/apps/connections/service")
      const accounts = await listConnectionAccounts(txDb, orgId, userId, appName, connectionName)
      return JSON.stringify(accounts)
    },

    // Status of the app's own accounts for one connection (owner, who connected
    // it, health, token expiry), for the app's settings surface. Read only, no
    // secrets; the org's rows plus the caller's personal ones.
    connections_describe: async (connectionName: string) => {
      const { describeConnectionAccounts } = await import("~/modules/apps/connections/service")
      const accounts = await describeConnectionAccounts(orgId, userId, appName, connectionName)
      return JSON.stringify(accounts)
    },

    // Generic credential-map accessor for credentials-connection apps (Boxtal is
    // the first consumer). `getToken` throws "No access token stored" for a
    // credentials connection (it reads accessTokenEncrypted, empty here); the
    // decrypted map lives in credentialsEncrypted and is reachable only via
    // resolveCredentials, which filters to the declared `credentialFields` and
    // enforces the actor's RLS context. Returns the JSON-stringified filtered
    // map so the sandbox shim auto-parses it on the app side.
    connections_getCredentials: async (connectionName: string, identifier?: string) => {
      noteConnection(connectionName, identifier)
      const creds = await resolveCredentials(connectionName, identifier ?? "")
      return JSON.stringify(creds)
    },

    connections_disconnect: async (connectionId: string, noticeJson?: string) => {
      const { disconnectConnection } = await import("~/modules/apps/connections/service")
      // An app refusing the account it was given tells the person who connected
      // it why: one fixed reason, a short plain-text summary.
      let notice: { reason: "connect_refused"; summary: string } | undefined
      if (noticeJson) {
        const parsed = z
          .object({ reason: z.literal("connect_refused"), summary: z.string().min(1).max(500) })
          .safeParse(JSON.parse(noticeJson))
        if (!parsed.success) throw new Error("connections_disconnect: invalid notice")
        notice = parsed.data
      }
      await disconnectConnection(txDb, orgId, userId, connectionId, notice)
    },

    imap_writeBack: async (connectionName: string, identifier: string, inputJson: string) => {
      const creds = await resolveCredentials(connectionName, identifier)
      const parsed = imapWriteBackInputSchema.safeParse(JSON.parse(inputJson || "{}"))
      if (!parsed.success) {
        throw new Error(
          `imap_writeBack: invalid input — ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        )
      }
      const result = await imapWriteBack(
        {
          host: creds.imapHost,
          port: Number(creds.imapPort),
          username: creds.username,
          password: creds.password,
        },
        parsed.data.items,
      )
      return JSON.stringify(result)
    },

    imap_fetch: async (connectionName: string, identifier: string, optsJson: string) => {
      const creds = await resolveCredentials(connectionName, identifier)
      const imapFetchOptsSchema = z.object({
        mode: z.enum(["full", "incremental"]).optional().default("full"),
        // Options cross the bridge as JSON, which has no undefined: an app
        // says "no cursor yet" (a first sync) or "the default mailbox" with
        // null, and both mean the same as leaving the key out.
        cursor: z.string().nullish(),
        batchSize: z.number().int().min(1).max(100).optional().default(100),
        mailbox: z.string().nullish(),
        folder: z.enum(["inbox", "sent"]).nullish(),
        // A newest-first walk (a first import): the page below `before`.
        order: z.literal("newest").nullish(),
        before: z
          .string()
          .regex(/^\d{1,20}$/)
          .nullish(),
        above: z
          .string()
          .regex(/^\d{1,20}$/)
          .nullish(),
        reconcile: z
          .object({
            uidSet: z.string().max(2_000_000).nullish(),
            modseq: z
              .string()
              .regex(/^\d{1,20}$/)
              .nullish(),
          })
          .nullish(),
      })
      const rawOpts = JSON.parse(optsJson || "{}")
      const parsed = imapFetchOptsSchema.safeParse(rawOpts)
      if (!parsed.success) {
        throw new Error(
          `imap_fetch: invalid options — ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        )
      }
      const opts = parsed.data
      const result = await imapFetch(
        {
          host: creds.imapHost,
          port: Number(creds.imapPort),
          username: creds.username,
          password: creds.password,
        },
        {
          mode: opts.mode,
          cursor: opts.cursor ?? undefined,
          batchSize: opts.batchSize,
          mailbox: opts.mailbox ?? undefined,
          folder: opts.folder ?? undefined,
          order: opts.order ?? undefined,
          before: opts.before ?? undefined,
          above: opts.above ?? undefined,
          reconcile: opts.reconcile ?? undefined,
        },
      )

      return JSON.stringify(result)
    },

    smtp_send: async (connectionName: string, identifier: string, messageJson: string) => {
      // A demo org may compose mail all it likes; it may not put it on the wire.
      // Checked here rather than inside `smtpSend`, and BEFORE the test override,
      // so the refusal covers every path out of the sandbox and so a suite that
      // installs a fake SMTP sink still sees the real production refusal. No-op
      // (one cached lookup) unless this box is the demo instance.
      try {
        await assertDemoEgressAllowed(orgId, "outbound_mail")
      } catch (err) {
        // A demo scenario's fictional recipient: when to, cc, bcc AND reply-to
        // are all on reserved domains the send is recorded as delivered and
        // nothing leaves (modules/demo/fixture-delivery.ts). Else the refusal.
        if (!(err instanceof DemoRestrictionError)) throw err
        const message = JSON.parse(messageJson) as Partial<SmtpSendParams>
        const recipients = [
          ...(message.to ?? []),
          ...(message.cc ?? []),
          ...(message.bcc ?? []),
          ...(message.replyTo ? [message.replyTo] : []),
        ]
        if (!(await isDemoFixtureDelivery(orgId, recipients))) throw err
        const result: SmtpSendResult = {
          messageId: message.messageId ?? demoFixtureMessageId(),
          deliveryState: "delivered",
        }
        return JSON.stringify(result)
      }
      if (sandboxEgressOverrides.smtpSend) {
        return JSON.stringify(
          await sandboxEgressOverrides.smtpSend(
            connectionName,
            identifier,
            JSON.parse(messageJson),
          ),
        )
      }
      const creds = await resolveCredentials(connectionName, identifier)
      const params = JSON.parse(messageJson) as SmtpSendParams
      const result = await smtpSend(
        {
          host: creds.smtpHost,
          port: Number(creds.smtpPort),
          username: creds.username,
          password: creds.password,
        },
        params,
      )
      // A server that does not file SMTP-sent mail in Sent gets a copy, so the
      // mailbox (and its other clients) show what was sent from Liaison. Never
      // awaited by the send: the message is already out, the copy is best effort.
      if (creds.imapHost && result.deliveryState !== "rejected") {
        void fileSentCopy(
          {
            host: creds.imapHost,
            port: Number(creds.imapPort),
            username: creds.username,
            password: creds.password,
          },
          params,
          result.messageId,
          { app: appName, orgId },
        )
      }

      return JSON.stringify(result)
    },

    // --- MCP Manager tool bridges (BL-169 #6 — agent-callable connection management) ---
    // The handlers run sandboxed; connection creation needs host-side AES secret
    // encryption + an SSRF guard, so it delegates to the host service here.
    mcp_createConnection: async (paramsJson: string): Promise<string> => {
      if (appName !== "mcp-manager") {
        throw new Error("mcp_createConnection is only available to the mcp-manager app")
      }
      const { createMcpConnection } = await import("~/apps/mcp-manager/service/connections")
      const actor =
        inheritedActor.actorType === "user"
          ? inheritedActor
          : {
              actorType: "user" as const,
              userId,
              orgId,
              scopes: callerScopes ?? [],
              dimensionGrants: {},
            }
      return JSON.stringify(
        await createMcpConnection({
          tx: txDb as never,
          orgId,
          actor,
          input: JSON.parse(paramsJson || "{}"),
        }),
      )
    },
    // Stage-time check for add_connection (its preflight): the ownership asked
    // for must be one the caller may write, refused before any approval exists.
    mcp_checkConnectionWrite: async (paramsJson: string): Promise<string> => {
      if (appName !== "mcp-manager") {
        throw new Error("mcp_checkConnectionWrite is only available to the mcp-manager app")
      }
      const { checkConnectionWriteAllowed } = await import("~/apps/mcp-manager/service/connections")
      const scopes =
        inheritedActor.actorType === "user" ? (inheritedActor.scopes ?? []) : (callerScopes ?? [])
      const params = JSON.parse(paramsJson || "{}") as { ownershipScope?: unknown }
      const refusal = checkConnectionWriteAllowed(params.ownershipScope, scopes)
      return JSON.stringify(refusal ? { error: { ...refusal, retryable: false } } : { ok: true })
    },
    mcp_listConnections: async (_paramsJson: string): Promise<string> => {
      if (appName !== "mcp-manager") {
        throw new Error("mcp_listConnections is only available to the mcp-manager app")
      }
      const { listMcpConnections } = await import("~/apps/mcp-manager/service/connections")
      return JSON.stringify(await listMcpConnections({ tx: txDb as never, orgId }))
    },
  }
  return methods
}
