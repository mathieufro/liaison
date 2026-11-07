// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { packageManifestSchema, validateManifest } from "@liaison/app-sdk"
import manifest from "../app.manifest.json"
import * as handlers from "../handlers"
import { TABLE as TRANSITION_TABLE } from "./state"

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The full text of the app guide: `agentInstructions` is now a short core plus tool-keyed
 *  sections (see apps/api/src/modules/agent/context/app-guide.ts), so a content assertion reads
 *  the core and every section together. A plain string guide is a core with no sections. */
const guideText = (m: unknown): string => {
  const ai = (m as { agentInstructions?: unknown }).agentInstructions
  if (typeof ai === "string") return ai
  if (ai && typeof ai === "object") {
    const g = ai as { core?: string; sections?: Array<{ text?: string }> }
    return [g.core ?? "", ...(g.sections ?? []).map((s) => s.text ?? "")].join("\n\n")
  }
  return ""
}

/** Dotted paths of every OPAQUE param on an agent-visible tool — a `type:object` with neither
 *  `properties` nor `additionalProperties:true`, or a `type:array` with no `items` schema. Such a
 *  param hides its shape from the weak agent, which guesses wrong field names → the issuer rejects
 *  the call (the counterparty/items 422 class). `agentVisible:false` tools are system/internal. */
function findOpaqueParams(m: unknown): string[] {
  if (!isObj(m) || !isObj(m.tools)) return []
  const opaque: string[] = []
  const walk = (schema: unknown, path: string): void => {
    if (!isObj(schema)) return
    if (schema.type === "object") {
      const hasProps = isObj(schema.properties) && Object.keys(schema.properties).length > 0
      if (!hasProps && schema.additionalProperties !== true) opaque.push(`${path} (object)`)
    }
    if (schema.type === "array" && !isObj(schema.items)) opaque.push(`${path} (array)`)
    if (isObj(schema.properties))
      for (const [k, v] of Object.entries(schema.properties)) walk(v, `${path}.${k}`)
    if (isObj(schema.items)) walk(schema.items, `${path}[]`)
  }
  for (const [name, tool] of Object.entries(m.tools)) {
    if (!isObj(tool) || tool.agentVisible === false) continue
    const params = isObj(tool.params) ? tool.params : undefined
    const props = params && isObj(params.properties) ? params.properties : undefined
    if (props) for (const [k, v] of Object.entries(props)) walk(v, `${name}.${k}`)
  }
  return opaque
}

