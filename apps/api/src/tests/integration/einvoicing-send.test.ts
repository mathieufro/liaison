// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real Postgres, real sandbox, real kernel: an e-invoice goes from issue to the PA through the
// generic provider contract (invoicing calls `einvoicing-pa@1`; the org binds Pennylane), with
// Pennylane answered by its recorded-shape fake behind the egress override.
//
//   a person issues (they may decide the send themselves, so nothing is staged or blocked) → an
//   agent asks for the send → ONE send approval request (never a send) → a person approves →
//   one prepared transmission row (no provider call) → the e-invoicing job: deposit (multipart
//   upload of the legal original's exact bytes), validation, transmission request → a signed,
//   fresh webhook (a duplicate is dropped by the kernel) → the job re-reads the status.
// Refusals, each with zero provider calls: an agent asking for a B2C send; a direct call to a
// contractOnly provider op (user, agent, app); a policy installed to auto-approve the send; an
// identity edit between approval and execution. Fault windows: a crash right after the import's
// 201 and right after the transmission's 204 each end in exactly one provider-side create.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFRawStream,
} from "pdf-lib"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { connectedAccounts } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import {
  CatalogDerivationsTestAccess,
  catalogFileParents,
  currentCatalog,
} from "~/modules/apps/catalog-derivations"
import { storeAppHeldSecret } from "~/modules/apps/connections/service"
import { executeTool, executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { writeKernelContractBinding } from "~/modules/apps/provider-contracts/binding"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { eraseUser } from "~/modules/erasure/erase-user"
import { registerTemplate } from "~/modules/pdf/registry"
import { getFileBytes } from "~/modules/pdf/render"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { PennylaneFake } from "../../../../../bundled-apps/pennylane/src/einvoicing/fake/server"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = randomUUID()
const USER = randomUUID()
const THREAD = randomUUID()
const CONTACT = randomUUID()
const B2C_CONTACT = randomUUID()
const SIREN = "900000001"
const HOOK_SECRET = "whsec_integration_test_secret_value"

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
  "pennylane:invoices:read",
]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}
const agentActor = { ...actor, actorType: "agent" as const, agentId: randomUUID() }

const fake = new PennylaneFake()
let issuerId = ""

function embeddedXml(pdf: PDFDocument): string {
  const af = pdf.catalog.lookup(PDFName.of("AF"), PDFArray)
  const spec = pdf.context.lookup(af.get(0), PDFDict)
  const ef = spec.lookup(PDFName.of("EF"), PDFDict)
  const stream = ef.lookup(PDFName.of("F")) as PDFRawStream
  return new TextDecoder().decode(decodePDFRawStream(stream).decode())
}

/** The fake reads the CII embedded in the uploaded PDF, as Pennylane does. */
const describeCache = new Map<
  string,
  { invoice_number: string | null; date: string | null; buyer_siren: string | null }
>()
async function describePdf(bytes: Uint8Array) {
  const sha = createHash("sha256").update(bytes).digest("hex")
  if (!describeCache.has(sha)) {
    try {
      const xml = embeddedXml(await PDFDocument.load(bytes, { updateMetadata: false }))
      const num = /<rsm:ExchangedDocument><ram:ID>([^<]*)<\/ram:ID>/.exec(xml)?.[1] ?? null
      const d =
        /<ram:IssueDateTime><udt:DateTimeString format="102">(\d{8})</.exec(xml)?.[1] ?? null
      const siren = /<ram:BuyerTradeParty>[\s\S]*?schemeID="0002">(\d{9})</.exec(xml)?.[1] ?? null
      describeCache.set(sha, {
        invoice_number: num,
        date: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
        buyer_siren: siren,
      })
    } catch {
      describeCache.set(sha, { invoice_number: null, date: null, buyer_siren: null })
    }
  }
  return { sha256: sha, valid: true, ...describeCache.get(sha)! }
}

