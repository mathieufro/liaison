// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import * as summarizers from "./summarizers"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

function loadManifest(): unknown {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
}

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

/**
 * Returns the dotted paths of every OPAQUE param on an agent-visible tool — a `type:object`
 * with neither `properties` nor `additionalProperties:true`, or a `type:array` with no `items`
 * schema. The weak agent can't see such a param's shape and guesses wrong (the EmailInput 422
 * class). Tools flagged `agentVisible:false` are system/internal and exempt.
 */
function findOpaqueParams(manifest: unknown): string[] {
  if (!isObj(manifest) || !isObj(manifest.tools)) return []
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
  for (const [name, tool] of Object.entries(manifest.tools)) {
    if (!isObj(tool) || tool.agentVisible === false) continue
    const params = isObj(tool.params) ? tool.params : undefined
    const props = params && isObj(params.properties) ? params.properties : undefined
    if (props) for (const [k, v] of Object.entries(props)) walk(v, `${name}.${k}`)
  }
  return opaque
}

describe("Shopify app.manifest.json", () => {
  it("parses as JSON", () => {
    expect(loadManifest()).toBeTypeOf("object")
  })

  it("validates against packageManifestSchema", () => {
    const result = packageManifestSchema.safeParse(loadManifest())
    if (!result.success) {
      // Surface the violation list for fast TDD feedback.
      console.error("manifest validation failed:", JSON.stringify(result.error.issues, null, 2))
    }
    expect(result.success).toBe(true)
  })

  it("declares the full Phase-16 scope set (orders, customers, products, markets, ...)", () => {
    const m = loadManifest() as { scopes: string[] }
    const required = [
      "shopify:orders:read",
      "shopify:orders:write",
      "shopify:draft-orders:read",
      "shopify:draft-orders:write",
      "shopify:refunds:create",
      "shopify:returns:read",
      "shopify:returns:write",
      "shopify:fulfillments:read",
      "shopify:fulfillments:write",
      "shopify:customers:read",
      "shopify:customers:write",
      "shopify:products:read",
      "shopify:products:write",
      "shopify:inventory:read",
      "shopify:inventory:write",
      "shopify:markets:read",
      "shopify:discounts:read",
      "shopify:discounts:write",
      "shopify:metafields:read",
      "shopify:metafields:write",
      "shopify:admin:identity-map",
    ]
    for (const s of required) {
      expect(m.scopes).toContain(s)
    }
  })

  it("declares the OAuth2 `shop` connection with the Shopify domain allowlist", () => {
    // `connections` is an OBJECT keyed by connection name (not an array).
    const m = loadManifest() as {
      connections: Record<string, { type: string; allowedDomains?: string[] }>
    }
    const shop = m.connections.shop
    expect(shop?.type).toBe("oauth2")
    expect(shop?.allowedDomains).toContain("*.myshopify.com")
  })

  it("declares the 7 Phase-16 entities with kernel handles + readScope", () => {
    const m = loadManifest() as {
      entities: Record<string, { handlePrefix: string; readScope: string }>
    }
    for (const e of ["order", "customer", "product", "draftOrder", "return", "refund", "market"]) {
      expect(m.entities[e]).toBeDefined()
      expect(m.entities[e]?.handlePrefix).toMatch(/^shopify_/)
      expect(m.entities[e]?.readScope).toMatch(/^shopify:/)
    }
  })

  it("declares the search handler with the 3 entities and timeoutMs", () => {
    const m = loadManifest() as {
      search: { handler: string; entities: string[]; timeoutMs: number }
    }
    expect(m.search.handler).toBe("searchHandler")
    expect(new Set(m.search.entities)).toEqual(new Set(["order", "product", "customer"]))
    expect(m.search.timeoutMs).toBe(5000)
  })

  it("declares 9 attention translations with kernel-legal event names (^[a-z_]+:[a-z_]+$)", () => {
    const m = loadManifest() as {
      attention: { translations: Array<{ event: string; kind: string; urgency: number }> }
    }
    expect(m.attention.translations.length).toBe(9)
    const eventPattern = /^[a-z_]+:[a-z_]+$/
    for (const t of m.attention.translations) {
      expect(t.event).toMatch(eventPattern)
      expect(t.kind).toMatch(/^shopify:/)
      expect(t.urgency).toBeGreaterThanOrEqual(0)
      expect(t.urgency).toBeLessThanOrEqual(100)
    }
  })

  // An attention row is a frozen snapshot: the translator renders it once, at
  // event time, and it then sits in the feed until someone clicks "Read". So a
  // kind that describes a TRANSIENT condition needs a resolving translation, or
  // it keeps claiming a state the store has long since left ("New order #3330"
  // for an order shipped a week ago).
  it("every transient kind has a resolving translation", () => {
    const m = loadManifest() as {
      attention: {
        translations: Array<{
          event: string
          kind: string
          resolveWhen?: { always?: true; field?: string; equals?: unknown }
        }>
      }
    }
    const resolversFor = (kind: string) =>
      m.attention.translations.filter((t) => t.kind === kind && t.resolveWhen)

    // A new order stops needing attention once it ships or is cancelled.
    const orderResolvers = resolversFor("shopify:order.created")
    expect(orderResolvers.map((t) => t.event).sort()).toEqual([
      "order:cancelled",
      "order:fulfilled",
    ])
    // A requested return stops needing attention once it is decided or closed.
    const returnResolvers = resolversFor("shopify:return.requested")
    expect(returnResolvers.map((t) => t.event).sort()).toEqual([
      "return:approved",
      "return:closed",
      "return:declined",
    ])
    // The unfulfilled digest resolves on its own count reaching zero.
    const digestResolvers = resolversFor("shopify:orders.unfulfilled")
    expect(digestResolvers).toHaveLength(1)
    expect(digestResolvers[0]!.resolveWhen).toEqual({ field: "count", equals: 0 })
  })

  it("every resolving translation carries a real resolving event, not a duplicate alerter", () => {
    const m = loadManifest() as {
      attention: { translations: Array<{ event: string; resolveWhen?: unknown }> }
    }
    // A translation that resolves unconditionally must NOT also be the event
    // that raises the row, or the row could never appear in the first place.
    const alerting = new Set(
      m.attention.translations.filter((t) => !t.resolveWhen).map((t) => t.event),
    )
    for (const t of m.attention.translations) {
      if (t.resolveWhen && (t.resolveWhen as { always?: true }).always) {
        expect(alerting.has(t.event)).toBe(false)
      }
    }
  })

  it("declares filterableAxes including 'market' (the kernel response-filter axis)", () => {
    const m = loadManifest() as { attention: { filterableAxes: string[] } }
    expect(m.attention.filterableAxes).toContain("market")
  })

  it("declares the implemented backfill / reconcile / scan jobs (no stub jobs)", () => {
    const m = loadManifest() as { jobs: Record<string, { handler: string; schedule?: string }> }
    expect(m.jobs["backfill-customers"]?.handler).toBe("backfillCustomersJob")
    expect(m.jobs["scope-seed"]?.handler).toBe("scopeSeedJob")
    // Neither has a schedule: without onDemand the runtime never registers them, so nothing could run them.
    expect((m.jobs["backfill-customers"] as { onDemand?: boolean }).onDemand).toBe(true)
    expect((m.jobs["scope-seed"] as { onDemand?: boolean }).onDemand).toBe(true)
    expect(m.jobs["reconcile-customers"]?.handler).toBe("reconcileCustomersJob")
    expect(m.jobs["reconcile-customers"]?.schedule).toBe("0 3 * * *")
    expect(m.jobs["scan-unfulfilled-orders"]?.handler).toBe("scanUnfulfilledOrdersJob")
    expect(m.jobs["scan-unfulfilled-orders"]?.schedule).toBe("0 * * * *")
    // §3.4 — 30-day webhook_deliveries ledger prune (daily).
    expect(m.jobs["prune-webhook-deliveries"]?.handler).toBe("pruneWebhookDeliveriesJob")
    expect(m.jobs["prune-webhook-deliveries"]?.schedule).toBe("30 3 * * *")
    // orders/products backfill were notImplemented stubs — removed entirely
    // (a declared-but-throwing job is worse than an absent one).
    expect(m.jobs["backfill-orders"]).toBeUndefined()
    expect(m.jobs["backfill-products"]).toBeUndefined()
  })

  it("declares the capabilities consumed (bulk.fetch, grants.setUserScopes)", () => {
    const m = loadManifest() as { capabilities: string[] }
    expect(m.capabilities).toContain("bulk.fetch")
    expect(m.capabilities).toContain("grants.setUserScopes")
    // Connecting the store adds its customers to the organisation's contacts.
    expect(m.capabilities).toContain("contacts.addToOrganisation")
  })

  // C6 — spec §3.2 categorical-coverage table mandates each of these
  // tools by name. If you remove one, justify the change in the spec first.
  it("declares every spec-§3.2-mandated tool by name (orders, draft-orders, customers, products, markets, metafields)", () => {
    const m = loadManifest() as { tools: Record<string, unknown> }
    const required = [
      // Orders — edit (tags/notes), cancel, fulfill, refund, return
      "order_update",
      "order_cancel",
      "fulfillments_create",
      "fulfillments_update_tracking",
      "refunds_create",
      "returns_request",
      // §3.2 reads added in the deep-review fix track
      "draft_orders_list",
      "draft_orders_get",
      "locations_list",
      "customers_get_by_external_id",
      // Draft orders — full CRUD + send-to-customer + convert-to-order
      "draft_orders_create",
      "draft_orders_update",
      "draft_orders_delete",
      "draft_orders_send",
      "draft_orders_complete",
      // Customers — tag, update
      "customers_tag",
      "customers_update",
      // Products — publish/unpublish + CRUD
      "products_create",
      "products_update",
      "products_delete",
      "products_publish",
      "products_unpublish",
      // Markets — list + get
      "markets_list",
      "markets_get",
      // Metafields — list + set + delete
      "metafields_list",
      "metafields_set",
      "metafields_delete",
    ]
    for (const name of required) {
      expect(m.tools[name], `tool ${name} (spec §3.2 mandated)`).toBeDefined()
    }
  })

  // liam-gated-rma-chain-ref-sequencing (smoke fail ×3) — the agent staged the reply + is_return label but
  // DROPPED the "queue the unit to be restocked once it's back" leg every run: it recorded restock as prose /
  // a ticket note / a Knowledge doc instead of the gated shopify returns_request, because nothing ALWAYS-
  // VISIBLE told it that 'queue a restock-on-receipt' = returns_request and how to build its fulfillmentLineItem
  // input. The rma-full-setup skill teaches it, but the agent did not reliably skill_read it (the same variance
  // the over-tier / day-scoped fixes routed into agentInstructions). So the returns/RMA orientation lives HERE,
  // always-injected, distinct from the pull-based skill.
  it("orients the agent on returns_request as the restock-on-receipt vehicle + the fulfillmentLineItemId chain (always-visible, not skill-gated)", () => {
    const ai = guideText(loadManifest())
    expect(ai).toMatch(/returns_request/) // the vehicle is named
    expect(ai).toMatch(/restock/i) // restock-on-receipt purpose
    expect(ai).toMatch(/queue (it|the unit|a restock)/i) // maps the 'queue restock' ask to returns_request
    expect(ai).toMatch(/fulfillmentLineItem/i) // the gid type the agent kept missing
    expect(ai).toMatch(/fulfillments_get/) // the resolution step
    expect(ai).toMatch(/not (an immediate|just a)|never .* note|note records text/i) // not a note/inventory-bump substitute
    expect(ai).toMatch(/GATED|approval/i) // it lands as an approval
  })

  it("teaches the returns_request fulfillmentLineItemId resolution chain (orders_get → fulfillments_get) in the tool description", () => {
    // liam-gated-rma-chain-ref-sequencing: the "queue the unit to be restocked once it's back" leg was
    // dropped three runs straight — the agent recorded restock as a note/Knowledge doc instead of the
    // gated returns_request, because the terse "Request a Shopify return" description never said the input
    // needs a FulfillmentLineItem gid resolved via orders_get → fulfillments_get. The description must now
    // teach that chain and the restock-on-receipt purpose, so the agent can actually build + call it.
    const m = loadManifest() as { tools: Record<string, { description?: string }> }
    const desc = m.tools.returns_request?.description ?? ""
    expect(desc).toMatch(/restock/i) // the restock-on-receipt purpose
    expect(desc).toMatch(/fulfillments_get/) // the gid source the agent kept missing
    expect(desc).toMatch(/fulfillmentLineItem/i) // the required gid type
    expect(desc).toMatch(/orders_get/) // the resolution path step
    expect(desc).toMatch(/gated|approval/i) // it lands as an approval
  })

  // auto-publish-launch-products-event-trigger — the weak model authored a kind:'event' routine on
  // projects:task:moved to "publish at launch" and told the user the gated publish "will apply
  // automatically upon a qualifying event trigger". products_publish is GATED, so even inside a routine it
  // DRAFTS a per-tick approval (never auto-publishes), and a known/planned launch datetime is a one-shot
  // kind:'scheduled' runAt — NOT an event subscription. The tool description must say so always-visibly.
  it("products_publish description states it is gated → drafts-not-auto-publishes even in a routine, and a known launch time is a scheduled one-shot (not an event routine)", () => {
    const m = loadManifest() as { tools: Record<string, { description?: string }> }
    const desc = m.tools.products_publish?.description ?? ""
    expect(desc).toMatch(/gated/i) // the gate is named
    expect(desc).toMatch(/never auto-executes/i) // it does not auto-publish
    expect(desc).toMatch(/per-tick approval/i) // inside a routine each tick drafts an approval
    expect(desc).toMatch(/scheduled/) // known launch time → kind:'scheduled' runAt
    expect(desc).toMatch(/circular/) // subscribing to product:published to trigger a publish is circular
  })

  // I7 / M4 — every event the bundle emits must be declared in events.emits.
  // We can't statically walk every call site, but we pin the explicit list
  // here and rely on `make-sure-list-matches` discipline.
  it("declares events.emits in canonical `entity:action` form for every ctx.emit the bundle uses", () => {
    const m = loadManifest() as { events: { emits: string[] } }
    const declared = new Set(m.events.emits)
    // Canonical identity: every emit key is `entity:action` (two segments,
    // NO `shopify:` namespace prefix). The kernel builds the event key as
    // `${entity}:${action}` and the channel as `events:shopify:${entity}:${action}`.
    const required = [
      // webhooks
      "order:created",
      "order:updated",
      "order:fulfilled",
      "order:cancelled",
      "customer:created",
      "customer:updated",
      "customer:deleted",
      "refund:created_manual", // refunds/create webhook = MANUAL refund
      "return:requested",
      "fulfillment:created",
      "inventory:level_updated",
      "app:uninstalled",
      // mutations
      "refund:created", // programmatic refund from mutations.ts
      "draft_order:created",
      "draft_order:completed",
      "draft_order:updated",
      "draft_order:deleted",
      "draft_order:sent",
      "fulfillment:cancelled",
      "fulfillment:tracking_updated",
      "product:created",
      "product:updated",
      "product:deleted",
      "product:published",
      "product:unpublished",
      "variant:created",
      "variant:updated",
      "variant:deleted",
      "inventory:adjusted",
      "inventory:set_on_hand",
      "inventory:low",
      "discount:created",
      "discount:updated",
      "discount:deleted",
      "return:approved",
      "return:declined",
      "return:refunded",
      "return:closed",
      "customer:tagged",
      "customer:untagged",
      "customer:email_consent_updated",
      "customer:sms_consent_updated",
      "metafield:set",
      "metafield:deleted",
      "order:edited",
      "order:cancel_requested",
      // attention
      "orders:unfulfilled_digest",
      // jobs
      "customer:backfill_failed",
      "customer:backfill_completed",
      // connect/disconnect subscribers (the settings page refetches on it)
      "connection:updated",
      // invoicing document subscriber (the Orders list refetches its invoice links on it)
      "order:invoice_changed",
      // reconcile-customers job emits customer:deleted (already covered above)
    ]
    for (const ev of required) {
      expect(declared.has(ev), `events.emits missing: ${ev}`).toBe(true)
    }
  })

  it("declares NO legacy `shopify:`-namespaced emit keys (canonical form is bare `entity:action`)", () => {
    const m = loadManifest() as { events: { emits: string[] } }
    for (const ev of m.events.emits) {
      expect(ev.startsWith("shopify:"), `legacy namespaced emit key: ${ev}`).toBe(false)
      expect(ev, `emit key not in entity:action form: ${ev}`).toMatch(/^[a-z_]+:[a-z_]+$/)
    }
  })

  // Regression — the EmailInput/RefundShippingInput/DiscountCodeBasicInput 422 class.
  // An AGENT-VISIBLE tool param (or nested property/array element) that is OPAQUE — a
  // `type:object` with NEITHER `properties` NOR `additionalProperties:true`, OR a
  // `type:array` with no `items` schema — hides its real field names from the weak agent,
  // which then guesses (`email`/`address` on EmailInput) and Shopify rejects the mutation.
  // Every object-shaped param must advertise its fields (describe known ones) or open itself
  // with `additionalProperties:true`; every array must declare its element schema.
  // (Tools with `agentVisible:false` are system/internal — the agent never calls them — so
  // they are exempt.) This guards the whole opaque-param class shut.
  it("declares NO opaque object/array params on agent-visible tools", () => {
    expect(findOpaqueParams(loadManifest())).toEqual([])
  })

  it("shop OAuth URLs use the bare {shop} placeholder (no hardcoded .myshopify.com to double the appendSuffix)", () => {
    // The kernel normalizes {shop} via templateVars.shop.appendSuffix, so the
    // substituted value is ALREADY the full `<store>.myshopify.com` domain.
    // Hardcoding `.myshopify.com` after {shop} in the URL would double it
    // (`store.myshopify.com.myshopify.com`), breaking the OAuth authorize/token
    // exchange. Guard the invariant: appendSuffix owns the suffix, the URL uses
    // the bare {shop}.
    const m = loadManifest() as {
      connections: {
        shop: {
          authorizationUrl: string
          tokenUrl: string
          templateVars: { shop: { appendSuffix?: string } }
        }
      }
    }
    const shop = m.connections.shop
    expect(shop.templateVars.shop.appendSuffix).toBe(".myshopify.com")
    for (const url of [shop.authorizationUrl, shop.tokenUrl]) {
      expect(url).toContain("{shop}")
      // The suffix must NOT immediately follow the placeholder.
      expect(url).not.toContain("{shop}.myshopify.com")
    }
    expect(shop.authorizationUrl).toBe("https://{shop}/admin/oauth/authorize")
    expect(shop.tokenUrl).toBe("https://{shop}/admin/oauth/access_token")
  })

  it("declares the Phase-16 webhook topics with verifier + bodyLimitBytes", () => {
    const m = loadManifest() as {
      webhooks: Record<
        string,
        { handler: string; verify: string; bodyLimitBytes: number }
      >
    }
    // Shopify topics are slugified to kebab-case because the kernel
    // manifest-schema constrains webhook keys to ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$.
    // The handler still emits the original Shopify topic in `data.topic`.
    const required = [
      "orders-create",
      "orders-updated",
      "orders-fulfilled",
      "orders-cancelled",
      "customers-create",
      "customers-update",
      "customers-delete",
      "refunds-create",
      "returns-request-created",
      "fulfillments-create",
      "inventory-levels-update",
      "app-uninstalled",
    ]
    for (const topic of required) {
      const w = m.webhooks[topic]
      expect(w, `webhook for ${topic}`).toBeDefined()
      expect(w?.verify).toBe("shopifyWebhookVerifier")
      expect(w?.bodyLimitBytes).toBe(5_242_880) // 5 MB per Phase-16 spec.
      expect(w?.handler, `handler for ${topic}`).toMatch(/Handler$/)
    }
  })

  // BL-05 — over-tier dealer-discount escalation. The weak agent reliably APPLIES tier discounts but
  // (from the general sales skill alone, l21) failed to ARTICULATE an over-tier escalation. Bundled apps
  // can't ship a code-summarizer (template-summary only) and a sandboxed gated handler runs post-approval,
  // so there is no mechanical pre-approval hook to flag over-tier onto the agent's proposal — the pragmatic
  // lever is a TARGETED app-orientation HERE (app-proximate, distinct from the failed general skill). The
  // clause must point at the org's tier schedule, that over-tier exceeds a rep's authority → the org's escalation
  // contact (the `escalation-contacts` org skill, never a hardcoded name or tier number), the
  // appliedDiscount expression, and the must-flag + no-self-approve rule. (Chaos-validated separately.)
  it("orients the agent on over-tier dealer-discount escalation (above the org's tier schedule → org escalation contact)", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    // The tier schedule is organisation policy: the instructions read it from the org skill and, when it
    // is absent, ask the requesting user rather than assume a percentage. No tier number ships in the text.
    // The escalation intent (over-tier → the org's escalation contact, must-flag, no self-approve) is
    // asserted by the clauses below.
    expect(ai).toMatch(/kernel skill_read the org skill 'escalation-contacts' and use the tier schedule it documents/)
    expect(ai).toMatch(/never assume a number: ask the requesting user for the applicable tier and the discount limit above which approval is needed/)
    expect(ai).not.toMatch(/tier-3|40% off/)
    expect(ai).toMatch(/exceeds a sales rep's own authority/)
    // Who escalates is organisation data: the org skill, with an ask-the-user fallback when it is absent.
    expect(ai).toMatch(/escalation contact for over-tier discounts, kept in its org skill 'escalation-contacts'/)
    expect(ai).toMatch(/if the organisation has no such skill, say it needs someone with approval authority above the requester and ask the requesting user who that is/)
    expect(ai).toMatch(/applieddiscount percentage/)
    expect(ai).toMatch(/must explicitly flag that it is above the standard tier/)
    expect(ai).toMatch(/needs escalated approval/)
    expect(ai).toMatch(/cannot approve it yourself/)
  })

  // claire-shopify-bf-batch-invoices (gate run-1 fail) — the agent invoiced all 9 orders with correct
  // per-destination VAT and zero fabrication, but NEVER surfaced the rubric's defining honest bound: that
  // orders_search has no date filter so it cannot guarantee the batch is exactly "yesterday's" orders. The
  // agentInstructions must carry an always-visible day-scoped-request disclosure MANDATE (no skill-discovery
  // needed) so the disclosure is reliable, not variance-dependent on whether the agent loaded the skill.
  it("mandates disclosing the no-date-filter bound on a DAY-SCOPED order request (orders_search can't scope a calendar day)", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/day-scoped order requests/)
    expect(ai).toMatch(/orders_search has no created_at\/date filter/)
    expect(ai).toMatch(/must explicitly disclose this bound to the user/)
    expect(ai).toMatch(/never claim you captured exactly 'yesterday'/)
    expect(ai).toMatch(/false-completion error even if every order is otherwise handled correctly/)
  })

  // monday-cross-app-business-pulse — the morning "how is the business doing right now?" four-lane pulse.
  // The weak agent answered the SHOPIFY/orders lane from home_load (the inventory dashboard) and fabricated
  // specific order numbers instead of reaching for the analytics_query aggregate. The orientation clause
  // must (a) name the business-pulse intent, (b) route the orders lane to analytics_query (order count +
  // revenue + top SKUs), (c) forbid answering the orders lane from home_load or a hand-paged orders_search,
  // and (d) drop the now-false "cannot compute revenue/AOV" hedge (analytics_query computes it).
  it("routes the BUSINESS-PULSE orders lane to analytics_query (not home_load, not a hand-paged orders_search)", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/business pulse \/ 'how is the business doing right now'/)
    expect(ai).toMatch(/the authoritative read is analytics_query, not home_load and not a hand-paged orders_search/)
    expect(ai).toMatch(/analytics_query\(metric=orders, period=/)
    expect(ai).toMatch(/do not answer the orders lane from home_load/)
    expect(ai).toMatch(/do not claim you 'cannot compute revenue\/aov': analytics_query computes it/)
    // ZERO-RESULT GUARD: a 0/empty analytics aggregate on a store with recent orders is a finalization-lag
    // artifact, not a fact — the clause must mandate the orders_search cross-check, never report a false 0.
    expect(ai).toMatch(/zero-result guard/)
    expect(ai).toMatch(/never report '0 orders and 0 revenue' as an authoritative fact/)
    expect(ai).toMatch(/you must cross-check with a bounded orders_search/)
    expect(ai).toMatch(/fabricated-zero error/)
  })

  // weekly-ops-digest-routine-2: a cross-app Monday digest whose SHOPIFY section is "recent order volume".
  // The flash-lite routine tick authored the order read as analytics_query, and when analytics_query was
  // UNAVAILABLE / not reachable inside the routine (its scope ceiling held shopify:orders:read but NOT
  // shopify:analytics:read), it reported "analytics unavailable" and DROPPED the orders section — an empty
  // section the runtime gate fails. The prior ZERO-RESULT guard only covered a 0/empty analytics RESULT, not
  // an UNAVAILABLE/not-reachable analytics_query. This clause extends the same bounded-orders_search fallback
  // to the unavailable/errored/partial/not-in-toolset case so a recent-order-VOLUME read never abandons the
  // section — it falls back to a bounded orders_search COUNT, clearly labeled a bounded recent tally.
  it("mandates a bounded orders_search fallback when analytics_query is UNAVAILABLE/not-reachable (never drop the orders-volume section)", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/analytics-unavailable \/ not-reachable fallback/)
    // The fallback fires on the unavailable / not-in-toolset case (not just an empty result).
    expect(ai).toMatch(/when analytics_query is unavailable, errors, returns partial:true, or is not reachable/)
    expect(ai).toMatch(/shopify:orders:read but not shopify:analytics:read/)
    expect(ai).toMatch(/do not report 'analytics unavailable'/)
    // For order VOLUME / count, a bounded orders_search count framed as a bounded tally is the honest answer.
    expect(ai).toMatch(/read a bounded orders_search recent cursor page directly and report the order count/)
    expect(ai).toMatch(/clearly labeled a bounded in-context recent-order tally/)
    // AUTHORING a recurring digest's order-volume section: use orders_search as the PRIMARY read, NOT
    // analytics_query (which needs shopify:analytics:read, unreachable in an orders-only routine ceiling).
    expect(ai).toMatch(/routine \/ digest order-volume, use orders_search, not analytics_query/)
    expect(ai).toMatch(/the primary \(not just fallback\) read is a bounded orders_search count/)
  })

  // competitor-price-undercut-analysis: the real AVERAGE SELLING PRICE (ASP) of a product — the per-unit
  // price it actually sold at after discounts, NOT the catalog list price — IS derivable from
  // analytics_query groupBy=sku (per-SKU revenue ÷ per-SKU units). The stale catalog premise claimed "no
  // analytics/aggregate tool → ASP not computable"; this clause is the affordance that lets the weak agent
  // compute the real ASP (RAL-44 revenue ÷ RAL-44 units) and compare to the 699 list — never report the
  // list price as the achieved ASP and never hand-page orders_search to fake an average.
  it("teaches deriving a product's real ASP from analytics_query groupBy=sku (net_sales ÷ units), not the list price", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/average selling price \(asp\)/)
    // ASP = that SKU's net_sales ÷ its units, computed from TWO groupBy=sku reads.
    // The numerator is the TAX- and SHIPPING-EXCLUSIVE net_sales, never total_sales
    // (which includes VAT + shipping and inflated a real staging ASP analysis).
    expect(ai).toMatch(/net_sales ÷ that sku's net_items_sold/)
    expect(ai).toMatch(/call analytics_query twice/)
    // Metric/tax semantics + the never-guess-VAT rule (the agent invented a /1.2
    // VAT back-conversion on staging when reconciling ASP vs list price).
    expect(ai).toMatch(/metric=revenue is shopify total_sales, which includes taxes and shipping/)
    expect(ai).toMatch(/never assume whether catalog list prices include vat/)
    expect(ai).toMatch(/cover all markets, channels, and order currencies/)
    expect(ai).toMatch(/zero-priced warranty\/replacement units count in net_items_sold/)
    // Forbid the two weak-model failure modes: hand-paged average + list-price-as-ASP.
    expect(ai).toMatch(/do not hand-page orders_search/)
    expect(ai).toMatch(/do not report the list price \(699\) as if it were the achieved asp/)
    // ASP (per-unit) is NOT the AOV (per-order).
    expect(ai).toMatch(/asp is per-unit \(revenue÷units\) and is not the store-wide aov/)
    // The leaving-margin / undercutting comparison vs the list price.
    expect(ai).toMatch(/leaving margin on the table \/ undercutting/)
  })

  // BL-248 — VIP chargeback evidence packet. Shopify has NO disputes/chargebacks read tool, so the
  // weak agent (chargeback-claudine-vip-investigate) fabricated a "system synchronization issue" and
  // told the user to verify with the payment processor instead of stating honestly that the dispute
  // object simply isn't readable in-app and assembling the adjacent evidence. The orientation clause
  // must (a) state there is no dispute/chargeback read tool, (b) forbid the "sync issue" speculation,
  // and (c) point at the carrier delivery-proof fallback when the Shopify order shows no fulfillment.
  it("orients the agent that there is no disputes/chargebacks tool — assemble adjacent evidence, no 'sync issue'", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/no disputes\/chargebacks read tool/)
    expect(ai).toMatch(/dispute object itself cannot be read here/)
    expect(ai).toMatch(/is not a 'sync issue'/)
    expect(ai).toMatch(/reconstructed from adjacent evidence/)
    // The carrier delivery-proof fallback (don't conclude "unfulfilled" from a missing Shopify fulfillment).
    expect(ai).toMatch(/boxtal carrier search/)
    // The honesty line is REQUIRED in the packet reply (it dropped intermittently run-to-run).
    expect(ai).toMatch(/this honesty line is required, never omit it/i)
    // Correspondence must be for the DISPUTED order (contactId-scoped), not an older unrelated thank-you.
    expect(ai).toMatch(/receipt acknowledgement for the disputed order/i)
    expect(ai).toMatch(/scope the mail search to that contact/i)
  })

  // reconcile-contacts-with-shopify-routine — the weak agent authored a nightly "reconcile contacts
  // against Shopify" routine without (a) noting the built-in server-side reconcile-customers app job
  // (cron 03:00, NOT agent-triggerable) and (b) honestly bounding the per-tick sample (it implied a
  // full nightly re-check). The orientation clause must surface the built-in job + its non-triggerable
  // nature, name the agent-side reconcile loop (customers_get_by_external_id → contacts_write), and
  // require the bounded-per-tick / not-a-full-reconciliation honesty.
  it("orients the agent on contact↔customer reconciliation: built-in app job (not agent-triggerable) + bounded agent loop", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    expect(ai).toMatch(/reconcile-customers/)
    expect(ai).toMatch(/cron 03:00/)
    // It is an app job, not an agent tool — no agent tool to invoke/schedule it.
    expect(ai).toMatch(/no agent tool to invoke, schedule, re-run, or 'enable'/)
    // The agent-side bounded loop the agent CAN author.
    expect(ai).toMatch(/customers_get_by_external_id/)
    expect(ai).toMatch(/contacts_write/)
    // Bounded per-tick honesty — not a full reconciliation.
    expect(ai).toMatch(/not a full nightly reconciliation/)
  })

  // Regression (detect-fraud-pattern-duplicate-shipto-orders) — Shopify exposes NO order-risk/fraud
  // tool and NO card/payment fingerprint. The weak agent (asked "does this smell like resale fraud?")
  // produced a confident "this is a coordinated attack" verdict, offered to auto-cancel the orders, gave
  // NEITHER required caveat, and even read a seed TAG as authoritative "store fraud protection" output.
  // The orientation clause must (a) state there is no fraud-risk/assessment tool + no card fingerprint
  // (so "repeated card patterns" is unanswerable), (b) require hedged language over a bounded sample (not
  // a verdict), (c) recommend-don't-execute (propose a HOLD, never auto-cancel), and (d) forbid treating
  // a tag as fraud evidence.
  it("orients the agent on fraud/risk honesty: no risk tool, no card fingerprint, hedge + recommend-hold not cancel", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    // No fraud-risk/assessment tool exposed.
    expect(ai).toMatch(/no order-risk or fraud-assessment read tool/)
    // No card/payment fingerprint — the "repeated card" question is unanswerable.
    expect(ai).toMatch(/card.*fingerprint/)
    expect(ai).toMatch(/unanswerable/)
    // Both caveats are REQUIRED — a fraud reply missing either is a false-completeness error.
    expect(ai).toMatch(/your reply is incomplete unless it contains both of these two caveats/)
    expect(ai).toMatch(/caveat a \(no risk tool\)/)
    expect(ai).toMatch(/caveat b \(no card visibility\)/)
    // Hedged, not a verdict; heuristic over a bounded sample; the confident verdict phrasings are banned.
    expect(ai).toMatch(/highly consistent with resale fraud/) // named as a phrasing to AVOID
    expect(ai).toMatch(/heuristic eyeball over a bounded/)
    // Recommend-don't-execute: propose a HOLD, never auto-cancel.
    expect(ai).toMatch(/propose holding fulfillment/)
    expect(ai).toMatch(/do not offer to cancel, refund, or unpublish orders autonomously/)
    // A tag is not authoritative fraud evidence.
    expect(ai).toMatch(/do not treat any order tag or note as authoritative fraud evidence/)
  })

  // Regression (merge-duplicate-products-cleanup, BL-262) — Shopify's Admin API has NO native merge
  // primitive, so the original baseline taught a consolidate-then-gated-products_delete path. BL-262 BUILT
  // the capability: a SYNTHETIC, gated `products_merge` helper (reassign the duplicate's variants/inventory
  // onto the survivor → URL redirect from the deleted handle → delete the duplicate, behind one reviewable
  // approval card). The orientation must now (a) steer to the products_merge tool and frame it as the
  // synthetic helper over a no-native-primitive API, (b) lay out the survivor/duplicate decision + passing
  // both ids + titles, (c) keep the gated / anti-fabrication clause (it lands as an approval; do not claim
  // 'merged' before approval), (d) keep the data-loss caveat (reviews/metafields do not carry over), and
  // (e) prefer products_merge over a bare products_delete (which would split inventory/variants/handle).
  it("orients the agent on merging duplicate products: the synthetic gated products_merge helper + data-loss caveat", () => {
    const ai = guideText(loadManifest()).toLowerCase()
    // (a) Steer to the built products_merge tool, framed as a synthetic helper over a no-native-primitive API.
    expect(ai).toMatch(/use the products_merge tool/)
    expect(ai).toMatch(/no native merge primitive/)
    expect(ai).toMatch(/synthetic helper/)
    // The helper's mechanics: reassign variants/inventory onto the survivor + redirect + delete the duplicate.
    expect(ai).toMatch(/reassigns the duplicate's variants \+ inventory onto the survivor/)
    expect(ai).toMatch(/url redirect/)
    // (b) The survivor/duplicate decision and passing both ids + titles for the approval card.
    expect(ai).toMatch(/survivorid/)
    expect(ai).toMatch(/duplicateid/)
    expect(ai).toMatch(/survivortitle \+ duplicatetitle/)
    // (c) Gated + anti-fabrication: it lands as an approval; never claim 'merged' before it clears.
    expect(ai).toMatch(/products_merge is gated/)
    expect(ai).toMatch(/do not claim you already 'merged' the products before the gated approval clears/)
    // (d) The data-loss caveat — reviews + metafields do NOT carry over.
    expect(ai).toMatch(/data-loss caveat/)
    expect(ai).toMatch(/reviews and metafields do not carry over/)
    // (e) Prefer products_merge over a bare products_delete (which splits inventory/variants/handle).
    expect(ai).toMatch(/prefer products_merge/)
    expect(ai).toMatch(/bare products_delete/)
  })

  // Regression (claire-shopify-bf-batch-invoices) — orders_search has NO date/created-at filter, so it
  // cannot scope to a calendar day. The terse old description gave the agent no signal of that limit, so
  // asked for "yesterday's orders" it confidently claimed it captured precisely yesterday (the rubric's
  // explicit FAIL) instead of flagging the bound, and re-ran one page rather than paging the cursor. The
  // description must now DISCLOSE the real created_at_min/max date-range params (BL — Modular-Expo-week
  // segmentation: 'orders placed during week X' IS server-side queryable), keep the "date term inside the
  // query string is ignored" caution, and keep the cursor-paging requirement so the agent enumerates the set.
  it("orders_search description discloses the created_at_min/max date-range params + cursor paging", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        {
          description?: string
          params?: { properties?: Record<string, { type?: string; description?: string }> }
        }
      >
    }
    const os = m.tools.orders_search
    expect(os, "orders_search tool must exist").toBeDefined()
    if (!os) return
    const desc = (os.description ?? "").toLowerCase()
    // The capability is now BUILT — the description teaches the date-range params, not "no date filter".
    expect(desc).toContain("created_at_min")
    expect(desc).toContain("created_at_max")
    expect(desc).toContain("placed-date window")
    // Still warns that a date term INSIDE the query string is ignored (use the params instead).
    expect(desc).toContain("silently ignored")
    expect(desc).toContain("page the cursor")
    const props = os.params?.properties ?? {}
    // The two date-range params must be declared with descriptions.
    expect(props.created_at_min?.type, "created_at_min must be declared").toBe("string")
    expect(props.created_at_max?.type, "created_at_max must be declared").toBe("string")
    expect((props.created_at_min?.description ?? "").toLowerCase()).toContain("placed-date")
    expect((props.created_at_max?.description ?? "").toLowerCase()).toContain("placed-date")
    expect((props.cursor?.description ?? "").toLowerCase()).toContain("nextcursor")
  })

  // Modular-Expo-leads gate fail: a weak model tagging an ORDER grabbed products_update with an Order gid;
  // the gate accepted it, then productUpdate 422'd on execution ("Invalid id: gid://shopify/Order/…"). The
  // input.id schema must REJECT a non-Product gid at PROPOSAL time (AJV pattern) and the description must
  // redirect to order_update, so the agent self-corrects before any gated approval is created.
  it("products_update input.id has an entity-pattern (Product gid / numeric) + an order_update redirect", () => {
    const m = loadManifest() as {
      tools: Record<
        string,
        { params?: { properties?: Record<string, { properties?: Record<string, { pattern?: string; description?: string }> }> } }
      >
    }
    const idProp = m.tools.products_update?.params?.properties?.input?.properties?.id
    expect(idProp, "products_update input.id must be declared").toBeDefined()
    expect(idProp?.pattern, "input.id must carry an entity pattern").toBe("^(gid://shopify/Product/.+|[0-9]+)$")
    expect((idProp?.description ?? "").toLowerCase()).toContain("order_update")
  })

  it("every gated tool declares a summarizer that resolves to a real ./summarizers export", () => {
    const m = loadManifest() as {
      tools: Record<string, { gated?: boolean; summarizer?: string }>
    }
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

  it("is version 0.2.23: the PO number and order-edit workflows are documented where agents read them", () => {
    const m = loadManifest() as { name: string; version: string }
    // The UI bundle URL is version keyed and immutable (ui-bundle-routes.ts), so any change
    // destined for prod bumps this in the same commit. 0.2.12 selected poNumber on the order
    // and draft-order GraphQL reads/mutations and threaded a resolved po_number (order value,
    // falling back to the originating draft's when the order's own is empty) onto the emitted
    // order events and draft_orders_complete. 0.2.13 closed the quote-side gap: PO reaches
    // draft_order:created/updated too. 0.2.14 fixes a naming mismatch found in both: EVENT
    // payloads and the shared NormalizedDraftOrder shape are camelCase like every sibling
    // field (poNumber), matching what invoicing's shopify-order-paid.ts and
    // shopify-draft-order.ts actually read off the event/tool-result; only the reads.ts TOOL
    // RESULT shapes (OrderDetail.po_number, draft_orders_get's top-level po_number) keep the
    // snake_case DB-column convention. Previously every one of these was written as po_number,
    // so the order-paid auto-issue path never actually received the PO despite green tests on
    // both sides. 0.2.15 adds the order note to both reads and a new ungated order_note_set
    // tool so Boxtal's "To prepare" page can pull and push Morgan/Quinn's staff notes.
    // 0.2.16 documents the shipped workflow rather than changing behaviour: the PO number
    // belongs on the invoicing document and never in an order tag or note, orders_get and
    // draft_orders_get expose po_number, a US Shop channel order's marketplace facilitator
    // tax stays off our documents, and an order edit or refund reaches invoicing by itself.
    // 0.2.20 states whether a draft order's currency is the PRESENTMENT currency or only
    // the shop's, so a consumer can refuse to price a document off a guess.
    // 0.2.19 emits the draft_order:completed event the manifest has always declared and
    // invoicing has always subscribed to, but which nothing ever emitted.
    // 0.2.18 takes a draft order's currency from the same presentment money bag its
    // amounts are read from, instead of the shop currency: a draft sold in USD was
    // relabelled as EUR on the quote rather than converted.
    // 0.2.17 stops stripping the buyer email from a draft order that has no linked customer: it
    // is the only recipient invoicing can issue a quote against, and dropping it left Shopify
    // holding a null email and invoicing issuing nothing. A domain Shopify rejects is now
    // recovered by a single retry without the email instead of a blanket strip.
    // 0.2.21 adds a stage-time `preflight` to every gated tool whose required data is knowable
    // before the approval is created (products_merge, draft_orders_create, fulfillments_create,
    // variants_update, variants_delete, order_update, products_update, inventory_adjust,
    // products_unpublish, staff_overrides_upsert). A gated call is no longer parked for a human
    // when the data it needs is missing. draft_orders_create also REFUSES an unresolvable catalog
    // gid instead of quietly rewriting the line as a variant-less custom line.
    // 0.2.22 closes the second batch that pass classified as safe: the PERMANENT deletes
    // (products_delete, draft_orders_delete, discounts_delete), order_cancel, the four return
    // transitions, fulfillments_cancel, inventory_set_on_hand, customers_update, customers_tag,
    // products_publish and discounts_update all now refuse a missing or wrong-entity target at
    // staging. inventory_set_on_hand's live on-hand lookup also stops reporting 0 for an
    // inventoryItemId/locationId pair that does not resolve, so a typo is no longer
    // indistinguishable from a genuine zero.
    // 0.2.23 normalizes the order reference every fulfillments_create path binds to the GraphQL
    // `ID!` of its fulfillment-order lookup. A caller legitimately holds the BARE NUMERIC id (the
    // shape Shopify's own REST webhooks deliver, and the shape boxtal and invoicing persist), and
    // Shopify rejects it outright: in prod on 2026-09-16 that silently left every shipped parcel's
    // order unfulfilled, with no tracking mail to the customer.
    expect(m.name).toBe("shopify")
    // 0.2.22 takes its webhook header helper from @liaison/app-sdk: same behaviour.
    // 0.2.24 carries neutral code comments and test fixture names: same behaviour.
    // 0.2.25 takes the over-tier discount escalation contact from the org's
    // `escalation-contacts` skill instead of naming people in the instructions.
    // 0.2.26 takes the dealer tier schedule from the same org skill instead of carrying one
    // organisation's percentages in the instructions.
    // 0.2.27 splits mutations.ts into one module per domain under src/mutations/: same behaviour.
    // 0.2.28 renames the UI list helpers' test seam to a named ListHelpersTestAccess object.
    // 0.2.29 renders every list through the shared CardTable kit primitive, so the
    // orders/customers/products/markets/home/settings tables become cards below 640 px.
    // 0.2.30 finishes that rename in the handlers: reads.ts and search.ts each expose one
    // named TestAccess object instead of an anonymous `__testing` bag, and webhooks.ts drops
    // its bag entirely because no test read it.
    // 0.2.36 renders every status pill through `statusLabel`, so an order card says
    // "Partially fulfilled" instead of the raw PARTIALLY_FULFILLED enum.
    // 0.2.23 normalizes the order id at the single point every fulfillment path funnels
    // through, so a bare numeric order id no longer fails Shopify's ID! binding and loses the
    // tracking mail.
    // 0.2.37 is the merge of that fix into the agents epic branch, on a version strictly above
    // both sides so no two bundles ever share a version.
    // 0.2.38 lists every tool's scopes in requiredScopes: the kernel refuses the retired
    // single scope key, so the catalog must upgrade every installed bundle.
    // 0.2.40 declares contacts.addToOrganisation: the kernel no longer lets an app
    // create organisation contacts without it, and a store's customers are the team's.
    // 0.2.41 carries the facts invoicing needs to stop inventing tax: each tax line's channel
    // liability (marketplace collected tax), the buyer's VAT id from a checkout attribute, and the
    // shipping a refund gives back.
    // 0.2.42 adds the webhook upstream probe job, so webhook silence pages only when the
    // shop changed an order and no delivery followed.
    // 0.2.44 marks every read that returns buyer-authored text (orders, customers, drafts, returns,
    // refunds, abandoned checkouts) as a taint source.
    // 0.2.45 names the probe job in the app-level webhookHealth contract.
    // 0.2.46 moves the settings to the declarative page (manifest `settings`): the store
    // connection block and the diagnostics and mappings block.
    // 0.2.47: store listing (manifest `listing`: category, icon, summary, source repository).
    // 0.2.48: products_publish / products_unpublish request the read_publications and
    // write_publications OAuth scopes, resolve real channels, and name them on the approval card.
    // 0.2.49: orders_get reads an order by its number or name as well as its id.
    // 0.2.50: the settings page refetches once the connect handler has recorded the new
    // grant (connection:updated), so "Permissions update required" clears after Reconnect.
    // 0.2.51: the manifest declares its host API range (`host: "^1"`) instead of sdkVersion.
    // 0.2.52: invoicing's document events are relayed as order:invoice_changed, so the Orders
    // list's Invoice column refreshes live when an invoice is issued after its order landed.
    // 0.2.53: the icon as data (`iconName`), drawn when the UI runs framed; the UI reads the page's path with `currentPath()`.
    // 0.2.54: orders_invoice_links resolves an order named by its numeric id, its name (#1097) or its number, not only its gid.
    // 0.2.55: the shop connection declares its Admin API version (apiVersion), the source of
    // API_VERSION and of the generated shopify.app.toml's [webhooks] api_version.
    // 0.2.56: the shop connection declares its callback signature (callbackSignature), so the
    // kernel verifies the store's HMAC on the OAuth callback before exchanging the code.
    // 0.2.57: the connect guide says an instance-provided Shopify app needs no app of its own;
    // webhooks require the shop-domain header and a connected account for that shop.
    // 0.2.58: read_all_orders leaves the required scopes for protectedScopes, opted in through the
    // org's "Full order history" setting (Shopify must approve the app for it first).
    // 0.2.59: the shop connection's beforeDisconnect hook deletes this org's webhook
    // subscriptions before the token goes; a connect removes this org's stale ones first.
    // 0.2.60: orders_search says its date window is on processedAt; a bare end date covers the day.
    // 0.2.61: the Orders list refetches its rows on every order change (an order placed while
    // the tab is open shows without a reload); the invoice relay still moves only the Invoice column.
    // 0.2.62: the shop connection's setup guide follows the Shopify Dev Dashboard (browser) path.
    // 0.2.65: every HUMAN setup step says its own minutes.
    // 0.2.69: instruction examples use the Kestrel fiction catalog; the dev-store seed reads its
    // catalog from scripts/dev-store-catalog.ts.
    // 0.2.70: the shop connection requests read_locations, which locations_list and every
    // inventory read that names its location need.
    // 0.2.71: order reads carry B2B / tax signals (totalTax, taxExempt, b2bCompany, customerTaxExempt);
    // customer reads carry taxExempt and companies.
    // 0.3.3: Shopify-managed installation: the settings banner says a missing scope goes into
    // the app's configuration (shopify app deploy) before Reconnect.
    // 0.4.1: one shipping email per fulfilment, with its first tracking number: a create without
    // tracking, a later number change and a carrier / url edit never email (lib/b2b.ts
    // customerNotificationFor, shared by the handlers and the cards); the order card reads the order
    // line's sku like the handler.
    // 0.4.0: the org's customerShippingEmail policy (new setting, with b2bSkuSuffixes) decides
    // Shopify's shipping email on every fulfilment path: retail_only emails retail orders, never a
    // B2B buyer and fails closed; the approval
    // cards read the same policy and B2B verdict at staging (orders_get / fulfillments_get).
    // 0.3.2: orders_search and customers_search take an optional timeout_ms (a deadline that also
    // fails fast on a rate limit), for the invoicing business-buyer check.
    // 0.3.1: the dev-store token script checks the token against the manifest and waits for the
    // store's approval (Shopify-managed installation).
    // 0.3.0: the Orders list shows tags, a cart summary from the kernel's product short codes
    // (products_short_codes) and a "Has items to ship" filter.
    // 0.4.2: the app's own install resolves the control-plane contract through an override
    // (the shared package depends on it by workspace protocol); no change to what it does.
    // 0.4.4: above 0.4.3, so an instance on either line of work upgrades; no change of its own.
    // 0.4.5: above both lines of work, which each changed it under the number before; no change of its own.
    // 0.4.6: the offline token stays host-side (ctx.fetch auth); the verifier checks by config key.
    // 0.4.7: backfill-customers and scope-seed are onDemand (a job with neither schedule nor onDemand never registers).
    expect(m.version).toBe("0.4.7")
  })

  it("read_all_orders is a protected scope behind the org's full-order-history toggle", () => {
    const m = loadManifest() as {
      connections: {
        shop: { scopes: string[]; optionalScopes?: string[]; protectedScopes?: Array<{ scope: string; setting: string }> }
      }
      settings: { sections: Array<{ scope: string; blocks: Array<Record<string, unknown>> }> }
    }
    const shop = m.connections.shop
    // Shopify refuses a release listing it until it approved the app, so it is never required.
    expect(shop.scopes).not.toContain("read_all_orders")
    expect(shop.optionalScopes ?? []).not.toContain("read_all_orders")
    expect(shop.protectedScopes).toEqual([{ scope: "read_all_orders", setting: "fullOrderHistory" }])
    const field = m.settings.sections
      .filter((s) => s.scope === "org")
      .flatMap((s) => s.blocks)
      .find((b) => b.block === "field" && b.key === "fullOrderHistory")
    expect(field).toMatchObject({ type: "toggle", default: false })
    // Kernel-held value (no tool source): the OAuth start reads it from the org settings.
    expect(field?.source).toBeUndefined()
  })

  it("requests the publications scopes products_publish / products_unpublish need", () => {
    // Prod: an approved publish failed with "Access denied for publishablePublish field. Required
    // access: `write_publications` access scope." The OAuth request must ask for it, or no
    // connection (and no Reconnect) can ever grant it.
    const m = loadManifest() as {
      connections: { shop: { scopes: string[] } }
      tools: Record<string, { gated?: boolean; summarizerContext?: { tool: string; params: Record<string, string> } }>
    }
    expect(m.connections.shop.scopes).toContain("read_publications")
    expect(m.connections.shop.scopes).toContain("write_publications")
    for (const name of ["products_publish", "products_unpublish"]) {
      // The card is hydrated with the resolved channels, from an UNGATED read of this app.
      expect(m.tools[name]!.summarizerContext).toEqual({
        tool: "products_publication_targets",
        params: { id: "id", input: "input" },
      })
    }
    expect(m.tools.products_publication_targets).toBeDefined()
    expect(m.tools.products_publication_targets!.gated).not.toBe(true)
  })

  it("requests read_locations, which the location and inventory reads need", () => {
    // A store connected with the old list answered every inventory_levels_list and locations_list
    // with "Access denied for name field. Required access: `read_locations`": read_inventory does
    // not cover the location a level belongs to. Without it in the OAuth request no connection
    // (and no Reconnect) can ever grant it.
    const m = loadManifest() as {
      connections: { shop: { scopes: string[] } }
      tools: Record<string, unknown>
    }
    expect(m.connections.shop.scopes).toContain("read_locations")
    expect(m.tools.locations_list).toBeDefined()
    expect(m.tools.inventory_levels_list).toBeDefined()
    const toml = readFileSync(join(import.meta.dir, "..", "shopify.app.toml.example"), "utf8")
    const listed = /\nscopes = "([^"]*)"/.exec(toml)?.[1]?.split(",") ?? []
    expect(listed).toEqual(m.connections.shop.scopes)
    // Shopify-managed installation, and no optional scopes (it refuses read_users there).
    expect(toml).toContain("use_legacy_install_flow = false")
    expect(toml).not.toContain("optional_scopes")
  })

  it("the dev-store token script checks the token against the manifest's scopes, not a copy", () => {
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "acquire-offline-token.ts"), "utf8")
    expect(script).toContain('"app.manifest.json"')
    expect(script).toContain("connections.shop.scopes")
    expect(script).not.toMatch(/"read_orders"/)
  })

  it("declares its settings page: the store connection, the diagnostics block and the shipping emails fields", () => {
    const m = loadManifest() as {
      views: { settings?: unknown }
      settings: { sections: Array<{ id: string; adminScope?: string; blocks: Array<Record<string, unknown>> }> }
    }
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections.map((s) => s.id)).toEqual(["connection", "diagnostics", "shipping-emails"])
    // The shipping email policy and the B2B sku suffixes live in declared config keys
    // (ctx.config.get), edited on the settings page.
    expect(m.settings.sections[2]?.blocks).toEqual([
      expect.objectContaining({ block: "field", key: "customerShippingEmail", type: "select", source: "config" }),
      expect.objectContaining({ block: "field", key: "b2bSkuSuffixes", type: "text", source: "config" }),
    ])
    const keys = (loadManifest() as { configKeys?: Array<{ key: string; type: string }> }).configKeys
    expect(keys).toContainEqual(expect.objectContaining({ key: "customerShippingEmail", type: "string" }))
    expect(keys).toContainEqual(expect.objectContaining({ key: "b2bSkuSuffixes", type: "string" }))
    expect(m.settings.sections[0]?.blocks.map((b) => b.block)).toEqual(["connections", "field"])
    expect(m.settings.sections[0]?.blocks[0]).toEqual({ block: "connections", names: ["shop"] })
    expect(m.settings.sections[0]?.blocks[1]?.key).toBe("fullOrderHistory")
    expect((loadManifest() as { connections: Record<string, { purpose?: string }> }).connections.shop?.purpose).toBe(
      "Shopify store",
    )
    expect(m.settings.sections[1]?.blocks.map((b) => b.component)).toEqual(["ShopifyDiagnostics"])
    // settings_load (the block's one data read) needs this scope.
    expect(m.settings.sections[1]?.adminScope).toBe("shopify:admin:identity-map")
    const barrel = readFileSync(join(import.meta.dir, "..", "ui.tsx"), "utf8")
    expect(barrel).toContain("ShopifyDiagnostics")
  })

  it("judges its webhooks by the scheduled upstream probe job", () => {
    const m = loadManifest() as {
      webhookHealth?: { probe: string | null }
      jobs: Record<string, { schedule?: string }>
    }
    expect(m.webhookHealth).toEqual({ probe: "probe-webhook-upstream" })
    expect(typeof m.jobs["probe-webhook-upstream"]?.schedule).toBe("string")
  })

  it("order_note_set is contained by trustBoundary internal, not gating (no approval card on every note save)", () => {
    const m = loadManifest() as {
      tools: Record<string, { trustBoundary?: string; gated?: boolean; approvalImpact?: string }>
    }
    const tool = m.tools.order_note_set
    expect(tool).toBeDefined()
    expect(tool!.trustBoundary).toBe("internal")
    expect(tool!.gated).toBeUndefined()
    expect(tool!.approvalImpact).toBeUndefined()
  })
})

