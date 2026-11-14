// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing counterparty identity tools on real Postgres, through the real kernel path
// (executeTool -> sandbox handler -> bridge, the registry answered by a canned fake at the
// sandbox fetch boundary), as a user holding only the issuer's scopes (never admin):
//  - a valid, active SIREN of ANOTHER company proposed from the web is never written without a
//    human: one approval with the mismatch on its card, zero identity rows; approving it writes
//    the identity as confirmed by approval;
//  - einvoicing_classify by contact and by Shopify order;
//  - recording the identity re-drives the order parked on it at the next deferred-retry sweep
//    (run as the system actor) and the order is invoiced;
//  - the issuer reads parks through deferred_list but cannot update them.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

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

const ORG = "00000000-0000-4000-8000-0000000e8001"
const USER = "00000000-0000-4000-8000-0000000e8002"
const THREAD = "00000000-0000-4000-8000-0000000e8003"
// A conversation that read nothing from outside the organisation.
const CLEAN_THREAD = "00000000-0000-4000-8000-0000000e8004"
const CONTACT_A = "00000000-0000-4000-8000-0000000e8011" // the S4b counterparty
const CONTACT_B = "00000000-0000-4000-8000-0000000e8012" // the parked order's buyer
const CONTACT_C = "00000000-0000-4000-8000-0000000e8013" // a contact an agent tries to mislabel
let issuerId = ""
const SHOP = "exemple-identity.myshopify.com"
const ORDER = "7008001"

// Fictional, Luhn-valid SIRENs.
const OWN_SIREN = "900000001"
const OTHER_SIREN = "903000008"

const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: CEO_ROLE_SCOPES,
  dimensionGrants: {},
}

/** A registry `/search` result (the registry's own field names, fictional values). */
function registryResult(
  siren: string,
  name: string,
  city: string,
  postcode: string,
): Record<string, unknown> {
  return {
    siren,
    nom_complet: name,
    nom_raison_sociale: name,
    sigle: null,
    etat_administratif: "A",
    nature_juridique: "5710",
    siege: {
      siret: `${siren}00011`,
      numero_voie: "1",
      type_voie: "RUE",
      libelle_voie: "DE L'EXEMPLE",
      code_postal: postcode,
      libelle_commune: city,
      liste_enseignes: null,
    },
    matching_etablissements: [],
  }
}

const REGISTRY: Record<string, Record<string, unknown>> = {
  [OWN_SIREN]: registryResult(OWN_SIREN, "EXEMPLE INDUSTRIES", "PARIS", "75002"),
  [OTHER_SIREN]: registryResult(OTHER_SIREN, "AUTRE ENTREPRISE FICTIVE", "BORDEAUX", "33000"),
}
let registryCalls = 0