async function registerInvoicingTemplates(): Promise<void> {
  for (const kind of ["invoice", "credit_note"]) {
    // Bundled in a child `bun build`, the same bundler and options as the package build. In this
    // process the from-source app registration has already run the bundler, and a second in-process
    // Bun.build after it fails reading a dependency ("Unexpected reading file" on zod's index.js).
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(REPO_ROOT, "bundled-apps", "invoicing", "templates", `${kind}.ts`),
        "--target",
        "bun",
        "--external",
        "node:*",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (build.exitCode !== 0) {
      throw new Error(`template ${kind} build failed: ${build.stderr.toString()}`)
    }
    let js = build.stdout.toString()
    const block = /export\s*\{([^}]*)\};?\s*$/.exec(js)
    const local = block?.[1]
      ?.split(",")
      .map((x) => x.trim())
      .map(
        (x) => /^(\w+)\s+as\s+renderTemplate$/.exec(x)?.[1] ?? (x === "renderTemplate" ? x : null),
      )
      .find((x) => x)
    if (!block || !local) throw new Error(`template ${kind} exports no renderTemplate`)
    js = `${js.slice(0, block.index)}\nglobalThis.renderTemplate = ${local};\n`
    registerTemplate("invoicing", `invoicing:${kind}_v1`, js)
  }
}

const B2B_BUYER = {
  contact_id: CONTACT,
  legal_name: "Client Exemple SAS",
  country: "FR",
  vat_id: "FR83900000001",
  address: "10 rue Domestic, 69002 Lyon",
  email: "compta@client-exemple.example",
  customer_kind: "business",
  billing_line1: "10 rue Domestic",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
}
const B2C_BUYER = {
  contact_id: B2C_CONTACT,
  legal_name: "Celine Exemple",
  country: "FR",
  vat_id: null,
  address: "2 avenue du Test, 69002 Lyon",
  email: "celine@example.test",
  customer_kind: "individual",
  billing_line1: "2 avenue du Test",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
}
const ITEMS = [{ description: "Contrôleur", quantity: "2", unit_price_minor: 34999 }]

async function issue(
  buyer: Record<string, unknown>,
): Promise<{ id: string; approvalId: string | null }> {
  const res = await executeTool({
    toolName: "invoicing:invoice_create_and_issue",
    orgId: ORG,
    actor,
    params: {
      counterparty: buyer,
      issuer_profile_id: issuerId,
      currency: "EUR",
      operation_category: "goods",
      items: ITEMS,
    },
    threadId: THREAD,
    origin: "human-ui",
  })
  const data = res.data as { document_id?: string } | undefined
  if (!data?.document_id) throw new Error(`issue failed: ${JSON.stringify(res)}`)
  // A staged send approval would be recorded on the document.
  const [d] = await sql<Array<{ einvoice_send_approval_id: string | null }>>`
    SELECT einvoice_send_approval_id FROM app_invoicing.documents WHERE id = ${data.document_id}`
  return { id: data.document_id, approvalId: d?.einvoice_send_approval_id ?? null }
}

/** Approvals are for agents: a person holding the deciding scope sends it themselves, so the send
 *  approval a person decides is the one their agent asks for (the in-app agent calls tools as its
 *  person, origin "in-app-agent"). Returns the staged approval's id. */
async function agentRequestsSend(documentId: string): Promise<string> {
  const r = await executeTool({
    toolName: "invoicing:einvoice_send_request",
    orgId: ORG,
    actor,
    params: { document_id: documentId },
    threadId: THREAD,
    origin: "in-app-agent",
  })
  const data = r.data as { status?: string; approval_id?: string; deduped?: boolean } | undefined
  if (data?.status !== "staged" || !data.approval_id) {
    throw new Error(`send request not staged: ${JSON.stringify(r)}`)
  }
  const [d] = await sql<
    Array<{ einvoice_send_approval_id: string | null; einvoice_state: string | null }>
  >`
    SELECT einvoice_send_approval_id, einvoice_state FROM app_invoicing.documents WHERE id = ${documentId}`
  expect(d).toEqual({
    einvoice_send_approval_id: data.approval_id,
    einvoice_state: "awaiting_send_approval",
  })
  return data.approval_id
}

async function tick(): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", "einvoicing-transmit")
  if (!handler) throw new Error("einvoicing-transmit job not registered")
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

async function tx(documentId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await sql<
    Array<Record<string, unknown>>
  >`SELECT * FROM app_invoicing.einvoice_transmissions WHERE document_id = ${documentId}`
  return row
}

async function sendApprovals(documentId: string) {
  return sql<Array<{ id: string; status: string; current_payload: Record<string, unknown> }>>`
    SELECT id, status, current_payload FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = 'invoicing:einvoice_send' AND current_payload->>'document_id' = ${documentId}`
}

function signedWebhook(body: string, t = Math.floor(Date.now() / 1000), secret = HOOK_SECRET) {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex")
  return app.request(`/webhooks/${ORG}/pennylane/einvoicing`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pennylane-signature": `t=${t},v1=${v1}` },
    body,
  })
}