describe("invoicing manifest", () => {
  it("declares the heading over its attention items, in the words and catalog key Home shows", () => {
    const attention = (manifest as { attention?: { groupLabel?: unknown } }).attention
    expect(attention?.groupLabel).toEqual({ label: "Invoicing", labelKey: "kernel.homeGroupInvoicing" })
  })

  it("validates against packageManifestSchema", () => {
    const r = packageManifestSchema.safeParse(manifest)
    if (!r.success) {
      console.error("manifest validation failed:", JSON.stringify(r.error.issues, null, 2))
    }
    expect(r.success).toBe(true)
  })

  // Regression (2026-07-24): invoice_issue / invoice_create_and_issue were NOT gated
  // (conditionalGate / no flag), so with the issuer's invoice_approval_threshold unset an
  // agent AUTO-ISSUED a real EUR 18,820 invoice with no human sign-off — while the LESS
  // consequential quotes/proformas were always gated. Every financial-document ISSUANCE
  // tool on the agent surface must be gated:true so the kernel parks it for approval.
  it("every financial-document issuance tool is gated:true (no agent auto-issue of a legal document)", () => {
    const tools = (manifest as { tools: Record<string, { gated?: unknown }> }).tools
    for (const name of [
      "invoice_issue",
      "invoice_create_and_issue",
      "quote_issue",
      "proforma_issue",
      "proforma_create_and_issue",
      "documents_convert_to_invoice",
    ]) {
      expect(tools[name], `${name} missing from manifest`).toBeDefined()
      expect(tools[name]?.gated, `${name} must be gated:true (financial issuance)`).toBe(true)
    }
  })

  // quote_create_and_issue is the deliberate exception: a quote commits nobody to anything, and
  // when the issuer is mapped to a Shopify shop the quote IS a draft order, so the Shopify
  // draft_orders_create gate is the real approval. A kernel gate on top parked a SECOND card for
  // the same decision. Its own handler still gates a large STANDALONE quote against the issuer's
  // invoice threshold, so the tool must keep declaring the approval impact.
  it("quote_create_and_issue is NOT kernel-gated but still declares its approval impact", () => {
    const tools = (
      manifest as { tools: Record<string, { gated?: unknown; approvalImpact?: unknown }> }
    ).tools
    expect(tools.quote_create_and_issue).toBeDefined()
    expect(tools.quote_create_and_issue?.gated ?? false).toBe(false)
    expect(tools.quote_create_and_issue?.approvalImpact).toBeDefined()
  })

  // A quote and its Shopify draft order are one object: the partial UNIQUE is what makes a
  // replayed draft_order event converge on the SAME quote instead of issuing a second one.
  it("documents schema declares the draft-order link columns + their partial UNIQUE", () => {
    const m = manifest as {
      schema: {
        documents: {
          fields: Record<string, unknown>
          constraints?: { unique?: Array<{ columns: string[]; where?: string }> }
          indexes?: string[][]
        }
      }
    }
    expect(m.schema.documents.fields.shopify_draft_order_id).toBe("text?")
    expect(m.schema.documents.fields.shopify_draft_order_name).toBe("text?")
    const uniq = (m.schema.documents.constraints?.unique ?? []).find(
      (u) => u.columns.length === 1 && u.columns[0] === "shopify_draft_order_id",
    )
    expect(uniq, "documents must have UNIQUE(shopify_draft_order_id)").toBeDefined()
    expect(uniq?.where).toMatch(/shopify_draft_order_id IS NOT NULL/i)
    expect(
      (m.schema.documents.indexes ?? []).some(
        (i) => i.length === 1 && i[0] === "shopify_draft_order_id",
      ),
      "documents must index shopify_draft_order_id",
    ).toBe(true)
  })

  // The four draft-order subscriptions are the whole mirror: without them a draft order created
  // in the Shopify admin never becomes a quote, and a completed one leaves its quote stuck in
  // `sent` while the invoice arrives from the order flow.
  it("subscribes to all four shopify/draft_order events + declares the three draft-order calls", () => {
    const m = manifest as {
      events: { subscribes: Record<string, string> }
      cross_app_calls: Array<{ target: string }>
    }
    expect(m.events.subscribes["shopify/draft_order:created"]).toBe("onShopifyDraftOrderCreated")
    expect(m.events.subscribes["shopify/draft_order:updated"]).toBe("onShopifyDraftOrderUpdated")
    expect(m.events.subscribes["shopify/draft_order:completed"]).toBe(
      "onShopifyDraftOrderCompleted",
    )
    expect(m.events.subscribes["shopify/draft_order:deleted"]).toBe("onShopifyDraftOrderDeleted")
    const targets = m.cross_app_calls.map((c) => c.target)
    for (const t of [
      "shopify:draft_orders_get",
      "shopify:draft_orders_create",
      "shopify:draft_orders_complete",
    ]) {
      expect(targets, `cross_app_calls must declare ${t}`).toContain(t)
    }
  })

  // Regression — state-machine ↔ schema-enum drift. EVERY status the transition table can PRODUCE
  // (its right-hand values) must be a valid documents.status enum value, else the transition's
  // `UPDATE documents SET status=<target>` fails the generated CHECK constraint → handler_outcome_unknown
  // 422 on the GATED execution (the action can never complete). `invoiced` (quote/proforma
  // convert_to_invoice) and `pending_approval` (invoice submit_for_approval) were both missing.
  it("every transition-table target status is a valid documents.status enum value", () => {
    const m = manifest as { schema: { documents: { fields: { status: { enum: string[] } } } } }
    const statusEnum = new Set(m.schema.documents.fields.status.enum)
    const producible = [...new Set(Object.values(TRANSITION_TABLE))]
    const missing = producible.filter((s) => !statusEnum.has(s))
    expect(missing, `state-machine targets missing from documents.status enum: ${missing.join(", ")}`).toEqual([])
  })

  // Regression — documents_search advertised "date range" in its description but the params block
  // exposed no date field, so the agent could not pass it (the handler already filters by
  // input.date_range.from/to on issued_at — reads.ts) → a lying description that traps the weak model
  // into a fabricated window (claire-monthly-receivables-aging l284). The param must be exposed and
  // shape-advertised ({from,to}) so the description is honest and the filter is reachable.
  it("documents_search exposes the date_range {from,to} param its description promises", () => {
    const ds = (manifest as { tools: Record<string, { description?: string; params?: unknown }> })
      .tools.documents_search
    expect(ds, "documents_search tool must exist").toBeDefined()
    if (!ds) return
    expect(ds.description ?? "").toContain("date range")
    const props =
      isObj(ds.params) && isObj(ds.params.properties) ? ds.params.properties : undefined
    const dr = props && isObj(props.date_range) ? props.date_range : undefined
    expect(dr, "documents_search must expose a date_range param").toBeDefined()
    const drProps = dr && isObj(dr.properties) ? dr.properties : undefined
    expect(drProps && isObj(drProps.from), "date_range.from must be declared").toBeTruthy()
    expect(drProps && isObj(drProps.to), "date_range.to must be declared").toBeTruthy()
  })

  // Regression (editor 0.2.2/0.3.1) — the kernel validates tool params STRICTLY against the
  // manifest schema, and the mutations accept more than the schemas declared: the editor's
  // real payloads were rejected with invalid_params (issuer_profile_id on quote/proforma/po
  // create_and_issue; incoterm/due_at on drafts_create). Pin every param the Editor UI sends
  // so a schema regression fails here instead of in production clicks.
  it("tool param schemas accept every field the Editor UI sends", () => {
    const tools = (manifest as { tools: Record<string, { params?: unknown }> }).tools
    const propsOf = (name: string): Record<string, unknown> => {
      const t = tools[name]
      expect(t, name + " tool must exist").toBeDefined()
      const p = t && isObj(t.params) && isObj(t.params.properties) ? t.params.properties : undefined
      expect(p, name + " must declare params.properties").toBeDefined()
      return (p ?? {}) as Record<string, unknown>
    }
    const expectProps = (name: string, keys: string[]) => {
      const props = propsOf(name)
      for (const k of keys) {
        expect(props[k], name + " must declare param '" + k + "'").toBeDefined()
      }
    }
    expectProps("drafts_create", [
      "type", "counterparty_contact_id", "counterparty_name", "counterparty_address",
      "counterparty_vat_id", "counterparty_email", "issuer_profile_id", "currency",
      "incoterm", "due_at", "shopify_order_id", "items",
    ])
    expectProps("drafts_update", ["draft_id", "patch"])
    for (const t of ["invoice", "quote", "proforma", "po"]) {
      expectProps(t + "_create_and_issue", [
        "counterparty", "items", "issuer_profile_id", "currency", "incoterm", "due_at",
      ])
      expectProps(t + "_issue", ["draft_id"])
    }
    expectProps("documents_send_to_customer", ["document_id", "to", "subject", "body"])
    // Nullability: the editor legitimately sends null for these (mutation
    // input types are string | null) — a plain "string" schema rejects them.
    const dc = propsOf("drafts_create")
    for (const k of ["counterparty_contact_id", "counterparty_country", "tax_treatment", "shopify_order_id", "due_at"]) {
      const ty = (dc[k] as { type?: unknown })?.type
      expect(Array.isArray(ty) && (ty as unknown[]).includes("null"), "drafts_create." + k + " must allow null").toBe(true)
    }
  })

  it("e-invoicing: credit-note tools declare preflights and issuing tools accept kind, category and structured billing", () => {
    const tools = (manifest as { tools: Record<string, Record<string, unknown>> }).tools
    expect(tools.credit_note_create_and_issue?.preflight).toBe("creditNoteCreateAndIssuePreflightHandler")
    expect(tools.credit_note_issue?.preflight).toBe("creditNoteIssuePreflightHandler")
    expect(typeof (handlers as Record<string, unknown>).creditNoteCreateAndIssuePreflightHandler).toBe("function")
    expect(typeof (handlers as Record<string, unknown>).creditNoteIssuePreflightHandler).toBe("function")
    const props = (name: string, path: string[] = []): Record<string, { enum?: unknown[] }> => {
      let node = (tools[name]?.params as Record<string, unknown>) ?? {}
      for (const key of path) node = ((node.properties as Record<string, unknown>)?.[key] as Record<string, unknown>) ?? {}
      return (node.properties ?? {}) as Record<string, { enum?: unknown[] }>
    }
    const billing = ["billing_line1", "billing_line2", "billing_postcode", "billing_city", "billing_country_code"]
    for (const tool of ["invoice_create_and_issue", "credit_note_create_and_issue"]) {
      const cp = props(tool, ["counterparty"])
      expect(cp.customer_kind?.enum).toEqual(["business", "individual", "public_entity", "non_registered_entity", null])
      for (const f of billing) expect(cp[f], `${tool}.counterparty.${f}`).toBeDefined()
      expect(props(tool).operation_category?.enum).toEqual(["goods", "services", "mixed", null])
    }
    for (const [tool, path] of [["drafts_create", []], ["drafts_update", ["patch"]]] as const) {
      const p = props(tool, [...path])
      for (const f of ["customer_kind", "operation_category", ...billing]) expect(p[f], `${tool} ${f}`).toBeDefined()
    }
    expect(props("documents_convert_to_invoice").operation_category).toBeDefined()
  })

  // Regression (claire-shopify-bf-batch-invoices) — drafts_create must EXPOSE a `currency` param so the
  // agent can match a Shopify order's currency when reconciling it into an invoice. The handler always
  // accepted `input.currency`, but it was NOT in the manifest params, so the runtime stripped it and the
  // agent could only get the issuer's default (EUR). Invoicing a USD-store order then dead-ended: the
  // agent could not express USD, the user's "that's a USD charge, not EUR" objection was unwinnable, and
  // the batch ended unissued. The param must be declared (and its description must teach using the order's
  // currency) so a USD order can become a USD invoice.
  it("drafts_create exposes a `currency` param that teaches matching the Shopify order's currency", () => {
    const dc = (manifest as { tools: Record<string, { params?: unknown }> }).tools.drafts_create
    expect(dc, "drafts_create tool must exist").toBeDefined()
    if (!dc) return
    const props = isObj(dc.params) && isObj(dc.params.properties) ? dc.params.properties : undefined
    const cur = props && isObj(props.currency) ? props.currency : undefined
    expect(cur, "drafts_create must expose a currency param").toBeDefined()
    const desc = (cur && typeof cur.description === "string" ? cur.description : "").toLowerCase()
    expect(desc).toContain("order's currency")
    expect(desc).toContain("usd")
  })

  // Regression (claire-shopify-bf-batch-invoices) — drafts_create must EXPOSE a `shopify_order_id` param
  // so the agent links each invoice to its order. The documents table has a partial UNIQUE constraint on
  // shopify_order_id (one invoice per order), but the param was not exposed, so the agent never set it,
  // the link was always null, the constraint never engaged, and a looping agent double-billed (~35 dup
  // approvals). Exposing the param makes issuance IDEMPOTENT per order. The description must teach the
  // idempotent dedupe so the agent sets it on every batch invoice.
  it("drafts_create exposes a `shopify_order_id` param that teaches idempotent one-invoice-per-order linkage", () => {
    const dc = (manifest as { tools: Record<string, { params?: unknown }> }).tools.drafts_create
    expect(dc, "drafts_create tool must exist").toBeDefined()
    if (!dc) return
    const props = isObj(dc.params) && isObj(dc.params.properties) ? dc.params.properties : undefined
    const soi = props && isObj(props.shopify_order_id) ? props.shopify_order_id : undefined
    expect(soi, "drafts_create must expose a shopify_order_id param").toBeDefined()
    const desc = (soi && typeof soi.description === "string" ? soi.description : "").toLowerCase()
    expect(desc).toContain("idempotent")
    expect(desc).toContain("one invoice")
  })

  // Regression — the documents schema must keep the partial UNIQUE constraint on
  // (shopify_order_id, scope, shipment_ref): the DB backstop that enforces one-invoice-per-order-PER-SCOPE
  // even under a race (a split order legitimately carries a goods document AND a software document for
  // the same shopify_order_id), while allowing ONE proforma per physical shipment batch
  // (distinct shipment_ref values). Guard so a schema refactor can't silently drop the idempotency
  // invariant or collapse it back to a single-column unique (which would break the split).
  it("documents schema keeps the partial UNIQUE constraint on (shopify_order_id, scope, shipment_ref) (idempotency backstop)", () => {
    const m = manifest as {
      schema: {
        documents: {
          fields: Record<string, unknown>
          constraints?: { unique?: Array<{ columns: string[]; where?: string }> }
        }
      }
    }
    const uniques = m.schema.documents.constraints?.unique ?? []
    const soiUnique = uniques.find(
      (u) =>
        u.columns.length === 3 &&
        u.columns[0] === "shopify_order_id" &&
        u.columns[1] === "scope" &&
        u.columns[2] === "shipment_ref",
    )
    expect(
      soiUnique,
      "documents must have a UNIQUE(shopify_order_id, scope, shipment_ref) constraint",
    ).toBeDefined()
    expect(soiUnique?.where, "it must be PARTIAL (only when shopify_order_id IS NOT NULL)").toMatch(
      /shopify_order_id IS NOT NULL/i,
    )
    expect(m.schema.documents.fields.scope, "documents must declare the scope column").toBeDefined()
    expect(
      m.schema.documents.fields.shipment_ref,
      "documents must declare the nullable shipment_ref column",
    ).toBe("text?")
  })

  // Regression (BL-248) — documents_search.query matches counterparty_name (not just the number), and
  // its description teaches the search-by-customer-NAME path so a weak model handed a customer reference
  // ("Claudine Moreau") does not get [] and conclude "no invoice on file" (the chargeback-packet failure).
  it("documents_search description teaches search-by-customer-name (query matches counterparty name)", () => {
    const ds = (manifest as { tools: Record<string, { description?: string }> }).tools
      .documents_search
    expect(ds, "documents_search tool must exist").toBeDefined()
    if (!ds) return
    const desc = (ds.description ?? "").toLowerCase()
    expect(desc).toContain("counterparty name")
    expect(desc).toContain("search their name directly")
  })

  // Regression (BL-248) — EVIDENCE INTEGRITY: the agentInstructions must steer the agent to HOLD a
  // tool-verified document in an evidence packet against an unverifiable user claim that it is
  // "unrelated" / is really a differently-numbered proforma. The weak model capitulated and EXCLUDED
  // the real invoice from the chargeback packet under persistent (false) user pressure; the clause must
  // (a) say a tool-returned document for the customer is real evidence to keep, (b) explain the order
  // pre-tax / invoice subtotal / VAT-inclusive total are the SAME sale, and (c) forbid fabricating the
  // claimed-missing document.
  it("agentInstructions steer EVIDENCE INTEGRITY — hold a tool-verified record, never fabricate a claimed-missing one", () => {
    const ai = guideText(manifest)
    expect(ai).toMatch(/EVIDENCE INTEGRITY/)
    expect(ai).toMatch(/Do NOT delete or exclude a tool-confirmed document/)
    expect(ai).toMatch(/it IS that order's invoice/)
    expect(ai).toMatch(/NEVER fabricate the claimed missing document/)
  })

  // Regression (BL-128) — pending_approvals_list must carry the READ-ONLY governance framing so the
  // weak model reliably tells the user it cannot approve on their behalf (they decide in the UI),
  // instead of intermittently omitting that clause (the approval-inbox-sweep failure mode).
  it("pending_approvals_list description steers READ-ONLY governance (cannot self-approve, user decides in UI)", () => {
    const t = (manifest as { tools: Record<string, { description?: string }> }).tools
      .pending_approvals_list
    expect(t, "pending_approvals_list tool must exist").toBeDefined()
    if (!t) return
    const desc = (t.description ?? "").toLowerCase()
    expect(desc).toContain("read-only")
    expect(desc.includes("cannot approve")).toBe(true)
    expect(desc.includes("ui")).toBe(true)
  })

  // Regression — the opaque-input 422 class (counterparty / items / drafts patch). Every
  // agent-visible object/array param must advertise its shape (described fields or
  // additionalProperties / item schema) so the weak model populates it correctly.
  it("declares NO opaque object/array params on agent-visible tools", () => {
    expect(findOpaqueParams(manifest)).toEqual([])
  })

  // Regression (BL-41) — read/write type asymmetry on `unit_price_minor`. The read tools
  // (documents_get / drafts_update's own return) serialize `unit_price_minor` as a STRING (a bigint
  // is not JSON-safe), but the line-bearing WRITE tools declared it `type:integer` only — so the
  // natural read→patch→write round-trip (echo a line back into drafts_update) was REJECTED pre-handler
  // by ajv ("must be integer, but string was provided"). The agent then loops on the dead-end and never
  // reaches invoice_issue. The handler already coerces a numeric string via coerceMinorAmount, so the
  // INPUT schema must accept the string form too — mirroring `quantity`, which already accepts
  // ["string","number"]. Every agent-visible line-item `unit_price_minor` must accept "string".
  it("every line-item unit_price_minor input accepts the string (read-back) form (BL-41)", () => {
    const offending: string[] = []
    const walk = (schema: unknown, path: string): void => {
      if (!isObj(schema)) return
      if (isObj(schema.properties)) {
        const upm = schema.properties.unit_price_minor
        if (isObj(upm)) {
          const t = upm.type
          const accepts = t === "string" || (Array.isArray(t) && t.includes("string"))
          if (!accepts) offending.push(`${path}.unit_price_minor (type: ${JSON.stringify(t)})`)
        }
        for (const [k, v] of Object.entries(schema.properties)) walk(v, `${path}.${k}`)
      }
      if (isObj(schema.items)) walk(schema.items, `${path}[]`)
    }
    for (const [name, tool] of Object.entries((manifest as { tools: Record<string, unknown> }).tools)) {
      if (!isObj(tool) || tool.agentVisible === false) continue
      const params = isObj(tool.params) ? tool.params : undefined
      if (params) walk(params, name)
    }
    expect(
      offending,
      `unit_price_minor inputs that reject the read-back string form: ${offending.join(" | ")}`,
    ).toEqual([])
  })

  it("validates via validateManifest() without throwing", () => {
    expect(() => validateManifest(manifest)).not.toThrow()
  })

  // Regression (superseded 0.5.0) — credit_note is now a first-class, legally-compliant document
  // type: its own gap-free CN-{YYYY}- number series, referencing the corrected invoice, issued
  // straight to 'issued'. The OLD regression here pinned the opposite ("no credit-note document
  // type... never fabricate one") from before credit notes existed — that guidance is now WRONG
  // and has been rewritten in agentInstructions. This test pins the NEW semantics: the schema DOES
  // advertise credit_note, the instructions explain how to use it (never claim it doesn't exist),
  // and credit_note_create_and_issue / credit_note_issue are real, well-formed tools.
  it("advertises credit_note as a first-class document type with correct guidance", () => {
    const m = manifest as unknown as {
      agentInstructions: string | { core: string; sections: Array<{ text: string }> }
      schema: { documents: { fields: { type: { enum: string[] } } } }
      tools: Record<string, unknown>
    }
    // (a) the real document-type catalogue includes credit_note
    expect(m.schema.documents.fields.type.enum).toContain("credit_note")
    // (b) the agentInstructions list credit notes as a first-class issued type, and no longer
    //     contain the old denial language
    expect(guideText(m)).toMatch(/purchase orders,\s*and credit notes/i)
    expect(guideText(m)).not.toMatch(/there is no credit-note document type/i)
    expect(guideText(m)).not.toMatch(/say plainly that a credit note cannot be issued/i)
    // (c) the instructions explain the reversal recipe: credit_note_create_and_issue with
    //     original_document_id, negative lines, and BOTH the credit note AND documents_record_refund
    //     for a legally clean reversal
    expect(guideText(m)).toMatch(/credit_note_create_and_issue/)
    expect(guideText(m)).toMatch(/original_document_id/)
    expect(guideText(m)).toMatch(/documents_record_refund/)
    expect(guideText(m)).toMatch(/never fake a reversal by editing (an )?invoice'?s? amounts/i)
    // (d) the new tools exist, are well-formed, and are not payable (no due_at param, no mark_paid
    //     coupling implied in their description)
    expect(m.tools).toHaveProperty("credit_note_create_and_issue")
    expect(m.tools).toHaveProperty("credit_note_issue")
    const createAndIssue = m.tools.credit_note_create_and_issue as {
      handler: string
      params: { properties: Record<string, unknown>; required: string[] }
    }
    expect(createAndIssue.handler).toBe("creditNoteCreateAndIssueHandler")
    expect(createAndIssue.params.properties).toHaveProperty("original_document_id")
    expect(createAndIssue.params.properties).toHaveProperty("reason")
    expect(createAndIssue.params.properties).toHaveProperty("counterparty")
    expect(createAndIssue.params.properties).toHaveProperty("items")
    expect(createAndIssue.params.required).toEqual(["counterparty", "items"])
    const issue = m.tools.credit_note_issue as { handler: string }
    expect(issue.handler).toBe("creditNoteIssueHandler")
  })

  // Regression — numbering-audit guidance. The weak agent over-claimed "no gaps" from a single
  // (display-truncated) search page, only stated a from–to range instead of enumerating, and never
  // explained the gap-free-at-issue / drafts-excluded semantics (the scenario's central concept).
  // The agentInstructions must give a prescriptive audit directive, not a buried clause.
  it("gives a prescriptive number-sequence AUDIT directive (enumerate, explain semantics, don't over-claim)", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toContain("audit a number sequence") // prescriptive, not a buried aside
    expect(ai).toContain("in order") // enumerate the retrieved numbers
    expect(ai).toMatch(/gap-free by construction|gap-free at issue/) // explain the semantics
    expect(ai).toMatch(/drafts? (never consume|are excluded)/) // drafts don't consume numbers
    expect(ai).toMatch(/prove the set is complete|smaller than the page limit|re-running the same query never proves/) // completeness-proof, not re-run-and-reassert
  })

  // Regression (claire-day-finance journey S8) — NUMBERING anti-fabrication. In the shared finance-day
  // world the issued series is genuinely non-contiguous (many slices each seed their own number_int),
  // and the weak agent INVERTED the rule ("a discarded draft creates a gap") and INVENTED parallel
  // "sub-series" (00xx/41xx/91xx) to normalize the non-contiguity instead of flagging it. The
  // agentInstructions must forbid both: drafts never create a gap, a real gap/scatter is an anomaly to
  // flag, and inventing sub-series not present in the data is banned.
  it("forbids numbering FABRICATION — no draft-creates-a-gap inversion, no invented sub-series; flag a real gap as anomalous", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/discarding a draft does not create a gap/) // the correct rule, stated against the inversion
    expect(ai).toMatch(/never claim 'a discarded draft creates.*a gap'/) // explicitly forbid the inversion
    expect(ai).toMatch(/anomaly to flag/) // a real/scattered gap is an anomaly to flag, not normalize
    expect(ai).toMatch(/never invent structure that is not in the data/) // no fabricated structure
    expect(ai).toMatch(/parallel \/ independent sub-series/) // names the exact fabrication to ban
  })

  // Regression (claire-day-finance journey S7) — VAT-mismatch detection. The weak agent called
  // vat_validate, got a VIES-valid GB number on a DE ship-to, and instead of catching the post-Brexit
  // GB≠DE mismatch it INFERRED "destination = UK" from the VAT prefix and rubber-stamped a UK-export
  // zero-rating — never reading the actual ship-to country and never refusing/correcting. The
  // agentInstructions must encode: read the ship-to/counterparty COUNTRY (never infer from the VAT
  // prefix), the registration country must MATCH the EU ship-to, and a valid-but-wrong-country number
  // is a red flag to warn + correct, not greenlight.
  it("steers VAT-mismatch detection — registration country must match the EU ship-to; VIES-valid ≠ sufficient", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/vies validity is necessary but not sufficient/) // VIES isValid is not a greenlight
    expect(ai).toMatch(/registration country.*must equal the eu ship-to country/) // the country-match rule
    expect(ai).toMatch(/never infer the destination from the vat number's 2-letter prefix/) // don't infer from the prefix
    expect(ai).toMatch(/valid gb number on a de ship-to is post-brexit wrong/) // the exact GB≠DE teaching case
    expect(ai).toMatch(/refuse to greenlight zero-rating|do not rubber-stamp the zero-rating/) // refuse, not rubber-stamp
  })

  // Regression (claire-day-finance journey S2) — DUNNING overdue gate. In the shared finance world the
  // issued population mixes overdue dealer invoices with NOT-yet-due ones (the AR slice seeds a 'current'
  // Westcoast invoice due in the future); the weak agent dunned that NON-overdue invoice with a 'final
  // notice / past due' email (a false statement to a customer) and mis-mapped tiers. The agentInstructions
  // must encode: only an invoice due_at STRICTLY before today is overdue (≥1 day late); a current/
  // not-yet-due invoice gets NO reminder; the tier follows the actual days-overdue band.
  it("steers DUNNING to dun ONLY overdue invoices (never a not-yet-due one) and map the correct tier", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/dunning \/ overdue reminders/) // a dedicated dunning directive
    expect(ai).toMatch(/an invoice is overdue only if due_at is strictly before today/) // the overdue gate
    expect(ai).toMatch(/never send a dunning .* email for a not-yet-due invoice/) // don't dun a current invoice
    // tier mapping from real days-overdue against the organisation's own reminder bands (org skill)
    expect(ai).toMatch(/map the tier by days-overdue using the organisation's reminder bands/)
    expect(ai).toMatch(/if the organisation has no such skill or it gives no bands, ask the requesting user for the bands before drafting any reminder, never assume day counts/)
    expect(ai).not.toMatch(/\+7 band/)
    expect(ai).toMatch(/no automated multi-stage dunning-sequence primitive/) // no sequence scheduler
  })

  // Regression (claire-day-finance journey S1) — AR-AGING anti-fabrication. In the shared finance-day
  // world the issued-invoice population is larger and the newest-first first page is crowded with
  // recently-issued (not-yet-due) refund/credit invoices, pushing the actual overdue AR invoices onto a
  // later page. The weak agent — pressured to produce an overdue list — INVENTED 31 invoice rows
  // (numbers/counterparties/due-dates absent from the documents_search result) and a confident grand
  // total on top of them. The agentInstructions must forbid fabricating aging rows and mandate
  // pagination to reach the real overdue invoices instead.
  it("forbids AR-aging FABRICATION — every aging row must be a returned invoice; paginate, never invent rows", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/ar anti-fabrication/) // a dedicated AR anti-fabrication directive
    expect(ai).toMatch(/every row in your aging table must be an invoice that appears in your actual documents_search result/)
    expect(ai).toMatch(/never invent invoice rows/) // ban inventing rows/numbers/counterparties
    expect(ai).toMatch(/paginate \(advance the offset\)/) // page to the overdue invoices, don't fabricate
  })

  // Regression (claire-day-finance journey S1, anti-sycophancy) — the data was no longer fabricated
  // (de-contam + judge truncation fixes landed) but the weak agent CAVED over turns to the user's
  // round-number premise: it DROPPED real retrieved invoices to make the total 'clean' and STRIPPED the
  // bounded-tally / no-aggregate caveat from the 'final board number'. The agentInstructions must steer
  // the agent to HOLD THE LINE under pushback — keep every read invoice, keep the caveat in every
  // restatement, never re-label a sampled tally as authoritative because the user pressed.
  it("steers AR-aging ANTI-SYCOPHANCY — hold the computed total + caveat under round-number pushback", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/hold the line under pushback/) // a dedicated anti-cave directive
    expect(ai).toMatch(/do not .* drop or delete a real invoice/) // never drop a real invoice to match a round number
    expect(ai).toMatch(/that caveat must remain in every restatement/) // the caveat survives every turn
    expect(ai).toMatch(/never let user pressure turn an honest sampled tally into a falsely-authoritative round number/)
  })

  // Regression — refund-proposal guidance. The partial-refund scenario went non-green despite a
  // correct, gated refund because the reply was terse: no visible arithmetic, and it never stated
  // the doc becomes 'partial' (an explicit rubric clause). Superseded (0.5.0): now that credit_note
  // is a real type, documents_record_refund is the PAYMENT-event half of a reversal — the
  // agentInstructions must steer the agent to surface the working + the resulting document state
  // AND flag that a credit note is the separate LEGAL-document half (not "no credit-note results").
  it("steers the agent to SHOW refund working + the resulting document state (partial/refunded) and the credit-note pairing", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/when you record a refund/) // a dedicated refund directive (manifest wording)
    expect(ai).toMatch(/show your working|pro-rata breakdown|per-unit/) // visible arithmetic
    expect(ai).toContain("'partial'") // names the partial document state
    expect(ai).toMatch(/does not itself issue a credit note/) // refund ≠ automatic credit note
    expect(ai).toMatch(/also issue one via credit_note_create_and_issue/) // steers toward the paired legal document
  })

  // BL-34 — a quote→invoice conversion (documents_convert_to_invoice) proposal must report the RESULTING
  // document's number scheme + re-derived tax treatment, not just "pending approval". quote-to-invoice-
  // westcoast-25units folded pass/pass/fail on near-identical terse reports that all omitted the number
  // scheme + export VAT treatment (the judge enforced the rubric clause non-deterministically); the fix
  // raises the agent to consistently include them — mirroring the refund/audit/listing reply-completeness
  // pattern. General (no fixture-coupled prefix), so it also de-risks the other conversion/issuance scenarios.
  it("steers a quote→invoice CONVERSION proposal to report the resulting number scheme + re-derived tax treatment", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/quote→invoice conversion|when you propose a quote.invoice conversion/) // a dedicated conversion directive
    expect(ai).toMatch(/number scheme|next sequential number in the org's invoice series/) // resulting number scheme
    expect(ai).toMatch(/allocated gap-free at issue/) // number allocated gap-free at issue, never fabricated
    expect(ai).toMatch(/never fabricating the exact number/) // never fabricate the exact number
    expect(ai).toMatch(/tax treatment, re-derived from the counterparty country/) // resulting tax treatment
    expect(ai).toMatch(/a conversion reply that omits .* is incomplete/) // a bare conversion reply is incomplete
  })

  // BL-35 — export-invoice HS-code assignment. claire-export-invoice-aki-sato-customs thrashed 14 turns
  // (then went blank) because the agentInstructions told the agent "HS codes are NOT a draft-line field:
  // assign each export line's code with hs_codes_assign" — but hs_codes_assign requires the product's
  // product_source + external_id (a free-text invoice line has none), so every call failed `invalid_input`.
  // The working path is INLINE on the line at drafts_create (issue.ts: "inline customs facts win"); the fix
  // directs that and demotes hs_codes_assign to the optional product-overlay it is.
  it("steers export customs facts into the line's STRUCTURED fields at drafts_create (not hs_codes_assign, not the line description)", () => {
    const ai = guideText(manifest).toLowerCase()
    expect(ai).toMatch(/structured fields at drafts_create/) // the working path — line's own fields
    expect(ai).toMatch(/these are draft-line fields/) // hs_code/customs_description/country_of_origin ARE line fields
    // BL-35 layer 2 — customs_description is a DEDICATED field, not the line's item `description`
    expect(ai).toMatch(/dedicated line field/)
    expect(ai).toMatch(/not in the line's `description`/) // do not fold customs text into the item name
    expect(ai).toMatch(/do not use hs_codes_assign to put an hs code on a one-off invoice line/) // not the per-line path
    expect(ai).toMatch(/product_source \+ external_id/) // why hs_codes_assign fails on a line
    // the old misleading claim must be gone
    expect(ai).not.toMatch(/hs codes are not a draft-line field/)
    // BL-37 (l87) — the agent stochastically RUSHED customs-japan run-3 (drafts_create → invoice_issue in
    // 2 turns, skipping HS codes entirely → invalid customs invoice). Forbid issuing an export invoice
    // before per-line HS codes are set.
    expect(ai).toMatch(/never issue an export invoice/)
    expect(ai).toMatch(/do not rush straight from drafts_create to invoice_issue/)
    // BL-38 (l88) — customs-japan failed SYSTEMATICALLY (0/2): the agent rush-issued (contacts_search →
    // drafts_create → invoice_issue) and only NARRATED the HS codes — never a documents_get / hs_codes_*
    // to put them on (or surface them from) the document, so the judge could not verify them and treated
    // the deliverable as unset (vs aki-customs, which passed by tool-backing inline codes via documents_get).
    // Require the agent to tool-back every per-line HS code it claims.
    expect(ai).toMatch(/tool-back every per-line hs code/)
    expect(ai).toMatch(/will be treated as unset/)
  })

  // Regression — immutable-issued-doc + never-blank. The quote-to-invoice 3x run flaked: after the
  // invoice issued, the persona asked to add customs/HS-codes to the ALREADY-ISSUED invoice (a post-
  // issue impossible op), and the weak agent returned 7 consecutive BLANK replies (empty text, no
  // tools) → an 18-turn non-completion. The agentInstructions must (a) state issued docs are
  // immutable and (b) forbid empty replies, giving the agent a path to respond instead of going mute.
  it("tells the agent what stays immutable after issue, the documents_update path, and to NEVER reply empty", () => {
    const ai = guideText(manifest).toLowerCase()
    // 0.7.8: an issued document's identity fields (number/type/status/issuer/currency)
    // stay immutable AND its financial substance is frozen — issued corrections to
    // lines/tax/counterparty legal identity go through a CREDIT NOTE, not an in-place
    // documents_update; only metadata (address/email/dates) stays editable post-issue.
    // Financial reversals still record a refund. The instructions must say all of this
    // so the agent neither edits amounts to fake a refund nor mutates an issued invoice.
    expect(ai).toMatch(/number, type, status, issuer, and currency are immutable/)
    expect(ai).toMatch(/documents_update/) // the correction path exists
    expect(ai).toMatch(/credit_note_create_and_issue/) // issued financial corrections go through a credit note
    expect(ai).toMatch(/financial substance is frozen/i) // issued invoices are immutable
    expect(ai).toMatch(/documents_record_refund/) // reversals stay refund-shaped
    expect(ai).toMatch(/do not edit an invoice's amounts to simulate a refund/)
    expect(ai).toMatch(/never send an empty message|never (send an empty message|go silent)/) // never-blank
  })

  // Regression — the invoicing-overview SKILL must convey the issued-sequence domain model. The
  // numbering-gap audit failed (defectClass "skill") because the agent never explained gap-free-at-
  // issue / drafts-don't-consume semantics; the skill body was a shallow user overview. A discoverable
  // skill is the right home for domain semantics (richer than the always-loaded agentInstructions).
  it("invoicing-overview skill conveys the gap-free-at-issue numbering domain model", () => {
    const skills = (manifest as { skills: Record<string, { body: string } | undefined> }).skills
    const skill = skills["invoicing-overview"]
    expect(skill, "invoicing-overview skill must exist").toBeDefined()
    const body = (skill?.body ?? "").toLowerCase()
    expect(body).toMatch(/gap-free at issue|allocated gap-free/) // numbers allocated gap-free at issue
    expect(body).toMatch(/discarding a draft never consumes|drafts are unnumbered/) // drafts don't consume numbers
  })

  // Regression — period-listing + capability-honesty + onboarding guidance (the finance-next batch).
  // monthend-close rendered a flat invoice list but OMITTED the per-treatment grouping and the
  // bounded-listing caveat; intra-eu-reverse-charge/vies failed because the agent had no VIES guidance
  // and could not onboard a NEW customer (drafts_create has no inline counterparty_name, so a named
  // invoice needs a contact). The agentInstructions must steer all three.
  it("steers period-listing (group + bounded caveat), VIES honesty, and new-customer onboarding", () => {
    const ai = guideText(manifest).toLowerCase()
    // period-listing checklist (month-end close / VAT return / EC Sales List)
    expect(ai).toContain("when you list documents for a period")
    expect(ai).toContain("group and count by tax_treatment")
    expect(ai).toMatch(/bounded in-context listing|not an authoritative server-computed aggregate/)
    // VIES validation — now via the vat_validate tool (l65: the stale "no VIES tool / use web_fetch"
    // guidance was replaced when l62 added the real vat_validate EU-VIES affordance).
    expect(ai).toMatch(/use the vat_validate tool/)
    expect(ai).toMatch(/never use web_fetch as the validation source/)
    // new-customer onboarding (a named invoice REQUIRES a contact)
    expect(ai).toContain("if the customer is new")
    expect(ai).toMatch(/named invoice requires a contact/)
  })

  // Regression — gated-action invocation + VIES via vat_validate + VAT-correction discipline.
  // two-eyes: the agent FABRICATED a markdown "[Approve Refund](…)" link instead of CALLING the gated
  // tool. vies (l62): validation now uses the vat_validate EU-VIES tool (NOT web_fetch). claire-edit
  // VAT-correction (BL-25, l65): on the fail the agent stored the corrected VAT only in free-text, then
  // PREMATURELY issued the invoice with the placeholder VAT and FABRICATED that the correction was done.
  it("steers gated-action invocation + vat_validate-based VIES + VAT-correction discipline (no premature issue, no fabrication)", () => {
    const ai = guideText(manifest).toLowerCase()
    // gated action = CALL the tool, do not fabricate a link, cite the gate
    expect(ai).toMatch(/must actually call its tool/)
    expect(ai).toMatch(/never fabricate a link \/ button \/ markdown url/) // do not fabricate an approval link/button
    expect(ai).toMatch(/cite the relevant policy \+ approver/) // cite the gate's policy + approver
    // the approver is organisation data (the org skill), with an ask-the-user fallback when absent
    expect(ai).toMatch(/both the threshold and the approver from the organisation's escalation contacts: kernel skill_read the org skill 'escalation-contacts'/)
    expect(ai).toMatch(/if the organisation has no such skill, say it needs a second person with approval authority and ask the requesting user who that is, never invent a name/)
    // the two-eyes threshold amount is organisation policy too: no number in the product text
    expect(ai).toMatch(/never assume a threshold amount: before any refund that could need approval, ask the requesting user/)
    expect(ai).not.toMatch(/200\s?(€|eur)/)
    // VIES: validate via vat_validate, report accurately, never web_fetch / fabricate / infer
    expect(ai).toMatch(/use the vat_validate tool/)
    expect(ai).toMatch(/never use web_fetch as the validation source/)
    expect(ai).toMatch(/never fabricate, embellish, or infer a result/)
    expect(ai).toMatch(/industry documentation/) // still forbidden as an inference source
    expect(ai).toMatch(/system-validated via vies/) // success-case storage note (vies rubric)
    expect(ai).toMatch(/not system-validated/) // unconfirmed-case note, kept under pressure
    // VAT CORRECTION (BL-25): write the corrected VAT via contacts_write; do NOT issue until written;
    // never report it done unless the tool call actually succeeded.
    expect(ai).toMatch(/correcting a contact's vat/)
    expect(ai).toMatch(/write the corrected number to the contact with contacts_write/)
    expect(ai).toMatch(/do not issue the invoice until that write has succeeded/)
    expect(ai).toMatch(/never report a validation or correction as done unless the underlying tool call actually succeeded/)
  })

  // Regression — the send_to_customer recipient-resolution bridge. The handler resolves the recipient
  // via kernel:contacts_read (linked contact) and, on miss, kernel:contacts_search (by counterparty
  // name). Both must be declared in cross_app_calls or the runtime rejects the call `forbidden: missing
  // scope` and the send dead-ends on no_recipient for a known customer (the issue-dealer flake).
  it("declares the kernel:contacts_read + contacts_search cross_app_calls used by send_to_customer", () => {
    const m = manifest as { cross_app_calls?: Array<{ target?: string }> }
    const targets = (m.cross_app_calls ?? []).map((c) => c.target)
    expect(targets).toContain("kernel:contacts_read")
    expect(targets).toContain("kernel:contacts_search")
  })

  it("declares non-empty scopes following the scope shape", () => {
    expect(manifest.scopes.length).toBeGreaterThan(0)
    for (const s of manifest.scopes) {
      expect(s).toMatch(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*){1,2}$/)
    }
  })

  it("declares the Phase-17 capabilities (messages.post, pdf.render, sequences.allocate)", () => {
    expect(manifest.capabilities).toContain("messages.post")
    expect(manifest.capabilities).toContain("pdf.render")
    expect(manifest.capabilities).toContain("sequences.allocate")
    // A Shopify order's customer becomes an organisation contact.
    expect(manifest.capabilities).toContain("contacts.addToOrganisation")
  })

  it("declares the contact_detail slot panel surface (panels array present, possibly empty)", () => {
    expect(manifest.slots).toBeDefined()
    expect(manifest.slots.contact_detail).toBeDefined()
    expect(Array.isArray(manifest.slots.contact_detail.panels)).toBe(true)
  })

  it("every declared handler resolves to a named export of handlers.ts", () => {
    const handlerNames: string[] = []
    const m = manifest as {
      tools?: Record<string, { handler?: string; preflight?: string }>
      events?: { subscribes?: Record<string, string> }
      jobs?: Record<string, { handler?: string }>
      attention?: { handler?: string }
      search?: { handler?: string }
      webhooks?: Record<string, { handler?: string; verify?: string }>
    }
    for (const t of Object.values(m.tools ?? {})) {
      if (t.handler) handlerNames.push(t.handler)
      // A stage-time `preflight` is loaded from the SAME bundle as the handler, so a name that
      // does not resolve there silently leaves the gated tool validating only after approval.
      if (t.preflight) handlerNames.push(t.preflight)
    }
    for (const w of Object.values(m.webhooks ?? {})) {
      if (w.handler) handlerNames.push(w.handler)
      if (w.verify) handlerNames.push(w.verify)
    }
    for (const v of Object.values(m.events?.subscribes ?? {})) handlerNames.push(v)
    for (const j of Object.values(m.jobs ?? {})) {
      if (j.handler) handlerNames.push(j.handler)
    }
    if (m.attention?.handler) handlerNames.push(m.attention.handler)
    if (m.search?.handler) handlerNames.push(m.search.handler)
    for (const name of handlerNames) {
      expect(
        (handlers as Record<string, unknown>)[name],
        `manifest references handler "${name}" but it is not exported from handlers.ts`,
      ).toBeTypeOf("function")
    }
  })

  // Regression — counterparty snapshot columns. app_invoicing.documents must declare the additive
  // columns that persist the full counterparty (not just name/country) at issue time, so a PDF
  // re-render and documents_get/search can reproduce the Bill-to block.
  it("documents schema declares the nullable counterparty_address/vat_id/email snapshot columns", () => {
    const fields = (manifest as { schema: { documents: { fields: Record<string, unknown> } } })
      .schema.documents.fields
    for (const col of ["counterparty_address", "counterparty_vat_id", "counterparty_email"]) {
      expect(fields[col], `documents.${col} must be declared`).toBe("text?")
    }
  })

  // documents_update — new post-issue editing tool. Pin every declared param + its nullability so a
  // schema regression (a dropped param, or a plain "string" that rejects the editor's legitimate
  // null) fails here instead of in production.
  describe("documents_update tool", () => {
    const tool = (manifest as { tools: Record<string, { params?: unknown; requiredScopes?: string[]; handler?: string }> })
      .tools.documents_update

    it("exists, is scoped invoicing:documents:write, and resolves its handler", () => {
      expect(tool, "documents_update tool must exist").toBeDefined()
      expect(tool?.requiredScopes).toEqual(["invoicing:documents:write"])
      expect(tool?.handler).toBe("documentsUpdateHandler")
      expect((handlers as Record<string, unknown>).documentsUpdateHandler).toBeTypeOf("function")
    })

    it("requires only `id`; every other header field is optional and nullable", () => {
      const params = tool?.params as { required?: string[]; properties?: Record<string, unknown> }
      expect(params.required).toEqual(["id"])
      const props = params.properties ?? {}
      for (const key of [
        "counterparty_name",
        "counterparty_address",
        "counterparty_vat_id",
        "counterparty_email",
        "counterparty_country",
        "counterparty_contact_id",
        "issued_at",
        "due_at",
        "tax_treatment",
      ]) {
        const p = props[key] as { type?: unknown } | undefined
        expect(p, `documents_update must declare '${key}'`).toBeDefined()
        const ty = p?.type
        expect(
          Array.isArray(ty) && (ty as unknown[]).includes("null"),
          `documents_update.${key} must accept null`,
        ).toBe(true)
      }
      // incoterm is a fixed enum (not nullable — omit to leave unchanged).
      const incoterm = props.incoterm as { type?: unknown; enum?: unknown[] } | undefined
      expect(incoterm, "documents_update must declare 'incoterm'").toBeDefined()
      expect(incoterm?.type).toBe("string")
      expect(incoterm?.enum).toContain("DAP")
      // lines is present but not required (omitting it must leave lines untouched).
      expect(props.lines, "documents_update must declare 'lines'").toBeDefined()
    })

    it("does NOT expose number/type/status/issuer_profile_id/currency — those are immutable here", () => {
      const params = tool?.params as { properties?: Record<string, unknown> }
      const props = params.properties ?? {}
      for (const forbidden of ["number", "type", "status", "issuer_profile_id", "currency"]) {
        expect(props[forbidden], `documents_update must NOT declare '${forbidden}'`).toBeUndefined()
      }
    })

    it("lines items use the same per-line shape as drafts_update (unit_price_minor accepts the string read-back form)", () => {
      const params = tool?.params as {
        properties?: { lines?: { items?: { properties?: Record<string, unknown>; required?: string[] } } }
      }
      const lineProps = params.properties?.lines?.items?.properties ?? {}
      for (const key of [
        "description",
        "quantity",
        "unit_price_minor",
        "tax_rate_bp_override",
        "hs_code",
        "country_of_origin",
        "customs_description",
        "product_source",
        "external_id",
      ]) {
        expect(lineProps[key], `documents_update line item must declare '${key}'`).toBeDefined()
      }
      const upm = lineProps.unit_price_minor as { type?: unknown }
      const t = upm.type
      expect(t === "string" || (Array.isArray(t) && (t as unknown[]).includes("string"))).toBe(true)
      expect(params.properties?.lines?.items?.required).toEqual([
        "description",
        "quantity",
        "unit_price_minor",
      ])
    })
  })

  // Regression — Part 3 customs enrichment on creation paths. Every *_create_and_issue variant (and
  // drafts_create / drafts_update.lines) must expose product_source + external_id per line so an
  // agent-created document can opt into the SAME product_customs_overlay enrichment the Shopify
  // paid-order auto-flow gets (issueDocument's enrichLineCustoms), not just the free-text
  // hs_code/customs_description/country_of_origin fields.
  it("every line-item schema (create_and_issue variants + drafts) declares product_source + external_id", () => {
    const tools = (manifest as { tools: Record<string, { params?: unknown }> }).tools
    const lineItemPropsOf = (toolName: string, path: string[]): Record<string, unknown> => {
      // biome-ignore lint/suspicious/noExplicitAny: walking a JSON-schema-shaped manifest object.
      let node: any = tools[toolName]?.params
      for (const p of path) node = node?.[p]
      expect(node, `${toolName}: could not resolve line-item properties at ${path.join(".")}`).toBeDefined()
      return (node ?? {}) as Record<string, unknown>
    }
    const targets: Array<[string, string[]]> = [
      ["invoice_create_and_issue", ["properties", "items", "items", "properties"]],
      ["quote_create_and_issue", ["properties", "items", "items", "properties"]],
      ["proforma_create_and_issue", ["properties", "items", "items", "properties"]],
      ["po_create_and_issue", ["properties", "items", "items", "properties"]],
      ["drafts_create", ["properties", "items", "items", "properties"]],
      ["drafts_update", ["properties", "patch", "properties", "lines", "items", "properties"]],
      ["documents_update", ["properties", "lines", "items", "properties"]],
    ]
    for (const [toolName, path] of targets) {
      const props = lineItemPropsOf(toolName, path)
      for (const key of ["product_source", "external_id"]) {
        const p = props[key] as { type?: unknown } | undefined
        expect(p, `${toolName} line item must declare '${key}'`).toBeDefined()
        const ty = p?.type
        expect(
          Array.isArray(ty) && (ty as unknown[]).includes("null"),
          `${toolName} line item '${key}' must accept null`,
        ).toBe(true)
      }
    }
  })

  // Editor UI — Customer section. drafts_create / drafts_update.patch must expose the counterparty
  // snapshot fields (name/address/VAT id/email) the editor's new "Customer" section writes, and they
  // must be nullable (the editor legitimately clears a field to null).
  describe("counterparty snapshot params (drafts_create / drafts_update)", () => {
    const COUNTERPARTY_SNAPSHOT_KEYS = [
      "counterparty_name",
      "counterparty_address",
      "counterparty_vat_id",
      "counterparty_email",
    ]

    it("drafts_create declares all four counterparty snapshot params, each nullable", () => {
      const dc = (manifest as { tools: Record<string, { params?: unknown }> }).tools.drafts_create
      expect(dc, "drafts_create tool must exist").toBeDefined()
      const props = isObj(dc?.params) && isObj(dc.params.properties) ? dc.params.properties : undefined
      expect(props, "drafts_create must declare params.properties").toBeDefined()
      for (const key of COUNTERPARTY_SNAPSHOT_KEYS) {
        const p = props?.[key] as { type?: unknown } | undefined
        expect(p, `drafts_create must declare '${key}'`).toBeDefined()
        const ty = p?.type
        expect(
          Array.isArray(ty) && (ty as unknown[]).includes("null"),
          `drafts_create.${key} must accept null`,
        ).toBe(true)
      }
    })

    it("drafts_update.patch declares all four counterparty snapshot params, each nullable", () => {
      const du = (manifest as { tools: Record<string, { params?: unknown }> }).tools.drafts_update
      expect(du, "drafts_update tool must exist").toBeDefined()
      const patchProps =
        isObj(du?.params) && isObj(du.params.properties) && isObj(du.params.properties.patch) && isObj(du.params.properties.patch.properties)
          ? du.params.properties.patch.properties
          : undefined
      expect(patchProps, "drafts_update.patch must declare properties").toBeDefined()
      for (const key of COUNTERPARTY_SNAPSHOT_KEYS) {
        const p = patchProps?.[key] as { type?: unknown } | undefined
        expect(p, `drafts_update.patch must declare '${key}'`).toBeDefined()
        const ty = p?.type
        expect(
          Array.isArray(ty) && (ty as unknown[]).includes("null"),
          `drafts_update.patch.${key} must accept null`,
        ).toBe(true)
      }
    })
  })

  // Settings — logo upload. The invoicing app must declare an `issuer_profile` fileParent so the
  // Settings UI can upload a logo scoped to one issuer profile via /api/files/upload-url +
  // /api/files/confirm, then persist the returned file id via settings_issuer_profile_update.
  it("declares an issuer_profile fileParent scoped to invoicing:settings:read/write", () => {
    const m = manifest as {
      entities?: Record<
        string,
        { tableName?: string; fileParent?: { tableName?: string; schemaRef?: string; joinOn?: string; readScope?: string; writeScope?: string } }
      >
    }
    const entity = m.entities?.issuer_profile
    expect(entity, "manifest.entities.issuer_profile must exist").toBeDefined()
    expect(entity?.fileParent, "issuer_profile entity must declare a fileParent").toBeDefined()
    expect(entity?.fileParent?.tableName).toBe("issuer_profiles")
    expect(entity?.fileParent?.schemaRef).toBe("app_invoicing")
    expect(entity?.fileParent?.joinOn).toBe("id")
    expect(entity?.fileParent?.readScope).toBe("invoicing:settings:read")
    expect(entity?.fileParent?.writeScope).toBe("invoicing:settings:write")
  })

  // settings_issuer_profile_update must accept logo_file_id (null to remove) — its schema is
  // `additionalProperties: true` with only `id` required, so any field is structurally accepted;
  // pin that logo_file_id specifically round-trips through the whitelist by checking the handler
  // module exports a symbol that mutations.ts's ISSUER_WRITE_COLUMNS test (mutations.test.ts) covers.
  it("settings_issuer_profile_update params are an explicit list that still reaches logo_file_id", () => {
    const t = (manifest as { tools: Record<string, { params?: unknown; required?: string[] } | undefined> }).tools
      .settings_issuer_profile_update
    expect(t, "settings_issuer_profile_update tool must exist").toBeDefined()
    const params = t?.params as
      | { additionalProperties?: unknown; required?: string[]; properties?: Record<string, unknown> }
      | undefined
    expect(params?.additionalProperties).toBe(false)
    expect(Object.keys(params?.properties ?? {})).toContain("logo_file_id")
    expect(params?.required).toEqual(["id"])
  })

  // ── prices_include_tax ───────────────────────────────────────────────────
  // The issuer-profile setting that mirrors the Shopify shop's "include tax in prices". It has to
  // be BOTH a real column (the handler persists it) and a declared, described param on the two
  // settings tools, or the agent cannot see it exists and will never set it to match the shop.
  it("issuer_profiles declares the prices_include_tax boolean column, defaulting to off", () => {
    const schema = (manifest as unknown as {
      schema: Record<string, { fields?: Record<string, unknown> } | undefined>
    }).schema
    const col = schema.issuer_profiles?.fields?.prices_include_tax as
      | { type?: string; default?: unknown }
      | undefined
    expect(col, "issuer_profiles.prices_include_tax column must exist").toBeDefined()
    expect(col?.type).toBe("boolean")
    expect(col?.default).toBe(false)
  })

  it("settings_issuer_profile_create/update declare prices_include_tax with the Shopify-mirror explanation", () => {
    const tools = (manifest as unknown as {
      tools: Record<string, { params?: { properties?: Record<string, { type?: string; description?: string }> } }>
    }).tools
    for (const name of ["settings_issuer_profile_create", "settings_issuer_profile_update"]) {
      const prop = tools[name]?.params?.properties?.prices_include_tax
      expect(prop, `${name} must declare prices_include_tax`).toBeDefined()
      expect(prop?.type).toBe("boolean")
      expect(prop?.description).toContain("include tax in prices")
      expect(prop?.description).toContain("net")
    }
  })

  it("agentInstructions explain that typed prices follow prices_include_tax", () => {
    const ai = guideText(manifest)
    expect(ai).toContain("prices_include_tax")
    expect(ai).toMatch(/settings_issuer_profile_update/)
    expect(ai).toMatch(/catalog lines always take the store price/)
  })

  it("quote_create_and_issue points custom lines at the prices_include_tax setting", () => {
    const desc = (manifest as unknown as { tools: Record<string, { description?: string }> })
      .tools.quote_create_and_issue?.description
    expect(desc).toContain("prices_include_tax")
  })

  // drafts_update / documents_update `lines` is a FULL REPLACEMENT, gross-under-inclusive-issuer,
  // with no way to tell a freshly typed price apart from an echoed read-back one. An agent (or
  // MCP caller) editing one line has to read the others back first, and replaying those net
  // values unchanged compounds exactly like the Editor did before the fix — these pin that both
  // tools' `lines` param description warns against it in the manifest itself, where the agent
  // actually reads it.
  it("drafts_update patch.lines warns that a read-back line is already net and must not be echoed back", () => {
    type ManifestTools = {
      tools: Record<
        string,
        { params?: { properties?: Record<string, { properties?: Record<string, { description?: string }> }> } }
      >
    }
    const desc = (manifest as unknown as ManifestTools).tools.drafts_update?.params?.properties?.patch
      ?.properties?.lines?.description
    expect(desc).toContain("GROSS")
    expect(desc).toContain("ALREADY NET")
    expect(desc).toMatch(/never echo|not echo/)
  })

  it("documents_update lines warns that a read-back line is already net and must not be echoed back", () => {
    type ManifestTools = {
      tools: Record<string, { params?: { properties?: Record<string, { description?: string }> } }>
    }
    const desc = (manifest as unknown as ManifestTools).tools.documents_update?.params?.properties?.lines
      ?.description
    expect(desc).toContain("GROSS")
    expect(desc).toContain("ALREADY NET")
    expect(desc).toMatch(/never echo|not echo/)
  })

  // ── document search entity ───────────────────────────────────────────────
  // The global command palette (the only cross type search box) collects searchable entities
  // from every installed app manifest. Invoicing documents were absent from it, so pasting a
  // PO number into the palette blind returned nothing. This registers a `document` entity,
  // restricted to invoicing:documents:read (financial data), not an org wide scope.
  it("declares a document entity, searchable, restricted to invoicing:documents:read", () => {
    const m = manifest as unknown as {
      entities?: Record<
        string,
        {
          labelField?: string
          searchable?: boolean
          tableName?: string
          readScope?: string
          indexFields?: { title?: string; handle?: string; labelSecondary?: string; body?: string }
        }
      >
    }
    const entity = m.entities?.document
    expect(entity, "manifest.entities.document must exist").toBeDefined()
    expect(entity?.searchable).toBe(true)
    expect(entity?.tableName).toBe("documents")
    expect(entity?.readScope, "document entity must be scoped to the read grant, not an org wide scope").toBe(
      "invoicing:documents:read",
    )
    expect(entity?.indexFields?.title, "document entity must declare indexFields.title").toBe("number")
  })

  it("a document's handle is its number: ours, and the reference the agent reads (A37)", () => {
    const fields = (manifest as unknown as {
      entities: Record<string, { indexFields?: { handle?: string; bodyFields?: string[] } }>
    }).entities.document?.indexFields
    expect(fields?.handle).toBe("number")
    // A PO number is the customer's text, so it never names the record. Search still finds it.
    expect(fields?.bodyFields).toContain("po_number")
  })

  it("documents table indexes include po_number for the document search entity", () => {
    const schema = (manifest as unknown as {
      schema: Record<string, { indexes?: unknown[][] } | undefined>
    }).schema
    const indexes = schema.documents?.indexes ?? []
    const hasPoNumberIndex = indexes.some((idx) => Array.isArray(idx) && idx.length === 1 && idx[0] === "po_number")
    expect(hasPoNumberIndex, "documents.indexes must include [\"po_number\"]").toBe(true)
  })

  // Guard: an emitted event action not declared in events.emits throws at runtime. Scan the app's
  // own source for every literal `document:<action>` style string it could produce (entity
  // "document" + action) and require each to be present in the manifest's declared emits.
  it("every document:* event the app source can emit is declared in events.emits", () => {
    const emits = (manifest as unknown as { events?: { emits?: string[] } }).events?.emits ?? []
    const srcDir = new URL("..", import.meta.url).pathname
    const files = [
      `${srcDir}src/issue.ts`,
      ...readdirSync(`${srcDir}src/mutations`)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `${srcDir}src/mutations/${f}`),
      `${srcDir}src/handlers/reconcile-shopify-payments.ts`,
      `${srcDir}src/handlers/shopify-order-cancelled.ts`,
    ]
    const found = new Set<string>()
    for (const path of files) {
      const text = readFileSync(path, "utf8")
      const entityBlockRe = /entity:\s*["']document["'][\s\S]{0,80}?action:\s*["']([a-z_]+)["']/g
      let match: RegExpExecArray | null
      while ((match = entityBlockRe.exec(text)) !== null) {
        found.add(`document:${match[1]}`)
      }
    }
    expect(found.size, "expected to find at least one document:* emit in source").toBeGreaterThan(0)
    for (const action of found) {
      expect(emits, `events.emits must declare '${action}'`).toContain(action)
    }
  })

  // ── free-text document notes ───────────────────────────────────────────────
  // red: drop `notes` from the schema (or from any of these tools' params) -> the kernel's
  // assertKnownParams rejects the call before the handler runs, so the field is unreachable
  // from the agent surface even though mutations.ts persists it.
  it("declares documents.notes as an optional text column", () => {
    const schema = (manifest as unknown as {
      schema: Record<string, { fields?: Record<string, unknown> } | undefined>
    }).schema
    expect(schema.documents?.fields?.notes, "schema.documents.fields.notes must be \"text?\"").toBe("text?")
  })

  it("exposes an optional notes param on every tool that creates or edits a document", () => {
    const tools = (manifest as unknown as {
      tools: Record<string, { params?: { properties?: Record<string, unknown>; required?: string[] } }>
    }).tools
    const direct = [
      "drafts_create",
      "documents_update",
      "invoice_create_and_issue",
      "quote_create_and_issue",
      "proforma_create_and_issue",
      "po_create_and_issue",
      "credit_note_create_and_issue",
      "documents_convert_to_invoice",
      "order_reissue_apply",
    ]
    for (const name of direct) {
      const props = tools[name]?.params?.properties
      expect(props, `${name} must declare params.properties`).toBeDefined()
      const notes = props?.notes as { type?: unknown; description?: string } | undefined
      expect(notes, `${name} must expose a notes param`).toBeDefined()
      expect(notes?.type, `${name}.notes must accept a string or null`).toEqual(["string", "null"])
      expect(
        notes?.description,
        `${name}.notes must document the 2000 character cap`,
      ).toContain("2000")
      expect(tools[name]?.params?.required ?? []).not.toContain("notes")
    }
    // drafts_update takes its fields under `patch`, not at the top level.
    const patch = (tools.drafts_update?.params?.properties?.patch ?? {}) as {
      properties?: Record<string, unknown>
    }
    expect(patch.properties?.notes, "drafts_update.patch must expose notes").toBeDefined()
  })

  it("documents_update's description lists notes among the fields editable after issue", () => {
    const desc = (manifest as unknown as {
      tools: Record<string, { description?: string }>
    }).tools.documents_update?.description ?? ""
    expect(desc).toContain("po_number, notes) stays editable post-issue")
  })

  it("the documents export schema carries notes", () => {
    const exportSchema = (manifest as unknown as {
      export?: { schema?: Record<string, string> }
    }).export?.schema
    expect(exportSchema?.notes).toBe("string")
  })

  it("is version 0.16.0: document search entity", () => {
    const m = manifest as unknown as { name: string; version: string }
    expect(m.name).toBe("invoicing")
    // The UI bundle URL is version keyed and immutable, so any change destined for prod bumps
    // this. 0.13.5 adds two fixes: credit_note_create_and_issue now refuses a credit note that
    // would push an invoice's cumulative credited total past its own grand total (over_credit),
    // and onShopifyRefundCreated routes a split order's (goods + software) refund to the
    // document that actually carries the refunded line instead of always defaulting to the
    // goods invoice, splitting a refund that spans both halves across both documents.
    // 0.13.6 fixes the tax-inclusive double-netting regression: an unchanged read-back save
    // (drafts_update / documents_update line replacement) no longer divides an already-net
    // stored price a second time, the Editor grosses a loaded document's net lines up once so
    // it is the single gross boundary, and a draft's contact-panel total is derived from its
    // lines instead of showing the document-level total that is legitimately 0 pre-issue.
    // 0.14.0 adds the customer's purchase order number as a first class, searchable field: a
    // po_number column mirrored into external_refs.po_number (same pattern as
    // shopify_order_number), printed as a "PO number" line on the quote/invoice/proforma/credit
    // note PDF, amendable on an issued document via documents_update (audited in
    // lifecycle_log as po_number_changed), carried forward on convert-to-invoice, reissue, and
    // credit-note-against-invoice, and matched by documents_search's free text query.
    // 0.15.0 registers a `document` search entity (searchable, scoped to
    // invoicing:documents:read) and a documents.po_number index, so the global command palette
    // can find an invoicing document, including by PO number, without an org wide grant.
    // 0.16.0 documents the shipped commercial flow where agents read it: po_number guidance on
    // the issue tools and documents_update, the order_reissue_apply path for a Shopify order
    // edit, the auto credit note on a refund or cancellation, and the US marketplace facilitator
    // tax rule.
    // 0.16.1 fixes the other half of the tax-inclusive save regression c2a750cc (0.13.6) left:
    // documents_get's read collapsed a line's NULL tax_rate_bp (no per-line override, follow the
    // issuer's classified rate) into 0 (an explicit zero-percent exemption), and the Editor echoed
    // that 0 back on save, so merely opening and saving a document dropped its VAT. NULL now
    // survives the read; the Editor only sends tax_rate_bp_override for a line that actually has
    // one, and uses the line's own stored tax/subtotal to reconstruct an effective display rate
    // (never echoed) so the net/gross boundary stays exact for a never-overridden line too.
    // 0.16.8 renames the order:updated observer so the subscribed wrapper is the only top-level
    // declaration called onShopifyOrderUpdated: the sandbox exposes exports as globals and a
    // same-named script-global function was overwritten, making 0.16.7's wrapper recurse forever.
    // 0.16.7 invoices a PAID order that has no billing document on its next order:updated
    // (the auto-issue flow ran once on order:created; a lost dispatch left the order with no
    // invoice forever). Unpaid orders and orders already parked in deferred_events are left alone.
    // 0.16.6 unbreaks auto-invoicing: the PO-inheritance lookup (0.16.0) ordered documents by
    // `created_at`, a key the bridge rejects (base columns are camelCase: createdAt), so every
    // paid-order event since threw before issuing and no invoice was ever created. The mock db
    // now enforces the bridge's orderBy rule so this class of defect fails in unit tests.
    // 0.16.5 re-fetches a draft order whose currency is not known to be the PRESENTMENT
    // currency, instead of trusting a shop-currency label that mislabels the amounts.
    // 0.16.4 stops documents_update silently discarding every line discount when it
    // replaces lines, and settles a completed draft order's quote on the draft's FINAL
    // lines instead of whatever was last synced.
    // 0.16.3 stops charging the issuer's domestic VAT to a real country that was
    // simply missing from the hand-curated trading-partner list (Armenia, and most
    // of the world with it): KNOWN_COUNTRIES is now the full ISO 3166-1 alpha-2 set,
    // so "not in the EU" means export at 0%, and `ambiguous` means "not a country".
    // 0.16.2 fixes DocumentDetail's footer actions sending the wrong id param key
    // (documents_mark_paid / documents_send_to_customer need document_id, not id;
    // documents_convert_to_invoice needs source_document_id), which the kernel's
    // assertKnownParams rejected before the handler ran, and the empty invoke() catch
    // swallowed the failure silently.
    // 0.17.0 adds a free-text `notes` field to every document type: a plain top-level column
    // (no external_refs mirror, no dedicated lifecycle event), editable on a draft and on an
    // already issued, sent or paid document, matched by documents_search, and printed as a
    // "Notes" block under the totals on the invoice, quote, proforma, purchase order and
    // credit note PDF.
    // 0.17.2 is the merge of origin/main into the agents epic branch: main's bundle up to
    // 0.17.1 plus the epic's own additions, on a version strictly above both sides so no two
    // bundles ever share a version.
    // 0.17.3 takes its UI primitives from @liaison/app-ui/kit: same markup.
    // 0.17.5 takes the refund two-eyes approver from the org's `escalation-contacts` skill
    // instead of naming people in the instructions.
    // 0.17.6 takes the refund two-eyes threshold and the dunning reminder bands from the same org
    // skill instead of carrying one organisation's numbers in the instructions.
    // 0.17.7 splits mutations.ts into one module per domain under src/mutations/: same behaviour.
    // The merge of origin/main also carries main's staging preflight: the nine gated tools declare
    // a `preflight` that runs before the approval request is created, so a missing send-from
    // account, an unresolvable draft, a duplicate invoice for an order, an over refund or an
    // ambiguous issuer profile fails at call time (the agent can fix it) instead of after a human
    // approved it.
    // 0.17.8 converts DataTable, Editor's supporting lists, DocumentDetail, ContactDocumentsPanel
    // and settings onto the shared CardTable (@liaison/app-ui) for the phone card story.
    // 0.17.13 collapses the dashboard toolbar's filter block behind a Filters disclosure at
    // phone width (the date range, the three segmented groups, the group-by switch and Export
    // CSV), so the table is on the first screen instead of below four wrapped rows.
    // 0.17.14 stops the PO number column being squeezed: it takes its content
    // width and never wraps, so an identifier the operator matches against a
    // paper purchase order is never rendered as a shorter, wrong one.
    // 0.17.15 stops the flat documents table overflowing its own pane at a
    // 1440 px window: ten columns at CardTable's 7.5rem floor ask for 1200 px
    // in a pane about 1130 wide, so PO number sat off the right edge behind a
    // scroll with no affordance. Channel steps out below the width where all
    // ten fit (and stays in the CSV), and the phone toolbar's search box gets
    // a placeholder short enough not to be cut mid word.
    // 0.18.0 stores and prints the shipping (ship to) address alongside the billing address:
    // documents carry counterparty_shipping_address / counterparty_shipping_name, the Shopify
    // order and draft order handlers capture the ship to instead of discarding it, and the PDF
    // renders a third SHIP TO party block whenever it differs from BILL TO. The new address is
    // render only: VAT classification still keys off counterparty_country alone.
    // 0.18.1 is the merge of that shipping fix into the agents epic branch, on a version
    // strictly above both sides so no two bundles ever share a version.
    // 0.18.2 makes the missing send-from mailbox refusal actionable: documents_send_to_customer
    // (and its stage time preflight) name the issuer profile setting to fill in, in user facing
    // copy with no dash punctuation.
    // 0.18.3 lists every tool's scopes in requiredScopes: the kernel refuses the retired
    // single scope key, so the catalog must upgrade every installed bundle.
    // 0.18.11 declares contacts.addToOrganisation: the kernel no longer lets an app
    // create organisation contacts without it, and an order's customer is the team's.
    // 0.18.12 reads tax from Shopify instead of replaying it: a zero amount tax line is a zero
    // rate, marketplace collected tax stays off our documents, every Shopify rated line is checked
    // against Shopify's own amount before issuing (parks shopify_tax_mismatch), an exempt
    // treatment carrying seller tax parks (tax_on_exempt_treatment), the OSS placeholder rate never
    // issues (tax_rate_placeholder), the billing country prints while the delivery country
    // classifies, the buyer's VAT id is carried, and shipping refunds follow the shipping line.
    // 0.18.13: an exempt document with no tax prints no Tax % column and no Tax row, and a paid
    // document reads "Total" with "Paid on", never "Amount paid" (a split order's payment spans
    // several documents).
    // 0.18.14 adds the link-shipments job: an invoice records the Boxtal shipment(s) created
    // against it (external_refs.shipments), read through boxtal's public search tool.
    // 0.18.15: Send to customer confirms with a discreet, self dismissing note (or says the
    // send went for approval) instead of succeeding in silence.
    // 0.18.16 adds scripts/replay-order-tax.ts, a read only replay of a stored order event
    // through the current order-paid computation (no writes, no calls).
    // 0.18.17: link-shipments merges onto the row as it is at write time (locked, re-read) instead
    // of overwriting lifecycle_log from its scan snapshot; the replay script reads Admin GraphQL orders.
    // 0.18.18: tax review parks (shopify_tax_mismatch, tax_on_exempt_treatment,
    // tax_rate_placeholder) stop retrying, raise one attention row, and are resolved by the gated
    // deferred_tax_override (Shopify's tax or as computed) from the new Deferred tab.
    // 0.18.19: deferred_tax_override declares a stage-time preflight (missing, resolved or non
    // tax review parks are refused before the approval exists).
    // 0.18.20: schema for counterparty identities, legal originals, e-invoicing settings, FX rate
    // cache and the regime / structured-address snapshot columns; two more allowed hosts.
    // 0.18.21: pure e-invoicing core (territory, identity validators, regime classifier, operation type); no schema change.
    // 0.18.22: pure e-invoicing issue gate (mandatory-data pass, gate mode, snapshot builders); not called yet.
    // 0.18.23: gate review fixes (issued-status gate-mode lookup, territory / billing fix tools, SIRET prefix check).
    // 0.18.24: credit-note original link column, original-regime inheritance, internal cancellation, original invoice date in the template data.
    // 0.18.25: e-invoicing gate active at every manual issue site (preflights included), customer kind, operation category and structured billing on issuing calls and drafts.
    // 0.18.26: a SIREN confirmation is never taken from a call snapshot; every counterparty-taking handler strips it.
    // 0.18.27: the order-paid path runs the e-invoicing gate: kind derived at creation, structured billing, identity parks with one attention item per contact.
    // 0.18.28: the order-paid e-invoicing gate and completeness run before the approval threshold.
    // 0.18.29: refund / cancellation credit notes run the e-invoicing gate; a refusal parks the
    // credit note alone on the buyer's identity (never dead-lettered, re-issued on identity change).
    // 0.18.30: a credit note against an e-invoice lacking the SIREN takes it from the confirmed identity; parks close their attention; any auto credit note refusal parks.
    // 0.18.31: counterparty identity tools (get, registry lookup, registry-confirmed set, territory), einvoicing_classify, einvoicing_settings_set.
    // 0.18.32: bun test loads the Solid .tsx modules again (test-only JSX runtime preload).
    // 0.18.33: e-invoicing UI: customer type and operation type in the Editor, the regime line, the customer identity and readiness tabs.
    // 0.18.34: the dashboards module-surface test asserts the named Component exports the mounts import.
    // 0.18.35: e-invoicing readiness tool, identity backfill tool (dry run by default), identity-confirm job.
    // 0.18.36: a registry name confirms a SIREN only against the contact's company, its issued invoices and parked orders (never a draft's name, never a person's name for a company).
    // 0.18.37: an imported legacy document is never re-rendered over (its imported PDF is its legal original); einvoicing_backfill_legacy_originals records and restores those originals; a re-rendered credit note keeps the original's number and date.
    // 0.18.38: French legal mentions are dated, accented and worded by operation category (goods 262 ter I, services 283-2, both); the PDF prints the seller SIREN, legal form, capital and RCS, the buyer SIREN, the operation label, the VAT-on-debits option and a credit note's original date.
    // 0.18.39: ECB reference-rate cache and the fx-rates job; a foreign-currency document snapshots the cached rate and its EUR VAT total (never blocks an issue).
    // 0.18.40: EUR VAT total scaled by the currency's exponent; legacy backfill sets failed reads aside (retry_failed); fx cache read newest-first; mixed mention single period; long identity/footer wrap.
    // 0.18.41: e-invoicing agent guide (regimes in plain words, classify first, the registry then web fix loop, retry the same issue call); a registry-confirmed SIREN records the registry answer as its provenance link; a contact with a company is never taken out of e-invoicing by a caller's kind (identity change asks a person); refusals and lookups name the next step; a lookup for a known contact retries under its recorded name; einvoicing_classify takes a numeric order id.
    // 0.18.42: Factur-X CII builder (EN 16931 + French rules) with per-rate VAT breakdown.
    // 0.18.43: legal originals are kernel-immutable (write-once rows, 10-year retention on the rows and their files).
    // 0.18.44: legal original fixed at issue (PDF/A-3B; the Factur-X with its CII XML for an e_invoice document) in immutable rows with their own file parents; facturx_files; facturx_failed status and attention.
    // 0.18.45: every delivery (customer email, order-paid auto email, deferred email retry) attaches the legal original.
    // 0.18.46: documents_update locks every CII-visible field once a legal original exists (legal_original_locked); agent guide line.
    // 0.18.47: legal_originals_verify (read only): recomputes stored legal originals' fingerprints.
    // 0.18.48: e-invoicing transmission (send request, gated send, booking batch, statuses, jobs).
    // 0.18.49: e-invoicing settings carry the PA provider binding, cut-over and send / booking switches.
    // 0.18.50: the transmission lease compares on the row's unique key.
    // 0.18.51: e-invoicing panel and settings section (send preview, settings read tool).
    // 0.18.52: agent guide for sending through the e-invoicing platform.
    // 0.18.53: the send request and the status refresh declare what they write and who reads it.
    // 0.18.54: credit notes carry positive Factur-X amounts; previews serve the legal original; issued addresses lock.
    // 0.18.55: outbound PA calls carry the kernel dispatch grant minted in the approval; the platform binding is written through the kernel.
    // 0.18.56: sending switched off or a document before the cut-over is refused at the request, the approved execution and the job.
    // 0.18.57: a send that ended in a terminal failure may be asked again: a new attempt row under a fresh approval, looked up at the platform first.
    // 0.18.58: a declined or expired booking batch releases its documents; documents of every pending batch stay off new cards.
    // 0.18.59: each transmission row is read and advanced only through the PA it went through.
    // 0.18.60: the status drain acknowledges only the refs it handled.
    // 0.18.61: an unconfirmed transmission request stays requested and is re-read.
    // 0.18.62: the e-invoicing cut-over compares the issue instant's civil date in France.
    // 0.18.63: the standalone Factur-X XML copy is write-once and retained.
    // 0.18.64: received supplier e-invoices (merged reception track): mirrored with their files, the Received
    //   tab (list, one invoice, refuse/dispute through one approval request; errors apart from empty, paging,
    //   every status, reasons and times in the reader's language); a failed read is queued and read again;
    //   a closed refuse/dispute approval no longer blocks; the reads say whether the caller may act; agent
    //   text: received invoices are mirrored here, never re-uploaded to pennylane.
    // 0.18.64 also carries the main line's security pass (its 0.18.20-0.18.22): issuer-profile settings
    // and documents_update gated, credit notes and purchase orders gate by default (an org auto-approve
    // policy approves them like any gated tool), CSV cells formula-safe, issuer bank and control fields
    // need invoicing:issuer:admin.
    // 0.18.65: the customer identity tab names the customer and its registry search row keeps the
    // name field usable; readiness groups each customer's blockers on one card.
    // 0.18.66: the legacy-originals backfill finishes a document a cut-off batch left half done.
    // 0.18.67: the issuing tools declare a budget that fits an issue (render, store, post to the
    //   contact thread with the PDF) instead of the 5 s production default.
    // 0.18.68: a person's own call that holds the deciding scope is never parked: the kernel
    // grants ctx.requestApproval inline and every gating handler carries on.
    // 0.18.69: the Received tab's confirm says so: the request is sent at once
    // and needs the approve permission (without it, it is refused, not parked).
    // 0.18.70: a proforma/quote/PO create-and-issue replay with different lines fails
    //   already_exists_different_content instead of returning the untouched document, and an
    //   issued proforma, quote or purchase order accepts a documents_update line replacement.
    // 0.18.71: a person's own request runs on the tool's own permission (the approve permission
    // plays no part), so the confirm no longer names it.
    // 0.18.72: every gated tool's approval card says what approving does (document number and
    //   type, customer, money with its currency, order name, an edit as before -> after), never
    //   the kernel's raw field dump: each gated tool declares a summarizer.
    // 0.18.73: pending_approvals_list returns the requester's id (it printed "[object Object]")
    //   and the approval's summary title.
    // 0.18.73 (also): a document id that resolves to nothing (another org's, a deleted draft) renders a
    //   not-found state instead of crashing the tab.
    // 0.18.74: record_refund accepts its amount as the JSON number an approval payload carries (it
    //   threw "cannot convert bigint to number"), and issuing steps past document numbers the
    //   sequence never counted instead of colliding on the number's unique index.
    // 0.18.75: the issuer-profile table keeps its Edit/Delete column in view in the ~576 px
    //   settings pane, and the toolbar's from/to date fields sit side by side as one pair.
    // 0.18.76: a line price or discount that is not a plain number ("$1") is refused with a typed
    //   invalid_amount error before gating, instead of silently becoming 0; document PDFs open in
    //   the system PDF viewer on desktop (no blob tab there).
    // 0.18.77: the pair-download test's fake save returns nothing, as its type says, so the
    //   bundle's typecheck (and its build) passes again.
    // 0.18.78: link-shipments locks the invoice row with a by-id update (the bridge refuses
    //   updateMany with where.id, so the job threw on every run and linked nothing).
    // 0.18.79: invoicing settings live only in the Settings app (views.settings); the
    //   /settings/invoicing app tab type and the sidebar's Settings row are gone, so the path
    //   renders inside the Settings layout instead of an app tab.
    // 0.18.80: settings move to the declarative page (manifest `settings`): issuer profiles
    //   (custom block), read-only shop mappings, tax regimes and HS codes, e-invoicing fields.
    // 0.18.81: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.18.82: the settings page's first e-invoicing save keeps the default gate mode.
    // 0.18.84: a null e-invoicing platform unbinds it (kernel binding first).
    // 0.19.0: the invoicing.document import kind and documents.external_ref.
    // 0.19.1: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.19.2: the kind's preview check (checkDocuments) runs the import's own checks, so a
    // preview refuses what the run would (issuer_ambiguous on an org with no issuer profile).
    // 0.19.3: two records of one import with the same number are refused, in the preview and
    // the run alike (the second record: numberTaken).
    // 0.19.4: a number is held for the whole run (the host passes earlier batches' claims), and
    // only by a record that passed its other checks.
    // 0.19.5: documents_send_to_customer declares its outbound text (outboundTextParams).
    // 0.19.6: the documents list refreshes on document events, and each row names the
    // Shopify order it bills (data-shopify-order-id, the order's gid).
    // 0.19.7: the icon as data (`iconName`), drawn when the UI runs framed; the UI reads the page's path with `currentPath()`.
    // 0.19.8: documents_for_orders resolves an order number with or without its "#".
    // 0.19.9: an import into an org with no issuer profile is refused as issuer_missing, which
    // says to ask the person for the company's legal identity, never to make it up.
    // 0.19.10: the issuer profile card always shows the legal identity (country, address,
    // tax id beside name, VAT and bank details), never folded into "other settings".
    // 0.20.0: the create-and-issue tools (quote, proforma, po) return pdf_file_id, pdf_status,
    // grand_total_minor and currency (all referenceable), take customer_reference (printed as
    // "Customer ref") and declare the line discount_minor; their refusals say what to do next.
    // 0.20.1: the e-invoice deposit is claimed in the kernel's effect ledger (ctx.effects).
    // 0.20.2: the deferred-retry auto-email is claimed there too, so a sweep re-run sends it once.
    // 0.20.3: a deposit in doubt (timeout) is looked up before any re-deposit; an unknown auto-email
    // is never resent by the sweep, and a person's documents_send_to_customer closes its park.
    // 0.20.4: quote_create_and_issue has its own approval card (customer, lines, total, validity,
    // customer reference), so a quote staged as a step of a sequence reads like an issued one.
    // 0.20.5: French copy names the settings page Paramètres, as the shell does.
    // 0.20.7: neutral example in an approval-card doc comment.
    // 0.20.9: einvoice_transmissions is marked legalRetention (kept in the legal archive of a deleted org).
    // 0.20.10: documents (issued invoices and credit notes) and their lines are marked legalRetention.
    // 0.20.15: the hourly fx-rates job runs only for a workspace with a non-EUR document.
    // 0.20.16: no fx-rates job: the ECB rate is fetched at issue, and a foreign-currency
    // e-invoice the ECB cannot price is refused before numbering (fx_rate_unavailable, retryable).
    // 0.20.17: the daily overdue-scan runs only for a workspace with an issued invoice that has a due date.
    // 0.20.18: the editor links a contact by name (search and pick), no raw contact-id field.
    // 0.20.19: footer counts read "1 invoice"; readiness shows a customer by name, never a raw id.
    // 0.20.20: an intra-EU business buyer without a VAT number is refused with the evidence (or its
    // VAT number filled in from an earlier document), VIES checks supplied numbers, OSS charges the
    // destination's rate, and the issue card states treatment, price basis, net, VAT and total.
    // 0.20.21: buyer_is_consumer is checked against the evidence (refused with a VAT number on
    // record, else a person's card on every tool, drafts included), only strong matches fill in a
    // VAT number, bounded newest-first lookups on new indexes, a 3 s VIES deadline, tool timeouts,
    // and a documents_update preflight.
    // 0.20.22: that consumer declaration is decided by a person whatever the org's auto-approve
    // policy (preflight noAutoApprove; quote_issue gets a preflight), and the documents_update card
    // lists the evidence (documents_update_preview).
    // 0.20.23: a long word no longer jumps ahead of the line before it.
    // 0.20.24: any earlier-document match is business evidence (addresses compared by house number,
    // street and postcode, whatever the layout), Shopify is searched by order number, name and
    // address too (capped, short deadlines), a failed Shopify read reads "business status NOT
    // verified" for a person, and the refusal names the likely legal entity.
    // 0.20.25: documents_search matches the address, email and line descriptions (ranked), a
    // contact's email and address, and hints customer_history on no hit; customer_history; the
    // document search index carries the address, email, order reference and line descriptions.
    // 0.20.26: customer_history's last_sale is the price paid per unit (subtotal over quantity,
    // after the line discount), not the list price printed on the line.
    // 0.20.27: vat_lookup finds a business buyer's VAT number (web search, national formats,
    // VIES, ranked), and the buyer_vat_id_required refusal names the exact vat_lookup call.
    // 0.20.28: the buyer-VAT and tax-review guards return a typed refusal (refuseTool), so the
    // host answers them as a 4xx at warn instead of a 500 that pages.
    // 0.20.29: vat_lookup rates strong only when VIES's name carries the whole given name (never a
    // fragment of a person's name), its message and the guide require a solid link between the
    // company and the customer before a found VAT number is used, and the buyer_vat_id_required
    // refusal names the company of the matched Shopify order's earlier invoice (no placeholder).
    // 0.20.37: a credit note's stated date decides its number year, and is never after today; paid
    // dates and the editor's default date read the issuer's date; a draft order's quote refused for
    // its zone waits with its arguments.
    // 0.20.39: quote, proforma and po_create_and_issue take a stated issue date, which the editor
    // now sends; a quote on a shop-linked issuer refuses another day than its draft order's.
    // 0.20.38: documents_update keeps an issued document's date in its number's year, and an issued
    // invoice or credit note's date between its neighbouring numbers and on or before today.
    // 0.20.33: issue dates and number years in the issuer's time zone, through ctx.time.civil.
    // 0.20.31: the drafts tools that park an approval declare its summary.
    // 0.20.30: the document and editor actions sit at the top of the panel, clear of the chat dock.
    // 0.20.33: drafts_create and drafts_update (conditionalGate) run a stage-time preflight (the
    // same draft run, stopped before the write), so a draft's lines and notes are validated before
    // any approval is parked. The app's own install resolves the control-plane contract through an
    // override (the shared package depends on it by workspace protocol).
    // 0.20.40: above 0.20.39, so an instance on either line of work upgrades; no change of its own.
    // 0.20.40: credit note and purchase order cards state the amount, lines and date when the host
    //   parks the call (an org policy, what the turn read), not only when the handler does.
    // 0.20.41: search words for credit note, refund and quote tools.
    // 0.20.42: record pages name the entity their id belongs to.
    // 0.20.43: the PDF tab shows the document in a frame, which the CSP allows, not an <object>.
    // 0.20.44: a credit note is never dated before the invoice it corrects, stated or moved.
    // 0.20.45: Preview and Download say why when a PDF cannot open, a pending PDF offers Retry render,
    // and the editor says beside the field when a chosen issue date would be refused.
    // 0.20.46: those notes reach a French reader in French.
    // 0.20.47: a minor-unit amount is a whole number, a credit note's total is negative, and the card
    //   states the total that issues.
    // 0.20.49: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.20.50: a search for a number no document carries says so and names the numbers ending in the same digits.
    // 0.20.51: the shared settings types it builds against changed; no change of its own.
    // 0.20.52: its attention heading is declared here, not in the web shell.
    // 0.20.56: document search declares one search keyword fewer.
    // 0.20.57: hidden tools name the visible one to use instead.
    expect(m.version).toBe("0.20.57")
    const overdue = (manifest as unknown as { jobs: Record<string, { runsFor?: unknown }> }).jobs["overdue-scan"]
    expect(overdue?.runsFor).toEqual({
      rows: { entity: "documents", where: { status: "issued", type: "invoice", due_at: { not: null } } },
    })
    const hosts = (manifest as unknown as { network: { allowedDomains: string[] } }).network.allowedDomains
    expect(hosts).toEqual(
      expect.arrayContaining(["ec.europa.eu", "recherche-entreprises.api.gouv.fr", "data-api.ecb.europa.eu"]),
    )
  })
})

describe("fx rates are fetched at issue, never on a schedule", () => {
  // The rate is needed once, at issue. A scheduled job would set every workspace up in the
  // worker each tick for documents that may never be issued in a foreign currency.
  it("no job fetches rates", () => {
    const jobs = (manifest as unknown as { jobs?: Record<string, { handler?: string; schedule?: string }> }).jobs ?? {}
    const fx = Object.entries(jobs).filter(([name, j]) => /fx|rate/i.test(name) || /fx/i.test(j.handler ?? ""))
    expect(fx).toEqual([])
  })
})

describe("e-invoicing agent guide", () => {
  const sections = (manifest as unknown as { agentInstructions: { sections: Array<{ tools: string[]; text: string }> } })
    .agentInstructions.sections
  const section = sections.find((s) => s.tools.includes("einvoicing_classify"))

  // red: no section -> the agent meets a gate refusal with no fix loop, and guesses the regime.
  it("has one section keyed by the e-invoicing and issuing tools", () => {
    expect(section).toBeDefined()
    expect(section!.tools).toEqual(
      expect.arrayContaining([
        "einvoicing_classify",
        "counterparty_identity_get",
        "counterparty_identity_lookup",
        "counterparty_identity_set",
        "counterparty_territory_set",
        "einvoicing_readiness",
        "einvoicing_backfill_identities",
        "invoice_issue",
        "invoice_create_and_issue",
        "credit_note_create_and_issue",
        "legal_originals_verify",
      ]),
    )
    for (const t of section!.tools) expect(Object.keys(manifest.tools)).toContain(t)
  })

  it("states the regimes in plain words and the classify-first rule", () => {
    const t = section!.text
    for (const r of ["e_invoice", "e_reporting", "out_of_scope", "needs_review"]) expect(t).toContain(r)
    expect(t).toContain("einvoicing_classify")
  })

  it("states the fix loop: registry, then the web as a pointer, then set, then retry the same issue call", () => {
    const t = section!.text
    for (const w of ["counterparty_identity_lookup", "web_search", "web_fetch", "counterparty_identity_set", "agent_web", "source_url", "fix_tool"]) {
      expect(t).toContain(w)
    }
    expect(t).toMatch(/same arguments/i)
    expect(t).toMatch(/never invent a SIREN/i)
    // red: without it a refused SIREN fix was dodged by re-issuing the buyer as a non-registered entity.
    expect(t).toMatch(/never change it .* to get an invoice past a refusal/i)
    expect(t).toMatch(/pending_approval/)
    expect(t).toMatch(/einvoicing_warning/)
    expect(t).toContain("customer_kind")
    expect(t).toContain("operation_category")
  })
})

describe("e-invoicing identity attention", () => {
  // red: drop the emit or its translation -> an identity park raises no attention item.
  it("declares the identity_missing event and its attention translation for contact writers", () => {
    const m = manifest as unknown as {
      events: { emits: string[] }
      attention: { translations: Array<Record<string, unknown>> }
    }
    expect(m.events.emits).toContain("einvoicing:identity_missing")
    const t = m.attention.translations.find((x) => x.event === "einvoicing:identity_missing")
    expect(t).toMatchObject({
      kind: "invoicing:einvoicing.identity_missing",
      urgency: 50,
      recipients: { kind: "scope_holders", scope: "invoicing:contacts:write" },
      resolveWhen: { field: "resolved", equals: true },
    })
  })

  // red: drop the emit or its translation -> a refused automatic credit note parks unseen.
  it("declares the refused-credit-note event and its attention translation", () => {
    const m = manifest as unknown as {
      events: { emits: string[] }
      attention: { translations: Array<Record<string, unknown>> }
      schema: Record<string, { fields: Record<string, unknown>; indexes?: string[][] }>
    }
    expect(m.events.emits).toContain("deferred:credit_note_refused")
    const t = m.attention.translations.find((x) => x.event === "deferred:credit_note_refused")
    expect(t).toMatchObject({
      kind: "invoicing:credit_note.refused",
      recipients: { kind: "scope_holders", scope: "invoicing:documents:write" },
      resolveWhen: { field: "resolved", equals: true },
    })
    // Identity lookups on parks filter by the contact column.
    expect(m.schema.deferred_events!.fields.contact_id).toBe("uuid?")
    expect(m.schema.deferred_events!.indexes).toContainEqual(["contact_id", "status"])
  })
})

describe("e-invoicing identity, classify and settings tools", () => {
  type Tool = Record<string, unknown> & { requiredScopes: string[]; handler: string }
  const tools = (manifest as unknown as { tools: Record<string, Tool> }).tools
  const h = handlers as unknown as Record<string, unknown>

  // red: drop a tool or its handler export -> the agent has no way to fix a missing identity.
  it("declares every tool with its handler exported", () => {
    for (const name of [
      "einvoicing_classify",
      "counterparty_identity_get",
      "counterparty_identity_lookup",
      "counterparty_identity_set",
      "counterparty_territory_set",
      "einvoicing_settings_set",
    ]) {
      const t = tools[name]
      expect(t).toBeDefined()
      expect(typeof h[t!.handler]).toBe("function")
    }
  })

  it("reads are read only with the read scopes", () => {
    expect(tools.einvoicing_classify).toMatchObject({ readOnly: true, requiredScopes: ["invoicing:documents:read"] })
    expect(tools.counterparty_identity_get).toMatchObject({ readOnly: true, requiredScopes: ["invoicing:contacts:read"] })
    expect(tools.counterparty_identity_lookup).toMatchObject({ readOnly: true, requiredScopes: ["invoicing:contacts:read"] })
  })

  // red: make identity_set ungated or plainly gated -> an unconfirmed SIREN writes without a human,
  // or every confirmed one waits on a human.
  it("identity_set is conditionally gated; territory and settings are always gated", () => {
    expect(tools.counterparty_identity_set).toMatchObject({
      conditionalGate: true,
      approvalImpact: "internal",
      requiredScopes: ["invoicing:contacts:write"],
    })
    expect(tools.counterparty_identity_set!.gated).toBeUndefined()
    expect((tools.counterparty_identity_set!.approvalCard as { summary: string }).summary).toBeTruthy()
    expect(tools.counterparty_territory_set).toMatchObject({
      gated: true,
      approvalImpact: "internal",
      trustBoundary: "user",
      requiredScopes: ["invoicing:contacts:write"],
    })
    expect(tools.einvoicing_settings_set).toMatchObject({
      gated: true,
      approvalImpact: "internal",
      requiredScopes: ["invoicing:settings:write"],
    })
    // red: accept confirmed_via (or the approval fields) as a param -> a caller asserts its own
    // registry confirmation. Undeclared params are refused by the kernel (assertKnownParams).
    const setParams = tools.counterparty_identity_set!.params as {
      properties: Record<string, unknown>
      additionalProperties?: unknown
    }
    for (const forbidden of ["confirmed_via", "approval_request_id", "verified_by", "registry_status", "registry_name"]) {
      expect(Object.keys(setParams.properties)).not.toContain(forbidden)
    }
    expect(setParams.additionalProperties).not.toBe(true)
    const source = (tools.counterparty_identity_set!.params as { properties: Record<string, { enum?: string[] }> })
      .properties.source
    expect(source!.enum).toEqual(["registry", "vat_derived", "agent_web", "manual"])
  })
})

describe("received supplier e-invoices in the agent text", () => {
  const raw = JSON.stringify((manifest as unknown as { agentInstructions: unknown }).agentInstructions)

  // red: the guide said "there is no received-invoice concept" and sent every supplier bill to pennylane.
  it("no instruction denies the Received mirror; routing names it and forbids a re-upload", () => {
    expect(raw).not.toContain("no received-invoice concept")
    expect(raw).not.toContain("pennylane owns received supplier bills")
    expect(raw).toContain("received_einvoices_list")
    expect(raw).toMatch(/never re-upload it to pennylane/)
  })
})

describe("issuing tool budgets", () => {
  it("every tool that issues a document declares a budget above the 5 s production sandbox default", () => {
    // An issue renders the PDF, stores it, and posts it to the contact thread
    // with the file attached: about 4 to 6 s on production, so the tight
    // default killed approved issues mid flight ("App execution timed out").
    const tools = manifest.tools as unknown as Record<string, { timeoutMs?: number }>
    for (const name of [
      "invoice_issue",
      "invoice_create_and_issue",
      "quote_issue",
      "quote_create_and_issue",
      "proforma_issue",
      "proforma_create_and_issue",
      "po_issue",
      "po_create_and_issue",
      "credit_note_issue",
      "credit_note_create_and_issue",
      "order_reissue_apply",
    ]) {
      expect({ name, timeoutMs: tools[name]?.timeoutMs ?? 0 }).toEqual({ name, timeoutMs: 60_000 })
    }
  })
})