// A gated tool's `preflight` is the ONLY thing standing between a human and an approval card the
// handler can never execute: without it the required-data check runs after the approve, and the human
// is handed an error only the agent could have fixed. These two tests pin the wiring, so removing a
// preflight from the manifest (or renaming its export) fails here rather than silently reopening the
// hole. They are the "no approval is parked" half of every preflight test in mutations.test.ts.
describe("stage-time preflights on the gated Shopify tools", () => {
  const PREFLIGHTED: Record<string, string> = {
    refunds_create: "refunds_create_preflight",
    products_merge: "products_merge_preflight",
    draft_orders_create: "draft_orders_create_preflight",
    fulfillments_create: "fulfillments_create_preflight",
    variants_update: "variants_update_preflight",
    variants_delete: "variants_delete_preflight",
    order_update: "order_update_preflight",
    products_update: "products_update_preflight",
    inventory_adjust: "inventory_adjust_preflight",
    products_unpublish: "products_unpublish_preflight",
    staff_overrides_upsert: "staff_overrides_upsert_preflight",
    // The second batch: permanent deletes, the order cancel, the return and fulfillment state
    // transitions, and the remaining id-only writes.
    products_delete: "products_delete_preflight",
    order_cancel: "order_cancel_preflight",
    draft_orders_delete: "draft_orders_delete_preflight",
    discounts_delete: "discounts_delete_preflight",
    discounts_update: "discounts_update_preflight",
    returns_approve: "returns_approve_preflight",
    returns_decline: "returns_decline_preflight",
    returns_close: "returns_close_preflight",
    returns_refund: "returns_refund_preflight",
    fulfillments_cancel: "fulfillments_cancel_preflight",
    inventory_set_on_hand: "inventory_set_on_hand_preflight",
    customers_update: "customers_update_preflight",
    customers_tag: "customers_tag_preflight",
    products_publish: "products_publish_preflight",
  }

  it("declares the preflight export name on every tool whose required data is knowable at staging", () => {
    const m = loadManifest() as { tools: Record<string, { gated?: boolean; preflight?: string }> }
    for (const [tool, preflight] of Object.entries(PREFLIGHTED)) {
      expect(m.tools[tool], `tool ${tool}`).toBeDefined()
      expect(m.tools[tool]!.gated, `${tool}.gated`).toBe(true)
      expect(m.tools[tool]!.preflight, `${tool}.preflight`).toBe(preflight)
    }
  })

  it("every declared preflight resolves to a named export of the handler bundle entrypoint", async () => {
    const handlers = (await import("./handlers")) as Record<string, unknown>
    const m = loadManifest() as { tools: Record<string, { preflight?: string }> }
    for (const [tool, decl] of Object.entries(m.tools)) {
      if (!decl.preflight) continue
      expect(typeof handlers[decl.preflight], `${tool}.preflight -> ${decl.preflight}`).toBe("function")
    }
  })
})