async function runInvoicingJob(name: string): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", name)
  if (!handler) throw new Error(`${name} not registered`)
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "session",
  )
}

/** A member of the org holding exactly these scopes, no role and no wildcard. */
async function member(scopes: string[], status = "active"): Promise<UserContext> {
  const id = randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${id}, ${ORG}, ${`einv-m-${id.slice(0, 8)}@test.com`}, 'hash', 'Member', ${status})`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${id}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
  return { actorType: "user", userId: id, orgId: ORG, scopes, dimensionGrants: {} }
}

describe("e-invoice send through the einvoicing-pa@1 contract (real Postgres, sandbox, kernel; Pennylane fake)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Einvoice Send Org', ${`einv-send-${ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, ${`einv-${USER.slice(0, 8)}@test.com`}, 'hash', 'Approver', 'active')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, ${`einv-thread-${THREAD.slice(0, 8)}`}, 'agent_chat', ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${THREAD}, ${USER}, ${ORG}, 'admin')`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER}, ${THREAD}, ${ORG})`
    for (const scope of SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.apps (id, org_id, name, version, status) VALUES (gen_random_uuid(), ${ORG}, 'pennylane', '1.0.0', 'active')`
    await initSandboxPool()
    await initWorkerPool()
    // The org's catalog apps first, as its first request would (the webhook route sets the org
    // up): their registration rebuilds the files policy from the catalog alone, which must
    // happen before the rebuild below, not in the middle of a test.
    await ensureAppsForOrg(ORG)
    await registerApps(
      [bundledDescriptor("invoicing") as never, bundledDescriptor("pennylane") as never],
      ORG,
    )
    await registerInvoicingTemplates()
    // The files SELECT policy follows the catalog (#523), and these apps are registered from
    // source, outside it: the policy must also cover their parents (the legal originals the
    // provider reads), or the job's read of one finds no row ("forbidden").
    const parents = new Map(
      [
        ...catalogFileParents(await currentCatalog()),
        ...CatalogDerivationsTestAccess.registryFileParents(),
      ].map((p) => [`${p.app}:${p.entityType}`, p]),
    )
    await rebuildFilesSelectPolicy({ parents: [...parents.values()] })
    issuerId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, address, default_currency, default_language, iban, swift_bic,
       siren, routing_address, address_line1, postcode, city, country_code)
      VALUES (${issuerId}, ${ORG}, 'Maison Exemple SAS', 'FR', 'FR40902000009', '1 rue de Test, 75011 Paris',
       'EUR', 'fr', 'FR7630006000011234567890189', 'AGRIFRPP', '902000009', '902000009', '1 rue de Test', '75011', 'Paris', 'FR')`
    await sql`INSERT INTO app_invoicing.einvoicing_settings
      (org_id, gate_mode, gate_mode_source, provider_app, cutover_date, send_enabled, book_enabled, changed_by)
      VALUES (${ORG}, 'enforce', 'config', 'pennylane', '2026-01-01', true, false, ${USER})`
    // The binding the kernel dispatches by: an administrator's audited kernel path (config apply).
    await withPrivilegedDb(ORG, "einv-test-binding", (tx) =>
      writeKernelContractBinding(tx as never, {
        orgId: ORG,
        contract: "einvoicing-pa@1",
        callerApp: "invoicing",
        provider: "pennylane",
        actorId: USER,
        actorType: "user",
        source: "test",
      }),
    )
    await sql`INSERT INTO app_invoicing.counterparty_identities
      (org_id, contact_id, customer_kind, siren, routing_address, registry_name, registry_line1, registry_postcode,
       registry_city, registry_country_code, registry_status, registry_checked_at, source, confirmed_via, changed_at)
      VALUES (${ORG}, ${CONTACT}, 'business', ${SIREN}, ${SIREN}, 'CLIENT EXEMPLE', '10 rue Domestic', '69002',
       'Lyon', 'FR', 'A', '2026-10-01', 'registry', 'auto', '2026-10-01')`
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, customer_kind, source, confirmed_via, changed_at)
      VALUES (${ORG}, ${B2C_CONTACT}, 'individual', 'manual', 'auto', '2026-10-01')`
    await withSystemDb("einv-test-connection", (db) =>
      db.insert(connectedAccounts).values({
        orgId: ORG,
        appName: "pennylane",
        connectionName: "pennylane",
        ownerType: "org",
        ownerId: null,
        providerType: "credentials",
        identifier: "test-company",
        displayName: "test-company",
        credentialsEncrypted: encryptSecret(
          JSON.stringify({ apiToken: "fake-token", scope: "company" }),
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountCredentials,
        ),
        status: "active",
        createdBy: USER,
      }),
    )
    const pl = JSON.parse(
      readFileSync(join(REPO_ROOT, "bundled-apps", "pennylane", "app.manifest.json"), "utf8"),
    ) as { connections: Record<string, never> }
    await storeAppHeldSecret({
      orgId: ORG,
      appName: "pennylane",
      key: "einvoicingWebhookSecret",
      value: HOOK_SECRET,
      manifestConnections: pl.connections,
    })
    fake.directory[SIREN] = [SIREN]
    fake.describeBytes = null
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "app.pennylane.com")
    SandboxBridgeTestAccess.setFetch((async (input: string | URL, init?: RequestInit) => {
      const ct = new Headers(init?.headers as never).get("content-type") ?? ""
      if (ct.startsWith("multipart/form-data")) {
        // Describe the uploaded file asynchronously, then let the fake answer.
        const { parseMultipart } = await import(
          "../../../../../bundled-apps/pennylane/src/einvoicing/fake/server"
        )
        const parts = parseMultipart(
          new Uint8Array(init?.body as Uint8Array),
          /boundary=(.+)$/.exec(ct)![1]!,
        )
        const metas = new Map<Uint8Array, Awaited<ReturnType<typeof describePdf>>>()
        for (const p of parts)
          if (p.filename !== null) metas.set(p.bytes, await describePdf(p.bytes))
        fake.describeBytes = (bytes) => {
          for (const [b, m] of metas) if (b.byteLength === bytes.byteLength) return m
          return null
        }
      }
      return fake.httpFetch(input, init)
    }) as unknown as typeof fetch)
  }, 180_000)

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("an agent asking twice to send a B2C invoice through the PA: refused, zero approvals, zero provider calls", async () => {
    const { id, approvalId } = await issue(B2C_BUYER)
    expect(approvalId).toBeNull()
    for (let i = 0; i < 2; i++) {
      const r = await executeToolCore({
        toolName: "invoicing:einvoice_send_request",
        orgId: ORG,
        actor: agentActor as never,
        params: { document_id: id },
        threadId: THREAD,
        origin: "in-app-agent",
      })
      const code =
        "data" in r
          ? (r.data as { error?: { code?: string } })?.error?.code
          : "error" in r
            ? r.error.code
            : "blocked"
      expect(code).toBe("einvoice_not_eligible")
    }
    expect(await sendApprovals(id)).toHaveLength(0)
    expect(fake.calls).toHaveLength(0)
  }, 120_000)

  it("a provider op is contractOnly: a user, an agent and the invoicing app's own ctx.executeTool are refused", async () => {
    for (const [a, origin] of [
      [actor, "human-ui"],
      [agentActor, "in-app-agent"],
    ] as const) {
      const r = await executeToolCore({
        toolName: "pennylane:einvoicing_submit",
        orgId: ORG,
        actor: a as never,
        params: {},
        threadId: THREAD,
        origin,
      })
      expect("error" in r ? r.error.code : "ran").toBe("forbidden")
    }
    expect(fake.calls).toHaveLength(0)
  })

  it("a person's issue stages nothing; an agent's send request stages ONE send approval; approving prepares one row (no provider call); the job deposits the legal original, transmits once; a signed webhook brings the status", async () => {
    const issued = await issue(B2B_BUYER)
    const id = issued.id
    // The issuer may send it themselves: no approval row, the document is not marked blocked.
    expect(issued.approvalId).toBeNull()
    expect(await sendApprovals(id)).toHaveLength(0)
    const [fresh] = await sql<Array<{ einvoice_state: string | null }>>`
      SELECT einvoice_state FROM app_invoicing.documents WHERE id = ${id}`
    expect(fresh!.einvoice_state).toBeNull()
    const approvalId = await agentRequestsSend(id)
    // Asked again: the same pending approval, never a second one.
    expect(await agentRequestsSend(id)).toBe(approvalId)
    expect(await sendApprovals(id)).toHaveLength(1)
    const [appr] = await sendApprovals(id)
    expect(appr).toMatchObject({ id: approvalId, status: "pending" })
    const [doc] = await sql<
      Array<Record<string, unknown>>
    >`SELECT * FROM app_invoicing.documents WHERE id = ${id}`
    expect(appr!.current_payload).toEqual({
      document_id: id,
      legal_original_sha256: doc!.legal_original_sha256,
      buyer_siren: SIREN,
      routing_address: SIREN,
    })
    const [{ hours }] = await sql<Array<{ hours: number }>>`
      SELECT round(extract(epoch from (expires_at - created_at)) / 3600)::int AS hours FROM kernel.approval_requests WHERE id = ${approvalId}`
    expect(hours).toBe(24)
    expect(fake.calls).toHaveLength(0)

    await decideApproval({ orgId: ORG, requestId: approvalId, actor, decision: "approve" })
    const prepared = await tx(id)
    expect(prepared).toMatchObject({
      state: "prepared",
      action: "send_einvoice",
      approval_request_id: approvalId,
      approval_method: "approval",
      provider_app: "pennylane",
    })
    expect(fake.calls).toHaveLength(0) // execution never runs inside the approving transaction

    await tick()
    expect((await tx(id))!.state).toBe("validation_pending")
    const imp = fake.calls.find((c) => c.path === "/customer_invoices/e_invoices/imports")!
    const [lo] = await sql<
      Array<{ file_id: string; sha256: string }>
    >`SELECT file_id, sha256 FROM app_invoicing.legal_originals WHERE document_id = ${id}`
    const stored = await getFileBytes(null, lo!.file_id)
    expect(createHash("sha256").update(stored).digest("hex")).toBe(lo!.sha256)
    expect(imp.parts!.find((p) => p.name === "file")!.sha256).toBe(lo!.sha256) // the exact bytes of the legal original
    await tick()
    await tick()
    const sent = await tx(id)
    expect(sent).toMatchObject({ state: "sent", lifecycle_state: "deposited", lifecycle_code: 200 })
    expect(fake.creates("einvoice_import")).toBe(1)
    expect(fake.creates("send_to_pa")).toBe(1)

    // The buyer's platform accepts it: a signed, fresh webhook; its duplicate is dropped.
    fake.setEinvoicingStatus(Number(sent!.provider_ref), "accepted")
    const body = JSON.stringify({
      id: `env-${randomUUID()}`,
      type: "customer_invoice.e_invoicing_status_updated",
      data: { object: { id: Number(sent!.provider_ref) } },
    })
    const first = await signedWebhook(body)
    expect(first.status).toBe(200)
    const dup = await signedWebhook(body)
    expect(dup.status).toBe(200)
    expect(((await dup.json()) as { data?: { duplicate?: boolean } }).data?.duplicate).toBe(true)
    expect((await signedWebhook(body, undefined, "wrong-secret")).status).toBe(401)
    expect((await signedWebhook(body, Math.floor(Date.now() / 1000) - 600)).status).toBe(401)
    const [inbox] = await sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM app_pennylane.einvoicing_inbox WHERE org_id = ${ORG}`
    expect(inbox!.n).toBe(1)
    await tick()
    const afterHook = await tx(id)
    expect(afterHook).toMatchObject({ lifecycle_state: "accepted", lifecycle_code: 204 })
    // The history keeps the raw provider value, the official code, times and the source.
    expect(afterHook!.lifecycle_log).toEqual([
      expect.objectContaining({
        raw: "submitted",
        mapped: "deposited",
        code: 200,
        source: "transmit",
      }),
      expect.objectContaining({
        raw: "accepted",
        mapped: "accepted",
        code: 204,
        source: "webhook",
      }),
    ])
    // A direct replay of the approved send adopts the same row.
    const replay = await executeTool({
      toolName: "invoicing:einvoice_send",
      orgId: ORG,
      actor,
      params: appr!.current_payload,
      threadId: THREAD,
      origin: "human-ui",
    })
    expect((replay.data as { replay?: boolean }).replay).toBe(true)
    const [{ n }] = await sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM app_invoicing.einvoice_transmissions WHERE document_id = ${id}`
    expect(n).toBe(1)
  }, 180_000)

  it("an auto-approve policy for the send still parks it for a person", async () => {
    const { id } = await issue(B2B_BUYER)
    const approvalId = await agentRequestsSend(id)
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, enabled, conditions, limits)
      VALUES (${ORG}, 'invoicing:einvoice_send', true, '[]'::jsonb, '{}'::jsonb) ON CONFLICT DO NOTHING`
    const before = fake.calls.length
    const [appr] = await sendApprovals(id)
    const r = await executeTool({
      toolName: "invoicing:einvoice_send",
      orgId: ORG,
      actor,
      params: appr!.current_payload,
      threadId: THREAD,
      origin: "in-app-agent",
    })
    expect(r.blocked?.approvalRequestId).toBeTruthy()
    expect(await tx(id)).toBeUndefined()
    expect(fake.calls.length).toBe(before)
    void approvalId
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
  }, 120_000)

  it("an identity edit between approval request and decision: the approved send refuses einvoice_approval_stale", async () => {
    const { id } = await issue(B2B_BUYER)
    const approvalId = await agentRequestsSend(id)
    await sql`UPDATE app_invoicing.counterparty_identities SET routing_address = ${`${SIREN}_SVC9`} WHERE org_id = ${ORG} AND contact_id = ${CONTACT}`
    try {
      const before = fake.calls.length
      await decideApproval({
        orgId: ORG,
        requestId: approvalId,
        actor,
        decision: "approve",
      }).catch(() => null)
      expect(await tx(id)).toBeUndefined()
      expect(fake.calls.length).toBe(before)
    } finally {
      await sql`UPDATE app_invoicing.counterparty_identities SET routing_address = ${SIREN} WHERE org_id = ${ORG} AND contact_id = ${CONTACT}`
    }
  }, 120_000)

  it("booking: the daily job asks ONE approval for the day's reported sales (filed under the admin who set it up); approving books each once, never transmitted; the invariant switches booking off on an e-invoiced booking", async () => {
    await sql`UPDATE app_invoicing.einvoicing_settings SET book_enabled = true WHERE org_id = ${ORG}`
    try {
      const { id } = await issue(B2C_BUYER)
      const runJob = async (name: string) => {
        const handler = JobsTestAccess.getHandler("invoicing", name)
        if (!handler) throw new Error(`${name} not registered`)
        await dispatchAppJobWithContext(
          handler,
          { orgId: ORG },
          { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
          "session",
        )
      }
      const bookings = fake.creates("booking")
      await runJob("einvoicing-book-daily")
      const appr = await sql<
        Array<{
          id: string
          status: string
          requested_by: string
          current_payload: { batch_id: string }
        }>
      >`
        SELECT id, status, requested_by::text, current_payload FROM kernel.approval_requests
        WHERE org_id = ${ORG} AND tool_name = 'invoicing:einvoice_book_batch'`
      expect(appr).toHaveLength(1)
      expect(appr[0]).toMatchObject({ status: "pending", requested_by: USER })
      expect(fake.creates("booking")).toBe(bookings) // nothing booked before a person approves
      await runJob("einvoicing-book-daily") // the same documents are not asked for twice
      expect(
        await sql`SELECT 1 FROM kernel.approval_requests WHERE org_id = ${ORG} AND tool_name = 'invoicing:einvoice_book_batch'`,
      ).toHaveLength(1)

      await decideApproval({ orgId: ORG, requestId: appr[0]!.id, actor, decision: "approve" })
      const prepared = await tx(id)
      expect(prepared).toMatchObject({
        action: "book_sale",
        state: "prepared",
        approval_request_id: appr[0]!.id,
      })
      await tick()
      const booked = await tx(id)
      expect(booked).toMatchObject({ state: "booked" })
      // Every reported sale of the day is in the batch (the earlier consumer invoice too), each booked once.
      const [b0] = await sql<
        Array<{ document_ids: string[] }>
      >`SELECT document_ids FROM app_invoicing.einvoice_book_batches WHERE org_id = ${ORG}`
      expect(b0!.document_ids).toContain(id)
      expect(fake.creates("booking") - bookings).toBe(b0!.document_ids.length)
      for (const d of b0!.document_ids) expect((await tx(d))!.state).toBe("booked")
      const [lo] = await sql<
        Array<{ sha256: string }>
      >`SELECT sha256 FROM app_invoicing.legal_originals WHERE document_id = ${id}`
      const uploaded = fake.calls
        .filter((c) => c.path === "/file_attachments")
        .map((c) => c.parts!.find((p) => p.name === "file")!.sha256)
      expect(uploaded).toContain(lo!.sha256) // the legal original, not a re-render
      const inv = fake.invoices.get(Number(booked!.provider_ref))!
      expect(inv.factur_x).toBe(false)
      expect(inv.e_invoicing).toBeNull()
      const [batch] = await sql<
        Array<{ state: string; booked: number }>
      >`SELECT state, booked FROM app_invoicing.einvoice_book_batches WHERE org_id = ${ORG}`
      expect(batch).toMatchObject({ state: "done", booked: b0!.document_ids.length })

      await runJob("einvoicing-booking-invariant")
      expect(
        (
          await sql<
            Array<{ book_enabled: boolean }>
          >`SELECT book_enabled FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
        )[0]!.book_enabled,
      ).toBe(true)
      fake.setEinvoicingStatus(Number(booked!.provider_ref), "submitted")
      await runJob("einvoicing-booking-invariant")
      expect(
        (
          await sql<
            Array<{ book_enabled: boolean }>
          >`SELECT book_enabled FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
        )[0]!.book_enabled,
      ).toBe(false)
    } finally {
      await sql`UPDATE app_invoicing.einvoicing_settings SET book_enabled = false WHERE org_id = ${ORG}`
    }
  }, 180_000)

  it("fault windows: a crash after the import's 201 and after the transmission's 204 each end in exactly one create", async () => {
    const { id } = await issue(B2B_BUYER)
    const approvalId = await agentRequestsSend(id)
    await decideApproval({ orgId: ORG, requestId: approvalId, actor, decision: "approve" })
    const importCalls = fake.creates("einvoice_import")
    const sendCalls = fake.creates("send_to_pa")
    const clearBackoff = () =>
      sql`UPDATE app_invoicing.einvoice_transmissions SET next_attempt_at = NULL WHERE document_id = ${id}`

    fake.fail(
      (c) => c.path === "/customer_invoices/e_invoices/imports",
      "after",
      undefined,
      new Error("The socket connection was closed unexpectedly"),
    )
    await tick() // the deposit happens, its answer is lost
    let row = await tx(id)
    expect(row).toMatchObject({ state: "prepared", provider_ref: null, attempts: 1 })
    await clearBackoff()
    await tick() // found by invoice number and adopted, never imported twice
    row = await tx(id)
    expect(row!.state).toBe("validation_pending")
    const invId = Number(row!.provider_ref)

    fake.fail(
      (c) => c.path.endsWith("/send_to_pa"),
      "after",
      undefined,
      new Error("The socket connection was closed unexpectedly"),
    )
    await tick() // the transmission request happens, its answer is lost
    expect((await tx(id))!.state).toBe("validation_pending")
    await clearBackoff()
    await tick() // Pennylane shows the transmission: sent, no second request
    expect((await tx(id))!.state).toBe("sent")

    expect(fake.creates("einvoice_import") - importCalls).toBe(1)
    expect(fake.creates("send_to_pa") - sendCalls).toBe(1)
    const mine = [...fake.invoices.values()].filter(
      (i) => i.id === invId || i.invoice_number === fake.invoices.get(invId)!.invoice_number,
    )
    expect(mine).toHaveLength(1)
    expect(mine[0]!.e_invoicing).toBeTruthy()
  }, 180_000)

  it("the daily send card goes to and is decided by a person holding only invoicing documents read and write; a person without documents access sees no send batch and no standing authorization", async () => {
    const docsOnly = await member(["invoicing:documents:read", "invoicing:documents:write"])
    const noDocs = await member(["invoicing:settings:read"])
    const { id } = await issue(B2B_BUYER)
    await sql`UPDATE app_invoicing.documents SET einvoice_state = 'awaiting_send_batch',
      einvoice_send_requested_at = ${new Date().toISOString()} WHERE id = ${id}`
    await sql`INSERT INTO app_invoicing.einvoice_standing (org_id, issuer_profile_id, stream, turned_on_by, turned_on_at, grant_ref, until)
      VALUES (${ORG}, ${issuerId}, 'transfer', ${USER}, now(), 'grant-standing-transfer', now() + interval '60 days')`
    await runInvoicingJob("einvoicing-send-daily")
    const [batch] = await sql<Array<{ id: string; state: string; approval_request_id: string }>>`
      SELECT id::text, state, approval_request_id FROM app_invoicing.einvoice_send_batches
      WHERE org_id = ${ORG} AND state = 'pending' ORDER BY created_at DESC LIMIT 1`
    expect(batch?.approval_request_id).toBeTruthy()
    const [card] = await sql<Array<{ approve_scope: string; notify: string[] }>>`
      SELECT approve_scope, notify_user_ids::text[] AS notify FROM kernel.approval_requests WHERE id = ${batch!.approval_request_id}::uuid`
    expect(card!.notify).toContain(docsOnly.userId)
    expect(card!.notify).not.toContain(noDocs.userId)

    const counts = (a: UserContext) =>
      withRlsContext(
        a,
        async (t) =>
          extractRows<{ batches: number; standing: number }>(
            await t.execute(drizzleSql`SELECT
            (SELECT count(*)::int FROM app_invoicing.einvoice_send_batches) AS batches,
            (SELECT count(*)::int FROM app_invoicing.einvoice_standing) AS standing`),
          )[0],
      )
    expect(await counts(docsOnly)).toEqual({ batches: 1, standing: 1 })
    expect(await counts(noDocs)).toEqual({ batches: 0, standing: 0 })

    await decideApproval({
      orgId: ORG,
      requestId: batch!.approval_request_id,
      actor: docsOnly,
      decision: "approve",
    })
    const [after] = await sql<
      Array<{ state: string }>
    >`SELECT state FROM app_invoicing.einvoice_send_batches WHERE id = ${batch!.id}::uuid`
    expect(after!.state).toBe("approved")
    const row = await tx(id)
    expect(row).toMatchObject({ state: "prepared", action: "send_einvoice" })
    expect(row!.dispatch_grant).toBeTruthy()

    // The standing authorization a stream send reads, and turning it off, under documents access alone.
    await withRlsContext(docsOnly, async (t) => {
      await t.execute(drizzleSql`UPDATE app_invoicing.einvoice_standing SET ended_at = now(), ended_by = ${docsOnly.userId}::uuid, ended_reason = 'revoked'
        WHERE issuer_profile_id = ${issuerId}::uuid AND stream = 'transfer'`)
    })
    const [standing] = await sql<Array<{ ended_by: string | null }>>`
      SELECT ended_by::text FROM app_invoicing.einvoice_standing WHERE org_id = ${ORG} AND stream = 'transfer'`
    expect(standing!.ended_by).toBe(docsOnly.userId)
  }, 180_000)

  it("the renewal card of a standing authorization whose person was deactivated goes to every holder of the e-invoicing settings scope", async () => {
    const gone = await member(
      ["invoicing:settings:read", "invoicing:settings:write"],
      "deactivated",
    )
    const settingsHolder = await member(["invoicing:settings:read", "invoicing:settings:write"])
    await sql`INSERT INTO app_invoicing.einvoice_standing (org_id, issuer_profile_id, stream, turned_on_by, turned_on_at, grant_ref, until)
      VALUES (${ORG}, ${issuerId}, 'card', ${gone.userId}, now() - interval '83 days', 'grant-standing-card', now() + interval '5 days')`
    await runInvoicingJob("einvoicing-standing-daily")
    const cards = await sql<
      Array<{ approve_scope: string; notify: string[]; requested_by: string }>
    >`
      SELECT approve_scope, notify_user_ids::text[] AS notify, requested_by::text FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = 'invoicing:issuer_stream_set' AND current_payload->>'stream' = 'card'`
    expect(cards).toHaveLength(1)
    expect(cards[0]!.approve_scope).toBe("invoicing:settings:write")
    expect(cards[0]!.notify).toEqual(expect.arrayContaining([settingsHolder.userId, USER]))
    expect(cards[0]!.notify).not.toContain(gone.userId)
    expect(cards[0]!.requested_by).not.toBe(gone.userId)
  }, 180_000)

  it("erasing a person anonymizes their id in the standing authorization and leaves it nowhere in the send batches", async () => {
    const erased = await member(["invoicing:settings:write"])
    await sql`UPDATE app_invoicing.einvoice_standing SET turned_on_by = ${erased.userId}, ended_by = ${erased.userId}
      WHERE org_id = ${ORG} AND stream = 'transfer'`
    const res = await eraseUser(erased.userId!)
    expect(res.exitCode).toBe(0)
    const [standing] = await sql<Array<{ turned_on_by: string | null; ended_by: string | null }>>`
      SELECT turned_on_by::text, ended_by::text FROM app_invoicing.einvoice_standing WHERE org_id = ${ORG} AND stream = 'transfer'`
    expect(standing).toBeTruthy()
    expect(standing!.turned_on_by).not.toBe(erased.userId)
    expect(standing!.ended_by).not.toBe(erased.userId)
    const left = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*)::int FROM app_invoicing.einvoice_standing s WHERE s.org_id = ${ORG} AND row_to_json(s)::text LIKE ${`%${erased.userId}%`})
           + (SELECT count(*)::int FROM app_invoicing.einvoice_send_batches b WHERE b.org_id = ${ORG} AND row_to_json(b)::text LIKE ${`%${erased.userId}%`}) AS n`
    expect(left[0]!.n).toBe(0)
  }, 180_000)
})