const registryFetch = (async (input: Parameters<typeof fetch>[0]) => {
  registryCalls += 1
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  )
  const q = url.searchParams.get("q") ?? ""
  const hit = REGISTRY[q]
  return new Response(
    JSON.stringify({
      results: hit ? [hit] : [],
      total_results: hit ? 1 : 0,
      page: 1,
      per_page: 10,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  )
}) as unknown as typeof fetch

type Data = Record<string, unknown>

async function callTool(
  toolName: string,
  params: Record<string, unknown>,
  threadId: string = THREAD,
) {
  return executeTool({
    toolName,
    orgId: ORG,
    actor,
    params,
    threadId,
    origin: "in-app-agent",
  })
}

async function identities(contactId: string): Promise<Array<Record<string, unknown>>> {
  return sql`SELECT * FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG} AND contact_id = ${contactId}`
}

async function approvalCount(): Promise<number> {
  const [r] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${ORG}`
  return r?.n ?? 0
}

async function runDeferredRetryAsSystem(): Promise<void> {
  const handler = JobsTestAccess.getHandler("invoicing", "deferred-retry")
  if (!handler) throw new Error("deferred-retry job handler not registered")
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["invoicing:*"] },
    "ambient",
  )
}

describe("invoicing identity tools (real Postgres, CEO scopes)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Identity Tools Org', 'identity-tools-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'identity-tools@test.com', 'hash', 'Identity Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    for (const [id, handle] of [
      [THREAD, "identity-tools-thread"],
      [CLEAN_THREAD, "identity-tools-clean-thread"],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${id}, ${ORG}, ${handle}, 'agent_chat', ${USER}) ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${id}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${USER}, ${id}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of CEO_ROLE_SCOPES) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }

    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
    // Stand-in for the Shopify app's order read (the invoicing app's declared cross-app call).
    toolRegistry.set([ORG, "shopify", "orders_get"], {
      appName: "shopify",
      name: "orders_get",
      description: "stand-in",
      // Any scope the caller holds: the stand-in only answers, the real app checks its own.
      requiredScopes: ["invoicing:documents:read"],
      handler: async () => ({
        name: "#8001",
        financialStatus: "PAID",
        customer: { email: "compta@exemple-industries.example", first_name: null, last_name: null },
        shippingAddress: null,
        customerAddress: null,
      }),
    } as never)
    SandboxBridgeTestAccess.setFetch(registryFetch)
    SandboxBridgeTestAccess.setFetchInterceptsHost((h) => h === "recherche-entreprises.api.gouv.fr")

    issuerId = randomUUID()
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, address, default_currency, default_language, shopify_shop_id)
      VALUES (${issuerId}, ${ORG}, 'Identity Issuer SAS', 'FR', 'FR68900000001', '1 rue Test, 75001 Paris', 'EUR', 'fr', ${SHOP})`
    await sql`INSERT INTO app_invoicing.einvoicing_settings (org_id, gate_mode, gate_mode_source)
      VALUES (${ORG}, 'enforce', 'config')`
    // The S4b counterparty was invoiced before under its own name.
    await sql`INSERT INTO app_invoicing.documents
      (org_id, type, status, number, number_int, year_of_issue, currency, incoterm, issuer_profile_id,
       counterparty_contact_id, counterparty_name, counterparty_address, counterparty_email, counterparty_country,
       billing_line1, billing_postcode, billing_city, billing_country_code,
       subtotal_minor, tax_total_minor, grand_total_minor, issued_at, external_refs, lifecycle_log)
      VALUES (${ORG}, 'invoice', 'issued', 'INV-2026-0900', 900, 2026, 'EUR', 'DAP', ${issuerId},
       ${CONTACT_A}, 'Exemple Industries SAS', '1 rue de l''Exemple, 75002 Paris', 'compta@exemple-industries.example', 'FR',
       '1 rue de l''Exemple', '75002', 'Paris', 'FR', 10000, 2000, 12000, '2026-09-01', '{}'::jsonb, '[]'::jsonb)`

    // An order of CONTACT_B, a French company with no SIREN on file, parked on its identity.
    await sql`INSERT INTO app_invoicing.counterparty_identities (org_id, contact_id, customer_kind, source, changed_at)
      VALUES (${ORG}, ${CONTACT_B}, 'business', 'derived', now() - interval '1 hour')`
    const payload = {
      id: ORDER,
      order_number: "#8001",
      shop_id: SHOP,
      financial_status: "paid",
      total_price_minor: "12000",
      currency: "EUR",
      customer: {
        id: "cust-8001",
        email: "compta@exemple-industries.example",
        contact_id: CONTACT_B,
        country: "FR",
        legal_name: "Exemple Industries SAS",
        vat_id: null,
        address: "1 rue de l'Exemple\n75002 Paris",
        billing: {
          company: "Exemple Industries SAS",
          line1: "1 rue de l'Exemple",
          line2: null,
          postcode: "75002",
          city: "Paris",
          country_code: "FR",
        },
      },
      line_items: [
        {
          id: "li-8001",
          description: "Widget",
          quantity: "1",
          unit_price_minor: "10000",
          tax_rate_bp: 2000,
          line_kind: "goods",
        },
      ],
    }
    await sql`INSERT INTO app_invoicing.deferred_events
      (org_id, event_id, event_payload_json, status, reason, blocked_on, retry_count, retried_at, contact_id)
      VALUES (${ORG}, ${ORDER}, ${JSON.stringify(payload)}::jsonb, 'awaiting_data', 'einvoice_data_missing',
        ${JSON.stringify({ kind: "einvoice_identity", contact_id: CONTACT_B, code: "einvoice_data_missing" })}::jsonb,
        1, now() - interval '30 minutes', ${CONTACT_B})`
  }, 60_000)

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    toolRegistry.delete([ORG, "shopify", "orders_get"])
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM kernel.approved_handler_executions
      WHERE approval_request_id IN (SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.document_lines WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.counterparty_identities WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.einvoicing_settings WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await releaseTestLock()
  }, 60_000)

  it("S4b: another company's active SIREN from the web -> one approval, zero identity rows; approval confirms it", async () => {
    const before = await approvalCount()
    const res = await callTool("invoicing:counterparty_identity_set", {
      contact_id: CONTACT_A,
      siren: OTHER_SIREN,
      source: "agent_web",
      source_url: "https://web.example/company-page",
    })
    const data = (res.data ?? {}) as Data
    const approvalId = (res.blocked?.approvalRequestId ?? data.approval_id) as string | undefined
    expect(approvalId).toBeTruthy()
    expect(data.status).toBe("pending_approval")
    expect((data.flags as Data).name_mismatch).toBe(true)
    expect(await approvalCount()).toBe(before + 1)
    expect(await identities(CONTACT_A)).toHaveLength(0)
    expect(registryCalls).toBeGreaterThan(0)

    const [card] = await sql<Array<{ summary: unknown }>>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${approvalId!}`
    const cardText = JSON.stringify(card?.summary ?? "")
    expect(cardText).toContain("AUTRE ENTREPRISE FICTIVE")
    expect(cardText).toContain("does not match")

    const decided = await decideApproval({
      orgId: ORG,
      requestId: approvalId!,
      actor,
      decision: "approve",
    })
    expect(decided.status).toBe("approved")
    const rows = await identities(CONTACT_A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      siren: OTHER_SIREN,
      confirmed_via: "approval",
      source: "agent_web",
    })
  }, 60_000)

  it("classify by Shopify order: the parked order would be refused for its missing SIREN", async () => {
    const res = await callTool("invoicing:einvoicing_classify", { shopify_order_id: ORDER })
    const data = res.data as Data
    expect(data.status).toBe("ok")
    expect(data.subject).toBe("order")
    expect((data.would_refuse as Data | null)?.code).toBe("einvoice_data_missing")
    expect((data.buyer as Data).customer_kind).toBe("business")
  }, 60_000)

  it("identity set re-drives the parked order at the next sweep, and it issues", async () => {
    const res = await callTool("invoicing:counterparty_identity_set", {
      contact_id: CONTACT_B,
      siren: OWN_SIREN,
      source: "registry",
    })
    const data = res.data as Data
    expect(data.status).toBe("ok")
    expect(data.confirmed_via).toBe("auto")

    const classified = (await callTool("invoicing:einvoicing_classify", { contact_id: CONTACT_B }))
      .data as Data
    expect(classified.regime).toBe("e_invoice")
    // No invoice exists yet for this contact (billing and category belong to a document): the
    // identity no longer blocks anything.
    const missing = ((classified.would_refuse as Data | null)?.missing ?? []) as Array<{
      field: string
    }>
    expect(missing.map((m) => m.field)).not.toContain("buyer_siren")
    expect((classified.buyer as Data).siren_confirmed).toBe(true)

    const order = (await callTool("invoicing:einvoicing_classify", { shopify_order_id: ORDER }))
      .data as Data
    expect(order.regime).toBe("e_invoice")
    expect(order.would_refuse).toBeNull()

    await runDeferredRetryAsSystem()
    const docs = await sql<
      Array<{ type: string; regime: string | null; buyer_siren: string | null }>
    >`
      SELECT type, regime, buyer_siren FROM app_invoicing.documents
      WHERE org_id = ${ORG} AND shopify_order_id = ${ORDER}`
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ type: "invoice", regime: "e_invoice", buyer_siren: OWN_SIREN })
    // The identity wait is over. (The park may now carry the PDF render step instead, when this
    // harness has no PDF renderer: the invoice itself is issued above.)
    const parks = await sql<Array<{ status: string; blocked_on: { kind?: string } }>>`
      SELECT status, blocked_on FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND event_id = ${ORDER}`
    expect(
      parks.some((p) => p.status === "awaiting_data" && p.blocked_on?.kind === "einvoice_identity"),
    ).toBe(false)
  }, 120_000)

  it("a draft named after another company never confirms that company's SIREN (two-call bypass)", async () => {
    // In a conversation that read nothing from outside, drafts_create runs at once: an agent can
    // name a draft for any contact after any company. (In one that did, the draft itself waits for
    // a person.) The identity call then comes from the conversation that read the web.
    const draft = await callTool(
      "invoicing:drafts_create",
      {
        type: "invoice",
        counterparty_contact_id: CONTACT_C,
        counterparty_name: "Autre Entreprise Fictive SAS",
        counterparty_address: "3 avenue Fictive, 33000 Bordeaux",
        counterparty_email: "compta@autre-fictive.example",
        counterparty_country: "FR",
        issuer_profile_id: issuerId,
        currency: "EUR",
        items: [{ description: "Widget", quantity: "1", unit_price_minor: 10000 }],
      },
      CLEAN_THREAD,
    )
    expect((draft.data as Data).draft_id).toBeTruthy()
    const before = await approvalCount()
    const res = await callTool("invoicing:counterparty_identity_set", {
      contact_id: CONTACT_C,
      siren: OTHER_SIREN,
      source: "agent_web",
      source_url: "https://web.example/other",
    })
    expect((res.data as Data).status).toBe("pending_approval")
    expect(await approvalCount()).toBe(before + 1)
    expect(await identities(CONTACT_C)).toHaveLength(0)
  }, 60_000)

  it("confirmed_via is not a parameter: the kernel refuses it", async () => {
    let status = 0
    try {
      await callTool("invoicing:counterparty_identity_set", {
        contact_id: CONTACT_C,
        siren: OTHER_SIREN,
        source: "manual",
        confirmed_via: "approval",
      })
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
    }
    expect(status).toBe(400)
    expect(await identities(CONTACT_C)).toHaveLength(0)
  }, 60_000)

  it("the issuer lists parks through deferred_list but cannot update them", async () => {
    const listed = (await callTool("invoicing:deferred_list", {})).data as {
      items: Array<{ order_id: string | null }>
    }
    expect(listed.items.map((i) => i.order_id)).toContain(ORDER)

    const aliased = withAppDimensionAliases(actor, "invoicing")
    let updated = -1
    let denied = false
    try {
      updated = await withRlsContext(aliased, async (tx) => {
        const r = (await tx.execute(drizzleSql`
          UPDATE app_invoicing.deferred_events SET retry_count = 99
          WHERE org_id = ${ORG} AND event_id = ${ORDER} RETURNING id`)) as unknown as unknown[]
        return Array.isArray(r) ? r.length : 0
      })
    } catch {
      denied = true
    }
    expect(denied || updated === 0).toBe(true)
    const [park] = await sql<Array<{ retry_count: number }>>`
      SELECT retry_count FROM app_invoicing.deferred_events WHERE org_id = ${ORG} AND event_id = ${ORDER}`
    expect(park?.retry_count).not.toBe(99)
  }, 60_000)
})
