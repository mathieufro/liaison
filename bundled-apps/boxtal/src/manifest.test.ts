// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as summarizers from "./summarizers"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
const load = () => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))

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
 *  param hides its shape from the weak agent, which guesses wrong field names (the from/to/parcels
 *  422 class). `agentVisible:false` tools are system/internal and exempt. */
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

describe("Boxtal app.manifest.json", () => {
  it("validates against packageManifestSchema (freeze-time zod)", () => {
    const r = packageManifestSchema.safeParse(load())
    if (!r.success) console.error(JSON.stringify(r.error.issues, null, 2))
    expect(r.success).toBe(true)
  })

  // Regression — the opaque-input 422 class (from/to/parcels/override/customs patch). Every
  // agent-visible object/array param must advertise its shape so the weak model fills it right.
  // Walk 5 (D41): an open carton or customs patch let a weak model stage keys like "width1",
  // "height /" and "unitWeight_kg", which the handler dropped. Both shapes are closed.
  it("the draft's carton and customs patch take only their declared fields", () => {
    const tools = (load() as { tools: Record<string, { params: { properties: Record<string, any> } }> })
      .tools
    const override = tools.shipment_draft_set_package!.params.properties.override
    expect(override.additionalProperties).toBe(false)
    expect(override.items.additionalProperties).toBe(false)
    const patch = tools.shipment_draft_set_customs!.params.properties.patch
    expect(patch.additionalProperties).toBe(false)
    expect(Object.keys(patch.properties).sort()).toEqual(
      ["description", "originCountry", "tariffNumber", "unitValue", "unitWeight"].sort(),
    )
  })

  it("declares NO opaque object/array params on agent-visible tools", () => {
    expect(findOpaqueParams(load())).toEqual([])
  })
  // Regression (BL-254) — the customs-decision affordance. A weak model on the EU-vs-export batch
  // skipped hs_codes_lookup and applied ONE HS code (8543.70) to BOTH the instrument and accessory
  // lines (run 54090f5d). The agentInstructions must teach: (1) UK(GB)/CH are EXPORT despite being
  // European, (2) intra-EU ships customs-free, (3) HS codes are PER ITEM CLASS — instrument ≠ accessory
  // — so look each up per-line and never reuse one code across lines, then read the articles back.
  it("agentInstructions teaches the per-line customs HS-code decision (export vs intra-EU, instrument vs accessory)", () => {
    const ai = guideText(load())
    // EU-but-export traps named explicitly.
    expect(/post-brexit|United Kingdom \(GB\)/i.test(ai)).toBe(true)
    expect(/Switzerland \(CH\)/i.test(ai)).toBe(true)
    // Intra-EU is customs-free (no HS codes / no commercial invoice).
    expect(/intra-eu/i.test(ai) && /customs-free/i.test(ai)).toBe(true)
    // The core rule: per-item-class codes, never one code across lines, look it up first.
    expect(/per item class|PER ITEM CLASS/i.test(ai)).toBe(true)
    expect(/never copy one line's code|never reuse a code|different code on each line|DIFFERENT code/i.test(ai)).toBe(
      true,
    )
    expect(/hs_codes_lookup/i.test(ai)).toBe(true)
  })

  // Regression (BL-254) — the batch-discovery affordance. A weak model answered "today's batch" by
  // searching Shopify unfulfilled orders (a DIFFERENT set), found only the US orders, and told the user
  // the FR/DE/NL/UK/CH/JP orders "don't exist" (run bf814a0e). The agentInstructions must route a
  // prepare/classify/ship-today ask to the To-prepare queue (issued invoices awaiting shipment), not a
  // raw store order search, and forbid concluding missing rows don't exist.
  it("agentInstructions routes a prepare/ship-today batch ask to the To-prepare queue, not a store order search", () => {
    const ai = guideText(load())
    expect(/today's batch/i.test(ai)).toBe(true)
    expect(/To-prepare queue/i.test(ai)).toBe(true)
    expect(/don't exist|do NOT conclude/i.test(ai)).toBe(true)
  })

  // Regression (monday-cross-app-business-pulse) — the shipping lane of a morning business pulse. The weak
  // agent read only queue_counts ({to_prepare, ready, returns, exceptions}) and declared shipping
  // "healthy / no exceptions" off to_prepare/ready alone, omitting a real EXCEPTION parcel. The
  // agentInstructions must teach: queue_counts is a badge (it now carries an `exceptions` count); never
  // declare shipping healthy off it alone — when exceptions is non-zero call exceptions_list + track to
  // surface the stuck parcel(s).
  it("agentInstructions teaches the BUSINESS-PULSE shipping lane: never declare shipping healthy off queue_counts alone (check exceptions, then exceptions_list/track)", () => {
    const ai = guideText(load())
    expect(/BUSINESS PULSE \/ 'WHAT'S STUCK IN SHIPPING'/.test(ai)).toBe(true)
    expect(/NEVER declare shipping 'healthy'/.test(ai)).toBe(true)
    expect(/FALSE ALL-CLEAR/.test(ai)).toBe(true)
    expect(/call exceptions_list to get the stuck rows and track each one/.test(ai)).toBe(true)
  })

  // Regression (monday-cross-app-business-pulse) — queue_counts must carry the `exceptions` badge so a
  // queue read cannot be mistaken for a clean exceptions check.
  it("queue_counts description surfaces the `exceptions` count + the never-all-clear-off-the-badge rule", () => {
    const m = load() as { tools: Record<string, { description?: string }> }
    const desc = m.tools.queue_counts?.description ?? ""
    expect(desc).toContain("exceptions")
    expect(/never declare shipping healthy off this badge alone/i.test(desc)).toBe(true)
  })

  // BL-258 anti-fabrication relabel guard (backorder-allocation-fairness-during-stockout-partial).
  // The to_prepare_list worklist's per-row prep_status:"ready_to_prepare" must NOT read as "a shipment
  // is staged/ready to ship". A weak model that sees a row "ready" narrates a staged shipment with no
  // matching gated create_shipment call (fabrication). The tool description must (a) name the field as
  // `prep_status` (not a bare `ready`), and (b) explicitly distinguish "ready_to_prepare" (the invoice
  // is draftable — NOTHING staged) from a staged shipment, which only create_shipment (GATED) produces.
  it("to_prepare_list description disambiguates prep_status=ready_to_prepare from a staged shipment (relabel anti-fabrication)", () => {
    const m = load() as { tools: Record<string, { description?: string }> }
    const desc = m.tools.to_prepare_list?.description ?? ""
    expect(desc).toContain("prep_status")
    expect(desc).toContain("ready_to_prepare")
    // No bare `ready or needs-fix` framing that reads as staged.
    expect(/classified ready or needs-fix/i.test(desc)).toBe(false)
    // States the NOT-staged distinction and that only create_shipment stages.
    expect(/NOT\b.*(staged|ready to ship|sent)/i.test(desc)).toBe(true)
    expect(/create_shipment/i.test(desc)).toBe(true)
  })

  // Regression (marco-proforma-to-invoice-to-export-shipment-chain) — the EXPORT-treatment
  // COMMUNICATION affordance on the gated create_shipment terminal step. The mechanical export chain
  // greens (instrument HS 9207.90, dealer-priced declared value, both convert + create_shipment left
  // gated/pending), but a weak model's PENDING-APPROVAL summary omitted the rubric-required export
  // framing (zero-rated tax basis + commercial invoice + incoterm) and used dispatch-y wording
  // ("initiated" / "finalize the dispatch") — failing 2 of 3 gate runs. The create_shipment description
  // must teach: for an EXPORT route, the staged report MUST surface the zero-rated treatment, the
  // commercial-invoice/customs doc, AND the incoterm, and must NEVER use dispatched/initiated/sent
  // wording (nothing ships until the human approves). This is the honest business framing any export
  // staging should carry — it does not name a tool/step sequence.
  it("create_shipment description teaches the EXPORT-treatment pending-approval framing (zero-rated + commercial invoice + incoterm; no dispatch wording)", () => {
    const m = load() as { tools: Record<string, { description?: string }> }
    const desc = m.tools.create_shipment?.description ?? ""
    // Names the export-route trigger and the three export-treatment elements the staged report must carry.
    expect(/EXPORT SHIPMENTS/i.test(desc)).toBe(true)
    expect(/zero-rated/i.test(desc)).toBe(true)
    expect(/commercial invoice/i.test(desc)).toBe(true)
    expect(/incoterm/i.test(desc)).toBe(true)
    expect(/DAP/.test(desc)).toBe(true)
    // Forbids the dispatch-y wording the judge flagged; reinforces staged/pending framing.
    expect(/never use 'dispatched', 'initiated', 'sent', or 'finalize the dispatch'/i.test(desc)).toBe(
      true,
    )
  })

  // Regression (boxtal-carrier-sla-performance-report) — the carrier-performance DATA-HONESTY affordance.
  // A weak model, asked "which carrier had the best on-time rate / fewest exceptions last quarter",
  // fabricates a precise per-carrier on-time PERCENTAGE ("Colissimo 94% on-time") presented as a
  // full-quarter, server-computed rate — even though Boxtal has NO analytics/aggregate tool and search
  // has NO date-range filter. The agentInstructions must teach: enumerate a BOUNDED sample (blank search
  // + exceptions_list), tally per-carrier in-context, LABEL it a bounded recent snapshot (NOT an
  // authoritative on-time rate, NOT scoped to an exact quarter — no date filter, no aggregate tool), and
  // point to Boxtal's own dashboard for the authoritative report — never fabricate a quarter percentage.
  it("agentInstructions teaches the carrier-SLA bounded-snapshot honesty (no aggregate tool / no date filter / point to dashboard / no fabricated %)", () => {
    const ai = guideText(load())
    // Names the on-time-rate / carrier-performance ask it governs.
    expect(/on-time rate|carrier performance|CARRIER PERFORMANCE/i.test(ai)).toBe(true)
    // The two genuine limits must be stated.
    expect(/no analytics\/aggregate tool|NO analytics|no aggregate tool/i.test(ai)).toBe(true)
    expect(/no date-range|no date filter|no created-between/i.test(ai)).toBe(true)
    // The honest framing: a bounded recent snapshot, not an authoritative rate.
    expect(/bounded recent snapshot|bounded snapshot/i.test(ai)).toBe(true)
    // Point to the native dashboard for the authoritative report.
    expect(/Boxtal('s)? (own )?dashboard/i.test(ai)).toBe(true)
    // Explicitly forbid fabricating a per-carrier on-time percentage as full-quarter data.
    expect(/never fabricate|NEVER fabricate/i.test(ai)).toBe(true)
    expect(/percentage|on-time PERCENTAGE|%/i.test(ai)).toBe(true)
    // The exact-sources rule: exceptions_list is the AUTHORITATIVE exception set; tally only retrieved rows.
    expect(/exceptions_list/i.test(ai)).toBe(true)
    expect(/authoritative.*EXCEPTION|EXCEPTION\/RETURNED\/LOST/i.test(ai)).toBe(true)
    // Page through the bounded sample; tally only carriers/rows actually retrieved (no invented carrier).
    expect(/tally ONLY|ACTUALLY retrieved/i.test(ai)).toBe(true)
    expect(/page (further|through)|do not stop after one page|never fetched/i.test(ai)).toBe(true)
  })

  // Regression (BL-254) — the draft read-back tool. The agent could only poll get_shipment (live
  // order/tracking, NO customsArticles) so it bluffed "all lines set" from memory. shipment_draft_get
  // exposes the draft's customsArticles for verification from a real tool result.
  it("declares shipment_draft_get returning the draft's customs articles for verification", () => {
    const m = load() as {
      tools: Record<string, { description?: string; handler?: string; requiredScopes?: string[] }>
    }
    const t = m.tools.shipment_draft_get
    expect(t).toBeDefined()
    if (!t) throw new Error("shipment_draft_get tool missing")
    expect(t.handler).toBe("shipmentDraftGetHandler")
    expect(t.requiredScopes).toEqual(["boxtal:shipments:read"])
    expect(/customsArticles/i.test(t.description ?? "")).toBe(true)
  })

  // Regression (BL-161) — the exception-sweep classification affordance. On the daily customs/exception
  // watcher routine a weak model authored search(query='IN_TRANSIT') and expected FAILED_ATTEMPT/pickup-
  // expiring parcels in that result (run 4e99b1d1), and another mapped "failed delivery" INTO EXCEPTION,
  // filtering only EXCEPTION + pickup-point and dropping FAILED_ATTEMPT (run 319163b5). Both miss two of
  // the three stuck families. The search description must teach: a tracking_status query is a SINGLE-value
  // match (NOT a 'stuck' grouping), FAILED_ATTEMPT is a DISTINCT status (not an EXCEPTION), the stuck set
  // spans SEVERAL distinct statuses, and the reliable sweep is blank-enumerate-then-classify-in-context.
  it("search description teaches the distinct-status exception taxonomy (single-value match, FAILED_ATTEMPT ≠ EXCEPTION, blank-enumerate sweep)", () => {
    const m = load() as {
      tools: Record<string, { description?: string }>
    }
    const d = m.tools.search?.description ?? ""
    // A tracking_status query is a single-value match, not a 'stuck'/'needs-attention' grouping.
    expect(/single-value match|EXACTLY ONE status/i.test(d)).toBe(true)
    // query='IN_TRANSIT' is explicitly called out as the WRONG way to find stuck parcels.
    expect(/IN_TRANSIT/i.test(d) && /WRONG way to find stuck/i.test(d)).toBe(true)
    // FAILED_ATTEMPT is a DISTINCT status, NOT an EXCEPTION (the failed-delivery-mapped-to-EXCEPTION trap).
    expect(/FAILED_ATTEMPT.*DISTINCT status, NOT an EXCEPTION/is.test(d)).toBe(true)
    // No single status means 'stuck'; the set spans several distinct values.
    expect(/no single status that means 'stuck'|spans SEVERAL DISTINCT/i.test(d)).toBe(true)
    // The reliable sweep is blank-enumerate + classify each hit in-context.
    expect(/BLANK-enumerate/i.test(d) && /classify each hit's tracking_status in-context/i.test(d)).toBe(
      true,
    )
  })

  // Regression (stuck-shipment-exception-sweep) — the BROADER-stuck + anti-fabrication-link affordance.
  // On the nadia boxtal+shopify+tickets sweep a weak model (run abc29d72): (a) treated only carrier-flagged
  // statuses as stuck and DROPPED the delivered-but-disputed shipment (status DELIVERED looks healthy) until
  // the persona hinted, and (b) when it surfaced it, FABRICATED a placeholder linked ticket id
  // ('...123456789abc') with ZERO tool calls that turn. The agentInstructions must teach: (1) 'stuck' is
  // broader than the EXCEPTION flag — a DELIVERED-but-disputed parcel is stuck, caught ONLY by cross-checking
  // the support queue for a non-receipt/dispute ticket before concluding a DELIVERED parcel is fine; (2) a
  // 'link the customer's ticket' must cite ONLY a ticket id a tool returned THIS turn, never invent a
  // placeholder, and say 'no existing ticket found' when none matches.
  it("agentInstructions teaches the delivered-but-disputed cross-check + the anti-fabrication ticket-link rule", () => {
    const ai = guideText(load())
    // 'stuck' is broader than the EXCEPTION flag; do not rely on exceptions_list alone for a sweep.
    expect(/BROADER than the carrier EXCEPTION flag|do NOT rely on exceptions_list alone/i.test(ai)).toBe(true)
    // The delivered-but-disputed family is named explicitly as the easiest to miss.
    expect(/DELIVERED but the customer disputes|delivered-but-disputed/i.test(ai)).toBe(true)
    // The sweep is TWO required passes (carrier + support), unioned — a carrier-only sweep is INCOMPLETE.
    expect(/TWO passes you MUST run BOTH/i.test(ai)).toBe(true)
    expect(/PASS 1 \(carrier side\)/i.test(ai) && /PASS 2 \(support side/i.test(ai)).toBe(true)
    expect(/only ran PASS 1 and reported the carrier-flagged parcels is INCOMPLETE/i.test(ai)).toBe(true)
    // PASS 2 scans the OPEN ticket queue for non-receipt/dispute language to catch the disputed deliveries.
    expect(/OPEN tickets \(status=open\)/i.test(ai)).toBe(true)
    expect(/not received.*never arrived.*missing.*where is my order.*disputed/is.test(ai)).toBe(true)
    // Do NOT trust the search snapshot status to decide which to track (the stale/decoy-snapshot trap).
    expect(/Do NOT trust the search snapshot's tracking_status|track is the source of truth/i.test(ai)).toBe(
      true,
    )
    // The anti-fabrication link rule: cite only a tool-returned id; never invent a placeholder.
    expect(/cite ONLY a ticket id\/handle that a tool result returned THIS turn/i.test(ai)).toBe(true)
    expect(/NEVER invent or paste a placeholder ticket id or order number|123456789abc/i.test(ai)).toBe(true)
    expect(/no existing ticket found/i.test(ai)).toBe(true)
    // The RELIABLE lookup is by customer NAME / order number, NOT problem keywords (the false-none trap).
    expect(/by the CUSTOMER NAME or the ORDER NUMBER/i.test(ai)).toBe(true)
    expect(/NOT by problem keywords/i.test(ai)).toBe(true)
    // The order number is already on the boxtal shipment — no separate shopify call needed to state it.
    expect(/order reference are ALREADY on the boxtal shipment|do NOT need a separate shopify call/i.test(ai)).toBe(
      true,
    )
    // Only link a ticket that concerns THIS stuck shipment (the unrelated-RMA over-link trap).
    expect(/UNRELATED tickets|only link a ticket that actually concerns THIS stuck shipment/i.test(ai)).toBe(
      true,
    )
  })

  // Regression (draft-rma-reply-with-return-label-attach) — the CROSS-APP file-source enabler. A prepared
  // Boxtal RETURN LABEL must be obtainable as a kernel.files id the agent can pass to mail:reply
  // attachments. kernel.files rows are only RLS-visible to files_list when their (app, entityType) is a
  // registered fileParent; without a shipment fileParent the files_select policy denies the boxtal-parented
  // label and the agent can never resolve a real label id (and would be forced to fabricate one). The
  // shipment entity must declare a fileParent joining on id, gated by the shipment read/write scopes.
  it("declares a shipment fileParent so a return-label kernel.files row is files_list-able (cross-app attach)", () => {
    const m = load() as {
      entities: Record<string, { fileParent?: Record<string, string> }>
    }
    const fp = m.entities.shipment?.fileParent
    expect(fp).toBeDefined()
    if (!fp) throw new Error("shipment entity missing fileParent")
    expect(fp.tableName).toBe("shipment")
    expect(fp.schemaRef).toBe("app_boxtal")
    expect(fp.joinOn).toBe("id")
    expect(fp.readScope).toBe("boxtal:shipments:read")
    expect(fp.writeScope).toBe("boxtal:shipments:write")
  })

  // Regression (draft-rma-reply-with-return-label-attach) — the cross-app label-ATTACH affordance. On the
  // RMA-reply-with-label scenario a weak model located the prepared return shipment via search but then
  // never resolved the label's kernel file id (it did NOT call files_list on the shipment), sent
  // mail:reply with NO attachments, and falsely told the customer it "attached the return shipping label"
  // (run 5bddfdab). The agentInstructions must teach the end-to-end ATTACH path for an ALREADY-PREPARED
  // return label: find the shipment → files_list(app='boxtal', entityType='shipment', entityId=<id>) for
  // the label file id → pass it into the reply's attachments — and forbid claiming an attachment unless
  // the array carried a files_list-returned id (the empty-attachments fabrication).
  it("agentInstructions teaches attaching an EXISTING prepared return label via files_list on the shipment (no fabricated id)", () => {
    const ai = guideText(load())
    expect(/ATTACHING AN ALREADY-PREPARED RETURN LABEL/i.test(ai)).toBe(true)
    // The reliable path is files_list on the boxtal shipment for the attachable file id.
    expect(/files_list/i.test(ai)).toBe(true)
    expect(/entityType='shipment'|entity_type.*shipment/i.test(ai)).toBe(true)
    // The attach goes into the reply tool's attachments array.
    expect(/attachments=\[/i.test(ai)).toBe(true)
    // Anti-fabrication: never claim attached unless the array carried a real files_list id.
    expect(/NEVER invent or guess a label\/file id|NEVER tell the customer you attached/i.test(ai)).toBe(true)
    // The kernel file id (not a get_documents URL) is the attachable id.
    expect(/the ATTACHABLE kernel file id .*comes from files_list/i.test(ai)).toBe(true)
  })

  // mason-reed-rma-firmware-warranty-flow (run b595cf65): the weak model opened the return draft, ran
  // set_package/set_customs/quote, then REPORTED the label "staged and pending approval" — but never
  // called create_shipment, so no Boxtal approval existed (a false completion). The RETURNS section must
  // teach that staging is finished ONLY by the final create_shipment(is_return:true) call (quote ≠
  // staging), forbid claiming staged without that call, and name the warranty-RMA return procedure.
  it("agentInstructions teaches that a return is staged ONLY by the final create_shipment call (quote ≠ staging; no false completion)", () => {
    const ai = guideText(load())
    expect(/STAGING A RETURN IS NOT FINISHED UNTIL create_shipment HAS BEEN CALLED/i.test(ai)).toBe(
      true,
    )
    // Quote/draft prep alone is not staging.
    expect(/only PREPARATION|quote.*are only PREPARATION/i.test(ai)).toBe(true)
    // Forbid the false-completion overclaim (the runtime also corrects it: false-approval-guard.ts).
    expect(
      /NEVER report a return label as 'staged'|never report.*staged.*unless your LAST create_shipment/i.test(
        ai,
      ),
    ).toBe(true)
    // Names the warranty-RMA return procedure ending in the gated create_shipment(is_return).
    expect(/warranty RMA return is exactly this/i.test(ai)).toBe(true)
    expect(/create_shipment\(is_return:true\) GATED/i.test(ai)).toBe(true)
  })

  // create_shipment's handler re-quotes the chosen offer (the quote path) before it reserves and
  // finalizes a shipment row, so an actor needs both grants. A single `scope` would let an actor
  // holding only the shipment write grant reach the quote path.
  it("create_shipment declares requiredScopes covering both shipment write and quote read", () => {
    const r = packageManifestSchema.safeParse(load())
    expect(r.success).toBe(true)
    if (!r.success) return
    const t = r.data.tools?.create_shipment as { requiredScopes?: string[]; scope?: string; readOnly?: boolean }
    expect(t.requiredScopes).toEqual(["boxtal:shipments:write", "boxtal:quotes:read"])
    expect(t.scope).toBeUndefined()
    // A label buy is a write: it must never be exempt from scope taint.
    expect(t.readOnly).not.toBe(true)
  })

  // A draft is stored state, like invoicing's drafts_create: a write, ungated, on the same
  // read grant as the other draft edits (set_package, set_customs), so no role loses it.
  it("shipment_draft_create is an ungated write with the draft edits' grant", () => {
    const t = (load() as { tools: Record<string, Record<string, unknown>> }).tools
    const draft = t.shipment_draft_create
    expect(draft?.readOnly).toBeUndefined()
    expect(draft?.gated).toBeUndefined()
    expect(draft?.writesToTable).toBe(t.shipment_draft_set_package?.writesToTable)
    expect(draft?.requiredScopes).toEqual(t.shipment_draft_set_package?.requiredScopes)
  })

  // ticket 10341 hardening: pack_upsert is full-replace, so an agent that edits an existing
  // pack (rename, new components, corrected dims) while omitting carton_tare silently clears
  // it, and the double-tare bug this field exists to prevent comes back with no warning. The
  // agentInstructions must teach the caller to read the pack's current carton_tare first and
  // carry it through on every upsert of an existing pack.
  it("agentInstructions teaches that pack_upsert full-replaces carton_tare and it must be carried through on an existing pack's upsert", () => {
    const ai = guideText(load())
    expect(/carton_tare/i.test(ai)).toBe(true)
    expect(/FULL REPLACE, NOT A PATCH/i.test(ai)).toBe(true)
    expect(/reset to null|silently clears the tare/i.test(ai)).toBe(true)
    // ASCII only, no dash punctuation, in THIS clause specifically (the wider agentInstructions
    // blob predates that house rule and is out of scope here). The clause is the tail of
    // agentInstructions (appended last), so it runs to the end of the string.
    const clauseStart = ai.indexOf("PACK_UPSERT CARTON_TARE IS FULL REPLACE")
    expect(clauseStart).toBeGreaterThan(-1)
    const clause = ai.slice(clauseStart)
    expect(/^[\x00-\x7F]*$/.test(clause)).toBe(true)
    expect(clause).not.toMatch(/--|‒|–|—|―/)
  })

  it("is version 0.14.5, packageFormat 1, kebab name 'boxtal'", () => {
    const m = load() as { name: string; version: string; packageFormat: number }
    expect(m.name).toBe("boxtal")
    // The UI bundle URL is version keyed and immutable, so a UI change that does not bump this
    // ships the OLD bundle to every browser. 0.10.0 was the order-driven prep queue rework;
    // 0.10.1 carries its code-review fixes; 0.10.2 makes the Document column readable outside
    // the sticky Actions cell (short pill labels, icon-only Label). 0.10.1 is ALREADY LIVE in
    // prod, so reusing that number would leave every browser on the sliced-column bundle. 0.10.6
    // carries the missing-state backfill/merge fix for US Shopify recipient addresses. 0.10.7
    // fixed the raw-stack resolver margin, but its merge-raw branch and its dims-based
    // double-taring heuristic both still leaked the same bug. 0.10.8 removes the remaining
    // +1 cm on the merge-raw branch and replaces the dims heuristic with a real carton_tare
    // field on the pack row, tared exactly once regardless of dims or ladder tier changes.
    // 0.10.9 keeps the merge tare slot in sync when a merge replaces a parcel, and teaches
    // agentInstructions that pack_upsert full-replaces carton_tare. 0.10.10 stops the To
    // prepare queue from calling a row ready to ship when its recipient is missing an email or
    // phone (the carrier requires both), blocks Ship when the phone is present but the wrong
    // shape for the destination, and heals a contact's stored email/phone from the Shopify
    // order even when its address already carries a state, so a stale contact does not keep
    // failing the label buy forever. 0.10.11 is the review-fixup pass on that: trims a
    // whitespace-only source phone/email instead of writing it and looping forever, stops
    // paying for a live Shopify call on every sync once a non-US/CA contact is fully healed,
    // names the missing field in the Ship tooltip instead of a generic "incomplete" message,
    // mirrors the US/CA state requirement onto the recipient the same way email and phone are,
    // and gives the queue a Recheck action next to the phone-invalid badge so a contact fixed
    // outside boxtal does not leave Ship disabled until the next full sync. 0.10.12 is a pure
    // refactor of the resolver's carton-selection arithmetic:
    // deletes the remaining +1 cm expressions (the raw-stack DECLARED DIMENSIONS were already
    // fixed in 0.10.7/0.10.8) and re-expresses the ladder thresholds in true centimetres, with
    // carton choice proven byte-identical by an exhaustive true-P sweep against an independent
    // reimplementation of the pre-refactor formula. (0.11.0 landed without this assertion being
    // bumped in the same commit -- the gotcha this test exists to catch, caught on itself.)
    // 0.12.0 is the stale-while-revalidate rework: the worklist cache now survives a full reload
    // (persisted to localStorage, keyed per org), the background refresh that follows a cache-first
    // paint runs unconditionally on every open instead of once per mount, a failed refresh keeps
    // showing the last known rows with a banner instead of wiping the table, and a row a refresh
    // drops is held for a brief exit transition instead of reflowing the grid under the pointer.
    // 0.13.0 makes worklistCandidates drop a row unconditionally, on any scan source and any row
    // kind, once a live local shipment fully covers its invoice, instead of only for order-less
    // rows or only in cache mode.
    // 0.13.1 states in agentInstructions that a repaired unit never ships on the
    // original sale invoice, so the rule loads on a prep row and not only on a
    // warranty trigger where the skill body carried it.
    // 0.13.2 requests invoicing:documents:write. Without it prep_add_shipment and the
    // repair category cannot issue the nominal proforma they exist to issue: the nested
    // cross app call runs on the APP's granted scopes, not the operator's, so it was
    // refused as forbidden even for an admin holding every scope.
    // 0.13.3 stops rewriting every forbidden from the nested proforma call into a
    // missing rights message. The real cause was a missing thread for a gated
    // cross app call, and the rewrite hid it.
    // 0.13.4 falls back to the customer address PHONE when the order shipping
    // address has none, instead of taking the shipping address wholesale and
    // discarding a phone we already hold. Seen on a real order blocked as
    // incomplete while the customer record carried the number.
    // The epic branch's own line: 0.10.8 makes create_shipment declare requiredScopes, 0.10.9
    // marks the read-only tools readOnly for scope taint, 0.10.10 carries the responsive prep grid.
    // 0.13.26 is the merge of origin/main into the agents epic branch: main's bundle up to 0.13.25
    // plus the epic's readOnly marks and create_shipment requiredScopes, on a version strictly
    // above both sides and above main's own head, so no two bundles ever share a version.
    // 0.13.27 marks attention_rules_list readOnly: it was the one read among the
    // twelve unmarked boxtal tools whose handler writes nothing at all.
    // 0.13.28 takes its UI primitives from @liaison/app-ui/kit and its webhook and
    // credential helpers from @liaison/app-sdk: same markup, same behaviour.
    // 0.13.30 shows a blocked row's needs_fix reason (and its Recheck) in the grid again.
    // 0.13.30 also moves the products column's sku to short-code mapping out of the code and into
    // org data (settings_product_codes_get/_set, empty by default), applied server-side by prep_list.
    // 0.13.31 carries neutral code comments and test fixture names: same behaviour.
    // 0.13.32 moves the carton ladder, the stacking thresholds and the nominal proforma value out of
    // the code and into org data (settings_packaging_policy_get/_set); with none set the resolver
    // stacks leftovers into one raw parcel and a nominal proforma is refused until a value is set.
    // 0.13.33 renames BoxtalV3Client's `__testing` bag to a named `TestAccess` object.
    // 0.14.0 adds the Ready-to-ship PACKED mark: a nullable `packed_at` on the shipment row,
    // the ready_set_packed tool that stamps and clears it, `packed`/`packed_at` on every
    // ready_list row, and the row toggle that greys a packed row out. A UI change, so the
    // version-keyed immutable bundle URL must move with it.
    // 0.14.1 is the merge of that shipping-bench fix into the agents epic branch: main's
    // packed mark, v3 client rewrite and prep grid plus the epic's readOnly marks, scope
    // taint guard and per-turn scopes, on a version strictly above both sides.
    // 0.14.2 gives the ship-from form its Email input: address.ts requires an email on every
    // party, so a sender saved without one bought no labels and the form could not express a
    // valid sender. A UI change, so the version-keyed immutable bundle URL must move with it.
    // 0.14.3 lists every tool's scopes in requiredScopes: the kernel refuses the retired
    // single scope key, so the catalog must upgrade every installed bundle.
    // 0.14.5 tells a direct Ship click to re-quote when the price rose (no approval exists
    // to re-stage) and shows the server's message on the Create shipment screen.
    // 0.14.12 reads every queue completely, bounded by state instead of an id-ordered window of
    // 100 random UUIDs (live labels were missing from Ready to ship past 100 shipments).
    // 0.14.13 reads the carrier tracking number off the label when the carrier has not scanned
    // yet, and the packed tick fulfils the Shopify order (untick cancels it, once confirmed).
    // 0.14.14 merges To prepare and Ready to ship into one worklist page with a state filter, and
    // the packed tick shows the fulfillment outcome on the row (green, or the error).
    // 0.14.15 stops a label-read tracking number from triggering the automatic fulfillment: the
    // carrier's first event or the operator's tick fulfils, so no shipping email before packing.
    // 0.14.16 decodes the label without typed arrays (the sandbox deletes them, so prod read no
    // number), keeps one fulfillment request per parcel, and stops reconcile re-reading labels.
    // 0.14.17 keeps the Ready to ship half mounted under the To prepare filter, so the filter
    // counts are the same whichever route opened the worklist.
    // 0.14.18 makes the ship-from address an approved change and verifies webhooks in constant time.
    // 0.14.19 names the Shopify fulfilment tool by its callable name in ready_set_packed's description.
    // 0.14.20: the partial batch proforma sends a complete counterparty and surfaces a failure.
    // 0.14.21: the batch proforma re-grosses net invoice prices for a tax-inclusive issuer.
    // 0.14.22: the webhook silence windows give way to the webhookHealth contract.
    // 0.14.24: the To prepare section scrolls its own content (Add shipment no longer under Ready to ship).
    // 0.14.23: webhookHealth names the upstream probe job (newest Boxtal tracking status change).
    // 0.14.25: the products column follows an org-configurable display rank per short code;
    //   labels and invoices open in the system PDF viewer on desktop (no blob tab there).
    // 0.14.26: track, get_shipment and prep_list are readOnly; their write-backs are best effort.
    // 0.14.27: queue_counts and to_prepare_list are readOnly too; their proforma settle is best effort.
    // 0.14.28: queue_counts and to_prepare_list no longer declare a write target, which the taint
    //   gate takes over readOnly: they are reads in a conversation that holds outside content.
    // 0.14.29: the draft's carton and customs patch take only their declared fields.
    // 0.14.30: the draft writes its Shopify order's ship-to onto a contact that has none; the
    //   create_shipment card reads each address field from the call, else the draft.
    // 0.14.31: settings move to the declarative page (manifest `settings`): the ship-from
    //   address through settings_sender_form_get / settings_sender_address_set (the gated tool),
    //   pickup points and label format through the page's own pair settings_form_get / _set.
    // 0.14.32: the draft reads its Shopify order's ship-to (phone included) and never writes
    //   the contact; a worklist resolve and a quote skip that order read.
    // 0.14.33: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.14.34: named after its provider: the rail label and the listing summary say Boxtal.
    // 0.15.0: import kinds (local products, packs, shipping profiles) and pack.external_ref.
    // 0.15.1: the shipment search no longer reloads the page on every keystroke.
    // 0.15.2: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.15.3: the returns guide drops its false-completion warning; the runtime corrects that claim.
    // 0.15.4: prep_select_offer says it is never needed to book the cheapest offer.
    // 0.15.5: the icon as data (`iconName`), drawn when the UI runs framed; the UI reads the page's path with `currentPath()`.
    // 0.15.6: a row named by its order's number or gid (so:#1097) reads under the order's own id, with its invoice, parcels and quote; prep_sync matches it.
    // 0.15.7: kernel:contacts_write is a declared cross-app call, so prep_sync's address backfill
    // still runs now that an agent's contact edit is gated.
    // 0.15.10: every HUMAN setup step says its own minutes.
    // 0.15.15: the daily backfill-queue-facts job runs only for a workspace with a shipment
    // that has no buy-time snapshot yet.
    // 0.15.16: instruction examples use the Kestrel fiction catalog.
    // 0.16.0: tracking numbers for UPS / DHL Express labels (text, then files.analyzeDocument),
    // a missing-label attention item, and a Country column in To prepare and Ready to ship.
    // 0.17.0: settle_orphan_create (adopt or release an orphaned label purchase), link_state
    // create_abandoned, and the orphan sweep logs once per row instead of every run.
    // 0.17.1: a bunfig.toml wires the Solid JSX preload for `bun test` run from the app dir.
    // 0.17.2: a Shopify fulfillment Shopify refused for the order's state (already fulfilled,
    // cancelled, closed) reads shopify_refused; a bad parameter or unknown id stays shopify_error.
    // 0.18.0: shipping profiles have their own id and serve several variants through a link
    // (product_profile + product_profile_link), with link / unlink / merge / delete tools.
    // 0.19.0: profile short codes are copied onto the products' SKUs in the kernel's product
    // attributes, and a draft reads the code from there first (product-attributes.ts).
    // 0.20.0: the order's own ship-to wins over an address copied onto the contact; a draft reads
    // the contact's verified delivery addresses (kernel:contacts_addresses_list) and says whether
    // they match the order (address_check); prep_meta caches the order's ship-to.
    // 0.21.0: a label is held while the order's address and the verified one differ, until a
    // person picks (prep_set_address_choice); the approval card says which address is used.
    // 0.21.1: a label whose order read failed is refused (order_unreadable); the city counts in
    // the address comparison; St/Ste read as a saint before a name.
    // 0.21.2: only a customer with a verified delivery address is refused on a failed read.
    // 0.22.0: shipments print through the org's document templates (print_record_get), and Ready
    // to ship marks the templates the document rules ask for, with a Print documents control.
    // 0.22.1: the worklist and staging share one rule for parcel lines (a free-text shipping
    // charge packs nothing; an unlinked product line is unresolved in both), and Dutch/Swedish-style
    // spaced postcodes stay whole when the invoice address is parsed.
    // 0.22.2: invoice addresses ending in a country name parse without Intl (the sandbox has
    // none), and a failed quote says why on the row and in the prep_sync result.
    // 0.22.3: an export's customs declaration lists the same parcel lines (a shipping charge is no
    // longer a weightless article that blocks the label; real goods always stay on it).
    // 0.22.4: the first prep_sync now caches the order's ship-to before building the draft, so an
    // "Address differs" hold shows on the first pull.
    // 0.23.0: fulfilments from a tick or a carrier scan name the carrier Shopify knows with the
    // tracking number, and leave the customer email to the shopify app's shipping email policy.
    // 0.23.1: the create-draft form's scroll end leaves room to lift its submit row above the
    // desktop chat dock's bar.
    // 0.23.3: prep_set_address_choice validates at staging and binds the pick to the addresses on its card.
    // 0.23.2: a carrier order id no longer reaches the uuid row-id lookup (print_pack,
    // ready_set_packed, import_label_document), and print_pack renders an issued invoice's missing
    // PDF on demand instead of failing the invoice job.
    // 0.23.4: the app's own install resolves the control-plane contract through an override (the
    // shared package depends on it by workspace protocol).
    // 0.23.7: above 0.23.6, so an instance on either line of work upgrades; no change of its own.
    // 0.23.7: a prep reference that names no invoicing document is refused instead of minting a row.
    // 0.23.8: get_documents answers to "colis" and "expédition" in tool search.
    // 0.23.9: the create tab names the document it ships; Shipments reports the open row.
    // 0.23.10: the tracking note states nothing about a label it never read; import_label_document only attaches.
    // 0.23.12: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.23.13: above the 0.23.12 that main took meanwhile; no change of its own.
    // 0.23.14: shipment_draft_create's description starts a new draft rather than opening one.
    // 0.23.15: shipment_draft_create is declared a write (it stores the draft), still ungated.
    // 0.23.16: the shared settings types it builds against changed; no change of its own.
    // 0.23.18: a hidden tool names the visible one to use instead.
    expect(m.version).toBe("0.23.18")
    expect(m.packageFormat).toBe(1)
  })

  it("backfill-queue-facts reaches only workspaces with a shipment missing its snapshot", () => {
    const jobs = (load() as { jobs: Record<string, { runsFor?: unknown }> }).jobs
    expect(jobs["backfill-queue-facts"]?.runsFor).toEqual({
      rows: { entity: "shipment", where: { queue_facts: null, document_ref: { not: null } } },
    })
  })

  // The declarative settings page (/settings/apps/boxtal): the Boxtal account
  // connection, the ship-from address, the pickup-point policy and the label
  // format, read and written through the page's own pair.
  it("declares its settings page, and no views.settings", () => {
    const m = load() as {
      tools: Record<string, { agentVisible?: boolean; readOnly?: boolean; gated?: boolean; params?: { properties?: Record<string, unknown> } }>
      views: { settings?: unknown }
      settings: { sections: Array<{ id: string; blocks: Array<Record<string, unknown>> }> }
    }
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => s.id)).toEqual(["connection", "sender", "pickup-points", "labels"])
    expect((load() as { connections: Record<string, { purpose?: string }> }).connections.boxtal?.purpose).toBe(
      "Boxtal API keys",
    )
    const fieldsOf = (id: string) =>
      (m.settings.sections.find((s) => s.id === id)?.blocks ?? []).filter((b) => b.block === "field")
    const sender = fieldsOf("sender")
    expect(sender.map((f) => f.key)).toEqual(["name", "phone", "email", "street", "postalCode", "city", "countryIsoCode"])
    // The ship-from address is written by the agents' own gated tool, so its gate, its
    // approval card and any org approval policy on it apply to a click on the page too.
    for (const f of sender) {
      expect(f.source, String(f.key)).toEqual({
        tool: { get: "settings_sender_form_get", set: "settings_sender_address_set" },
      })
      // Boxtal refuses a shipment whose sender has no email (422 NotBlank): every
      // ship-from field is required, so none can be cleared.
      expect((f.validation as { required?: boolean } | undefined)?.required, String(f.key)).toBe(true)
    }
    const rest = [...fieldsOf("pickup-points"), ...fieldsOf("labels")]
    expect(rest.map((f) => f.key)).toEqual(["exclude_pickup_point_services", "label_format"])
    for (const f of rest) {
      expect(f.source).toEqual({ tool: { get: "settings_form_get", set: "settings_form_set" } })
    }
    // The page's own reads, and its ungated write of the two ungated settings only: it can
    // never write the ship-from address around the gated tool.
    expect(m.tools.settings_sender_form_get).toMatchObject({ readOnly: true, agentVisible: false })
    expect(m.tools.settings_form_get).toMatchObject({ readOnly: true, agentVisible: false })
    expect(m.tools.settings_form_set?.agentVisible).toBe(false)
    expect(m.tools.settings_form_set?.gated).toBeUndefined()
    expect(Object.keys(m.tools.settings_form_set?.params?.properties ?? {}).sort()).toEqual([
      "exclude_pickup_point_services",
      "label_format",
    ])
  })

  it("setting the ship-from address is an approved change: it prints on every label", () => {
    const tool = (load() as { tools: Record<string, { gated?: boolean }> }).tools
      .settings_sender_address_set
    expect(tool?.gated).toBe(true)
  })

  // readOnly is what keeps a read from provisioning a connection thread and from
  // tainting the caller's scope, so a tool that writes NOTHING must carry it and a
  // tool that writes anything must not. These twelve were unmarked together; each
  // handler was read, and only one of them turned out to be a read.
  it("marks attention_rules_list, track, get_shipment, prep_list, queue_counts and to_prepare_list readOnly, and the six writers beside them not", () => {
    const m = load() as { tools: Record<string, { readOnly?: boolean }> }
    expect(m.tools.attention_rules_list?.readOnly).toBe(true)
    // 0.14.26/0.14.27: these five write back only Boxtal's or the invoicing app's own state (the
    // shipment snapshot, a settled proforma, the resolved-draft cache), and best effort: a
    // failed write never fails the read, so none of them is a sink for a turn's data.
    for (const name of ["track", "get_shipment", "prep_list", "queue_counts", "to_prepare_list"]) {
      expect(m.tools[name]?.readOnly, name).toBe(true)
      // 0.14.28: and none of them declares a write target. The taint gate takes a declared
      // `writesToTable` over `readOnly`, so 0.14.27's queue_counts (prep_order_state) and
      // to_prepare_list (prep_draft_cache) were still gated as writes in a tainted turn.
      expect((m.tools[name] as { writesToTable?: string })?.writesToTable, name).toBeUndefined()
    }
    // Each of these reaches a write it depends on: the pending-proforma settle inside the order
    // scan (quote_batch, prep_document_pdf), a stored file
    // (print_pack, print_pack_batch, prep_document_pdf), or a persisted draft override
    // (shipment_draft_set_package / _set_customs).
    for (const name of [
      "quote_batch",
      "prep_document_pdf",
      "print_pack",
      "print_pack_batch",
      "shipment_draft_set_package",
      "shipment_draft_set_customs",
    ]) {
      expect(m.tools[name]?.readOnly, name).not.toBe(true)
    }
  })

  // The tracking-reconciliation safety net MUST stay declared: without it the
  // app's only writer of tracking_status is the webhook stream, which failed
  // silently in prod for a month (401 signature_mismatch, rejected before any
  // ledger row) and left delivered parcels sitting in "Ready to ship".
  it("declares the probe-webhook-upstream cron job", () => {
    const m = load() as { jobs?: Record<string, { handler: string; schedule?: string }> }
    const job = m.jobs?.["probe-webhook-upstream"]
    expect(job?.handler).toBe("probeWebhookUpstreamJob")
    expect(job?.schedule).toBe("*/15 * * * *")
    expect((m as { webhookHealth?: unknown }).webhookHealth).toEqual({ probe: "probe-webhook-upstream" })
  })

  it("declares the reconcile-tracking cron job", () => {
    const m = load() as {
      jobs?: Record<string, { handler: string; schedule?: string; timeoutMs?: number }>
    }
    const job = m.jobs?.["reconcile-tracking"]
    expect(job).toBeDefined()
    expect(job?.handler).toBe("reconcileTrackingJobHandler")
    // A schedule is what makes it a safety net rather than a manual tool.
    expect(job?.schedule).toBeTruthy()
  })
  // 2026-07-20 prod incident: create_shipment ran at the prod default 5s sandbox
  // budget with atomic:true. The worker was killed mid-run AFTER the Boxtal
  // label buy; the whole-run transaction rolled back the reservation row, so
  // the bought order vanished from local state (only Boxtal's document-created
  // webhook proved it existed). A tool whose handler spends money externally
  // must (a) carry an explicit generous timeout and (b) NEVER use whole-run
  // rollback -- the reserve/finalize/markUncertain writes must commit per-call
  // so a killed worker leaves the in-flight row that blocks a blind re-buy.
  it("create_shipment declares a generous timeoutMs and is NOT atomic (external label buy must survive a worker kill)", () => {
    const m = load() as { tools: Record<string, { timeoutMs?: number; atomic?: boolean }> }
    const t = m.tools.create_shipment!
    expect(t.timeoutMs).toBeGreaterThanOrEqual(30000)
    expect(t.atomic).toBeUndefined()
  })
  it("every external-API tool declares a timeoutMs above the 5s prod default", () => {
    const m = load() as { tools: Record<string, { timeoutMs?: number }> }
    for (const name of [
      "quote",
      "cancel_shipment",
      "get_shipment",
      "track",
      "get_documents",
      "import_label_document",
      "import_shipments",
    ]) {
      expect(m.tools[name]?.timeoutMs ?? 0).toBeGreaterThanOrEqual(15000)
    }
  })
  it("declares the Phase-18 scope set", () => {
    const m = load() as { scopes: string[] }
    const required = [
      "boxtal:quotes:read",
      "boxtal:shipments:read",
      "boxtal:shipments:write",
      "boxtal:documents:read",
      "boxtal:catalog:read",
      "boxtal:catalog:write",
      "boxtal:admin:connection",
    ]
    for (const s of required) expect(m.scopes).toContain(s)
  })

  // Regression (marco-mondial-relay-pickup-expiry-followup) — the track tool must expose the
  // authoritative carrier-reported collection deadline so an agent decides which relay parcels are
  // "about to expire" from a REAL date, not a fabricated one.
  it("track tool documents pickup_deadline as the authoritative pickup-point collection deadline", () => {
    const m = load() as { tools: Record<string, { description: string } | undefined> }
    const desc = m.tools.track?.description ?? ""
    expect(desc.length).toBeGreaterThan(0)
    expect(/pickup_deadline/.test(desc)).toBe(true)
    expect(/collection deadline|return.*to.*sender|expire/i.test(desc)).toBe(true)
    // It must steer the agent to compare against today / not fabricate a deadline.
    expect(/do NOT (estimate|fabricate)|never (fabricate|guess)/i.test(desc)).toBe(true)
  })

  // Regression (marco-bulk-import-carrier-rate-sheet-impossible) — the HONEST-LIMIT crux. pack_upsert is
  // ONE pack per call and there is NO bulk/CSV pack-ingest primitive anywhere; the terse old description
  // ("Create or update a named pack...") let a weak agent claim it "imported all 40 carton SKUs" or loop
  // pack_upsert until the per-turn budget killed the turn mid-import. The description MUST teach the
  // single-record limit + the no-bulk fact + the demonstrate-a-few-then-offload pattern so the honest
  // path is reachable from the tool surface (NOT a broad system.md edit — BL-265).
  it("pack_upsert description teaches the single-record/no-bulk limit + demonstrate-a-few-then-offload pattern", () => {
    const m = load() as { tools: Record<string, { description: string } | undefined> }
    const desc = m.tools.pack_upsert?.description ?? ""
    expect(desc.length).toBeGreaterThan(0)
    // One pack per call.
    expect(/ONE .*pack per call|single pack per call|one pack per call/i.test(desc)).toBe(true)
    // No bulk / no CSV ingest primitive.
    expect(/NO bulk|no batch|NO CSV|cannot import a whole list/i.test(desc)).toBe(true)
    // Forbid the "imported them all" fabrication + the budget-killing loop.
    expect(/do NOT claim you imported them all|not claim.*imported.*all/i.test(desc)).toBe(true)
    expect(/loop pack_upsert|until the per-turn step budget|mid-import/i.test(desc)).toBe(true)
    // Teach the demonstrate-a-few-then-offload (spawn_agent / routine) workaround.
    expect(/handful|a HANDFUL|demonstrate the unit path/i.test(desc)).toBe(true)
    expect(/spawn_agent|routine/i.test(desc)).toBe(true)
  })

  // Regression (journey l766 S7, marco-define-carton-pack-template) — a weak agent omitted the required
  // 4-item component BOM (upserted the bundle carton with components:[]) because `components` was an
  // undocumented trailing param and nothing told the model the BOM is mandatory for a kit pack. The tool
  // surface must (1) make `components` first-class in the description, mark it REQUIRED for a bundle/kit
  // pack, show an example BOM, and point at the packages_list.local_products name→sku lookup; and (2)
  // describe the `components` param + its item fields so the model knows how to fill it.
  it("pack_upsert description makes the component BOM first-class + required for bundle packs (with an example + sku lookup)", () => {
    const m = load() as {
      tools: Record<
        string,
        | {
            description: string
            params?: {
              properties?: {
                components?: {
                  description?: string
                  items?: { properties?: Record<string, { description?: string }> }
                }
              }
            }
          }
        | undefined
      >
    }
    const tool = m.tools.pack_upsert
    const desc = tool?.description ?? ""
    // BOM required for a bundle/kit pack + an empty components list is incomplete.
    expect(/bill of materials|BOM/i.test(desc)).toBe(true)
    expect(/REQUIRED, not optional|BOM is REQUIRED|required for a bundle|empty .*components/i.test(desc)).toBe(true)
    // A concrete example BOM the model can pattern-match.
    expect(/product_source.*product_id|RAL-44.*ER-OVL/s.test(desc)).toBe(true)
    // The name→sku lookup path (packages_list.local_products).
    expect(/packages_list|local_products|label.*sku/i.test(desc)).toBe(true)
    // The `components` param + its item fields are documented, not bare.
    const comp = tool?.params?.properties?.components
    expect((comp?.description ?? "").length).toBeGreaterThan(0)
    const itemProps = comp?.items?.properties ?? {}
    expect((itemProps.product_source?.description ?? "").length).toBeGreaterThan(0)
    expect((itemProps.product_id?.description ?? "").length).toBeGreaterThan(0)
  })

  // Regression (journey l766 S4, marco-batch-ship-eu-ready-queue) — the batch step thrashed and
  // false-failed: the manifest marked `from`/`to`/`parcels`/`content_code` REQUIRED on `quote`, but the
  // handler already defaults `from` from the org origin and (with `draft_id`) fills `to`/`parcels`/
  // `content_code` from the draft. So a weak model quoting a draft hit "missing required content_code",
  // re-quoted in a loop with malformed (string-vs-object) `from`/`to`, burned the whole budget, never
  // reached create_shipment, and fabricated "staged 10 orders". The schema must NOT force those fields
  // (the handler is lenient) and must document the draft-default + object-shape so the model quotes cleanly.
  it("quote schema does NOT force from/to/parcels/content_code (handler defaults them); content_code + to are documented as optional/object", () => {
    const m = load() as {
      tools: Record<
        string,
        | {
            description?: string
            params?: {
              required?: string[]
              properties?: Record<string, { description?: string; type?: string }>
            }
          }
        | undefined
      >
    }
    const quote = m.tools.quote
    const required = quote?.params?.required ?? []
    // None of the handler-defaulted fields may be REQUIRED — that was the loop-inducing trap.
    expect(required).not.toContain("content_code")
    expect(required).not.toContain("from")
    expect(required).not.toContain("to")
    expect(required).not.toContain("parcels")
    // content_code is documented as optional + how to obtain it (not a bare undocumented required field).
    const cc = quote?.params?.properties?.content_code
    expect((cc?.description ?? "").length).toBeGreaterThan(0)
    expect(/optional/i.test(cc?.description ?? "")).toBe(true)
    // `to` is documented as an OBJECT (defeats the string-vs-object malformed-call class).
    const to = quote?.params?.properties?.to
    expect(to?.type).toBe("object")
    expect(/object/i.test(to?.description ?? "")).toBe(true)
    // The description teaches the simplest draft_id-only path so the model does not re-quote on a phantom
    // "missing required field".
    expect(/draft_id/i.test(quote?.description ?? "")).toBe(true)
  })

  // Regression (marco-mondial-relay-pickup-expiry-followup, gate runs) — the DRAFTING half failed: the
  // agent produced a generic unfilled template, or claimed "pending approval" without any send-tool call,
  // or said it had "no way to send" a customer who has an open ticket. The agentInstructions must teach
  // the pickup-expiry customer heads-up: a REAL per-parcel filled draft, delivered as a GATED tickets:reply
  // (or surfaced inline), never a generic template, never a fabricated/unbacked "gated" claim.
  it("agentInstructions teaches the pickup-expiry customer heads-up: real filled per-parcel draft, gated tickets__reply, no fabrication", () => {
    const ai = guideText(load())
    expect(/return-to-sender|RETURN-TO-SENDER/i.test(ai)).toBe(true)
    expect(/heads-up/i.test(ai)).toBe(true)
    // The two failure modes the guidance must forbid: generic template + fabricated gated claim.
    expect(/generic (unfilled )?template|unfilled template/i.test(ai)).toBe(true)
    expect(/NEVER claim a message was|fabrication/i.test(ai)).toBe(true)
    // The real channel is the gated tickets__reply.
    expect(/tickets__reply/i.test(ai)).toBe(true)
    expect(/pickup_deadline/i.test(ai)).toBe(true)
    // REGRESSION (l766 S10) — for a NO-ticket customer the agent thrashed toward mail:compose (unavailable)
    // + a placeholder ticket and fabricated "pending approval" across turns. The guidance must make the
    // INLINE filled draft the complete deliverable for a no-ticket customer, forbid reaching for
    // mail:compose, and require an errored tickets:reply be reported as NOT-through (fall back to inline),
    // never as a pending approval.
    expect(/inline filled draft IS the finished deliverable|inline draft alone fully satisfies/i.test(ai)).toBe(true)
    expect(/do NOT reach for mail:compose|not your channel here/i.test(ai)).toBe(true)
    expect(/do NOT report it as pending approval|say plainly it did not go through/i.test(ai)).toBe(true)
  })

  // Regression (marco-fulfillment-throughput-shipping-cost-impossible) — the throughput/spend DATA-HONESTY
  // affordance. "How many parcels did we ship this month and what did we spend by carrier" has a doable half
  // (parcel VOLUME by carrier) and an impossible half (shipping SPEND). A weak model (i) presents queue_counts
  // as 'parcels shipped this month', (ii) fabricates a confident per-carrier EUR spend (often by summing the
  // old `cost`/declared_total field), or (iii) claims a precise this-month per-carrier count without the
  // no-date-filter/sample caveat. The agentInstructions + tool descriptions must drive all three out.
  it("agentInstructions teaches throughput-vs-spend honesty (queue_counts≠throughput; volume tally bounded+no-date-filter; spend uncomputable, no invented EUR)", () => {
    const ai = guideText(load())
    // Names the throughput + spend-by-carrier ask it governs.
    expect(/SHIPPING THROUGHPUT & SPEND BY CARRIER/i.test(ai)).toBe(true)
    // queue_counts is LIVE state, NOT 'parcels shipped this month'.
    expect(/queue_counts is NOT throughput/i.test(ai)).toBe(true)
    expect(/never 'parcels shipped this month'|not present it as a monthly shipped count/i.test(ai)).toBe(true)
    // queue_counts is a MANDATORY FIRST read for a throughput question (the smoke gap: agent skipped it).
    expect(/MANDATORY FIRST STEP/i.test(ai)).toBe(true)
    expect(/Do NOT answer a throughput question from search alone/i.test(ai)).toBe(true)
    // It must RENDER the queue numbers in the reply, not merely call the tool (the gate run-1 gap).
    expect(/RENDER its actual numbers IN THE USER-FACING REPLY/i.test(ai)).toBe(true)
    expect(/NOT enough to merely CALL queue_counts/i.test(ai)).toBe(true)
    expect(/do NOT let the queue numbers silently coincide with the carrier-tally total/i.test(ai)).toBe(true)
    // Consistency: do not reverse a bounded-sample framing into 'complete/authoritative whole fleet'.
    expect(/CONSISTENCY, keep the SAME/i.test(ai)).toBe(true)
    expect(/do NOT later UPGRADE it to 'the entire active fleet|nextCursor: null.*does NOT license/is.test(ai)).toBe(true)
    // Volume tally is by offer_code over a paged sample with no date filter.
    expect(/group the hits by their `carrier` \(offer_code\)/i.test(ai)).toBe(true)
    expect(/NO created_at \/ ship-date field and NO date filter|cannot isolate 'this month'/i.test(ai)).toBe(true)
    expect(/OFFSET-PAGED SAMPLE/i.test(ai)).toBe(true)
    // Spend is uncomputable: declared_value is parcel value, not carrier spend; no shipping price persisted.
    expect(/declared_value.*declared parcel VALUE.*NOT what was paid to ship/is.test(ai)).toBe(true)
    expect(/shipping SPEND by carrier CANNOT be computed/i.test(ai)).toBe(true)
    expect(/do NOT invent EUR spend figures|do NOT sum declared_value/i.test(ai)).toBe(true)
  })

  // Companion to the above: the search + queue_counts tool descriptions carry the same honesty so the
  // affordance surfaces even when the agent reads the tool result directly. Guards the field RENAME
  // (cost → declared_value) at the description level too.
  it("search description teaches carrier-volume tally + no-date-filter + declared_value≠spend; queue_counts says live-state-not-throughput", () => {
    const m = load() as { tools: Record<string, { description?: string }> }
    const s = m.tools.search?.description ?? ""
    expect(/CARRIER VOLUME \/ THROUGHPUT BY CARRIER/i.test(s)).toBe(true)
    expect(/NO created_at \/ ship-date field and NO date-range parameter/i.test(s)).toBe(true)
    expect(/OFFSET-PAGED SAMPLE/i.test(s)).toBe(true)
    expect(/`declared_value` is the declared parcel VALUE.*NOT the carrier shipping spend/is.test(s)).toBe(true)
    expect(/shipping SPEND by carrier CANNOT be computed or summed/i.test(s)).toBe(true)
    expect(/dateBoundNotice and spendNotice/i.test(s)).toBe(true)
    const qc = m.tools.queue_counts?.description ?? ""
    expect(/LIVE queue counts as of NOW/i.test(qc)).toBe(true)
    expect(/NOT 'parcels shipped this month'/i.test(qc)).toBe(true)
  })

  it("every gated tool declares a summarizer that resolves to a real ./summarizers export", () => {
    const m = load() as { tools: Record<string, { gated?: boolean; summarizer?: string }> }
    const gated = Object.entries(m.tools).filter(([, t]) => t.gated === true)
    expect(gated.length).toBeGreaterThan(0)
    for (const [name, tool] of gated) {
      expect(tool.summarizer, `${name} is gated but declares no summarizer`).toBeDefined()
      const fn = (summarizers as Record<string, unknown>)[tool.summarizer as string]
      expect(
        typeof fn,
        `${name}'s summarizer "${tool.summarizer}" is not exported from ./summarizers`,
      ).toBe("function")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// STANDING ORACLE: package resolution is DETERMINISTIC.
//
// What goes in which carton, and therefore what the customer is charged for shipping and what
// customs is told, comes out of `resolver.ts` reading shipping profiles and packs. It must never
// come out of a model. An LLM in that path would make the same parcel resolve differently on two
// runs, which is unauditable at a customs boundary and unpriceable at a carrier one. The rule is
// wider than the resolver, so it is checked over the whole app source: no model SDK is imported and
// no model is called anywhere under src/.
// ─────────────────────────────────────────────────────────────────────────────
describe("no model in the package path", () => {
  const AI_PATTERN =
    /from\s+["'](@anthropic-ai\/sdk|openai|@google\/generative-ai|ai)["']|\.messages\.create\(|generateText\(|chat\.completions\.create\(|kernel:agent|kernel:complete/

  function appSources(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "__fixtures__" || entry.name === "node_modules") continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue
        if (entry.name.includes(".test.")) continue
        out.push(full)
      }
    }
    walk(import.meta.dir)
    return out
  }

  it("scans the real shipped source (sanity: the scan is not empty)", () => {
    expect(appSources().length).toBeGreaterThan(20)
  })

  it("imports no model SDK and makes no model call anywhere under src", () => {
    const offenders = appSources().filter((f) => AI_PATTERN.test(readFileSync(f, "utf8")))
    expect(offenders.map((f) => f.replace(import.meta.dir, "src"))).toEqual([])
  })

  it("is falsifiable: the pattern catches a model call and a model import", () => {
    expect(AI_PATTERN.test('const r = await client.messages.create({ model: "x" })')).toBe(true)
    expect(AI_PATTERN.test('import Anthropic from "@anthropic-ai/sdk"')).toBe(true)
    expect(AI_PATTERN.test('await ctx.executeTool("kernel:complete", {})')).toBe(true)
    expect(AI_PATTERN.test("const parcels = resolvePackages(lines, profiles)")).toBe(false)
  })

  it("keeps the resolver itself dependency free: relative imports only", () => {
    const src = readFileSync(join(import.meta.dir, "resolver.ts"), "utf8")
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!)
    expect(imports.filter((i) => !i.startsWith("./") && !i.startsWith("../"))).toEqual([])
  })
})
