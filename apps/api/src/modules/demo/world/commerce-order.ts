// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `commerce-order`: the commerce scenario's live event. A new order with a
// gift note arrives in the demo org's fixture store: it is placed in the
// store's overlay (so the orders list and every read show it, newest first)
// and delivered to the Shopify app's own `orders/create` webhook handler with
// the matching payload, which emits `shopify/order:created` exactly as a real
// delivery does (the invoicing app's auto-flow listens to it).
//
// Fixed content: the order is built from the store's own catalogue, for one
// fixed end customer in the EU (COMMERCE_WORLD_CUSTOMER_EMAIL), numbered after
// the fixtures' last order. Inside the EU the parcel needs no customs
// declaration, so its prepared shipment is bookable exactly as it is, which is
// what the scenario asks the agent to do. Once per run of
// the scenario (the order id, number and webhook id are stable per run): the
// first run's order is #COMMERCE_WORLD_ORDER_NUMBER, each later run (Start
// again) the next number, so the order event fires again for a new order.
//
// The overlay is in-process: another process (an api replica serving the
// orders list) never saw the injection, and a restart loses it while its
// once-mark stays `succeeded` (and never injects again). Every demo store read
// first restores it from the mark (`restoreCommerceWorldOrder`), placed at the
// time the mark was claimed, for the run (generation) the mark belongs to.
import { SCENARIO_TOURS } from "@liaison/shared"
import { and, eq, gt, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { demoWorldMarks } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { isVisitorDemoOrgId } from "~/modules/demo/demo-org"
import {
  DEMO_ORDER_COUNT,
  type DemoOrder,
  demoShopifyBook,
  money,
} from "~/modules/demo/shopify/fixtures"
import { addWorldOrder, worldOrdersFor } from "~/modules/demo/shopify/overlay"
import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify/sentinel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { executeManifestWebhook } from "~/modules/webhooks/manifest-execution"
import { resolveHandlerScopes } from "~/modules/webhooks/verification"
import { worldId, worldRunKey } from "~/seed/world/people"

const log = rootLogger.child({ module: "demo-world" })

export const COMMERCE_ORDER_INJECTOR_ID = "commerce-order"

/** The order's number: the one after the fixture store's newest order. */
export const COMMERCE_WORLD_ORDER_NUMBER = 1000 + DEMO_ORDER_COUNT + 1
export const COMMERCE_WORLD_ORDER_NAME = `#${COMMERCE_WORLD_ORDER_NUMBER}`
export const COMMERCE_WORLD_GIFT_NOTE =
  "It's a gift for my father's 70th birthday: please leave the price off the packing slip " +
  'and add a card saying "Happy birthday, Dad. Love, Helena".'

/**
 * Who places the order: an end customer of the store in Germany. A person (the
 * gift note is hers), shipped inside the EU (no customs paperwork). Fixed, so
 * the order is the same on every day and every box, never whichever customer
 * the fixtures' newest order happens to have.
 */
export const COMMERCE_WORLD_CUSTOMER_EMAIL = "helena.ritter@nordlicht.example"

const NUMERIC_ID = 6_100_000 + DEMO_ORDER_COUNT + 1

/** The world order's Shopify id in run `run` of the scenario. */
function worldOrderId(run: number): string {
  return `gid://shopify/Order/${NUMERIC_ID + run}`
}

/** The order as the fixture store lists it, in run `run` of the scenario (0 = the first). */
export function worldOrder(now: Date = new Date(), run = 0): DemoOrder {
  const book = demoShopifyBook(now.getTime())
  const template = book.orders.find((o) => o.customerId && o.lineItems.length > 0)
  if (!template) throw new Error("demo world: the fixture store has no order to model")
  const customer = book.customers.find((c) => c.email === COMMERCE_WORLD_CUSTOMER_EMAIL)
  if (!customer) throw new Error("demo world: the fixture store has no customer for the order")
  const numericId = NUMERIC_ID + run
  const id = worldOrderId(run)
  const line = template.lineItems[0]
  if (!line) throw new Error("demo world: the fixture order has no line")
  const lineItems = [{ ...line, id: `gid://shopify/LineItem/${numericId}01`, quantity: 1 }]
  const subtotalMinor = line.unitMinor
  const at = now.toISOString()
  return {
    ...template,
    id,
    numericId,
    name: `#${COMMERCE_WORLD_ORDER_NUMBER + run}`,
    email: customer.email,
    customerId: customer.id,
    shippingAddress: { ...customer.address, name: customer.displayName, company: null },
    createdAt: at,
    processedAt: at,
    tags: [],
    note: COMMERCE_WORLD_GIFT_NOTE,
    financialStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    cancelReason: null,
    closed: false,
    lineItems,
    shippingTitle: "Free shipping",
    shippingMinor: 0,
    subtotalMinor,
    totalMinor: subtotalMinor,
    fulfillments: [],
    refunds: [],
    returns: [],
  }
}

function numericOf(gid: string): string {
  return gid.match(/(\d+)\s*$/)?.[1] ?? gid
}

/** The `orders/create` webhook body Shopify would send for `order` (REST shape). */
export function worldOrderPayload(order: DemoOrder): Record<string, unknown> {
  const book = demoShopifyBook(Date.parse(order.createdAt))
  const customer = book.customersById.get(order.customerId)
  const address = (a: DemoOrder["shippingAddress"]) => ({
    name: a.name,
    company: a.company,
    address1: a.address1,
    address2: a.address2,
    city: a.city,
    province: a.province,
    zip: a.zip,
    country_code: a.countryCode,
    phone: a.phone,
  })
  return {
    id: order.numericId,
    name: order.name,
    order_number: Number(order.name.replace(/^#/, "")),
    email: order.email,
    note: order.note,
    created_at: order.createdAt,
    currency: "EUR",
    presentment_currency: "EUR",
    total_price: money(order.totalMinor),
    subtotal_price: money(order.subtotalMinor),
    taxes_included: true,
    financial_status: "paid",
    fulfillment_status: null,
    tags: order.tags.join(", "),
    shipping_address: address(order.shippingAddress),
    billing_address: address(order.shippingAddress),
    customer: customer
      ? {
          id: customer.numericId,
          email: customer.email,
          first_name: customer.firstName ?? undefined,
          last_name: customer.lastName ?? undefined,
          default_address: address(customer.address),
        }
      : null,
    line_items: order.lineItems.map((li) => ({
      id: Number(numericOf(li.id)),
      variant_id: Number(numericOf(li.variantId)),
      product_id: Number(numericOf(li.productId)),
      title: li.title,
      sku: li.sku,
      quantity: li.quantity,
      price: money(li.unitMinor),
      requires_shipping: true,
      tax_lines: [],
    })),
    shipping_lines: [],
  }
}

/** Deliver the payload to the Shopify app's own orders/create handler for this org. */
async function deliverOrdersCreate(orgId: string, payload: unknown, webhookId: string) {
  // Reached from a durable consumer or the replica, not a request: set the org
  // up in this process first (boot registers no org).
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
  const registration = webhookHandlers.get([orgId, "shopify", "orders-create"])
  if (!registration || !isManifestHandler(registration.handler)) {
    throw new Error("demo world: the Shopify app's orders/create handler is not registered")
  }
  const handlerRef: ManifestHandlerRef = registration.handler
  const manifest = registration._manifest ?? {
    name: "shopify",
    schema: {},
    events: {},
    connections: {},
    network: {},
  }
  const scopes = resolveHandlerScopes("shopify", [], { thirdParty: false, grantedScopes: [] })
  const headers = {
    "x-shopify-webhook-id": webhookId,
    "x-shopify-shop-domain": DEMO_SHOP_DOMAIN,
    "x-shopify-topic": "orders/create",
  }
  const actor: ActorContext = { actorType: "system", orgId, purpose: "webhook", scopes }
  return withRlsContext(
    actor,
    async (tx) => {
      const bridge = createRpcBridge(
        "shopify",
        "system",
        orgId,
        tx,
        manifest,
        scopes,
        "system",
        undefined,
        {
          actor,
        },
      )
      return executeManifestWebhook({
        appName: "shopify",
        orgId,
        holdsTx: true,
        handlerRef,
        bundleSource: await loadBundle(handlerRef.bundlePath),
        params: payload,
        bridge,
        extraArgs: [headers],
      })
    },
    { pool: "jobs" },
  )
}

/** The scenario beat that injects the order: its once-mark says whether it ran. */
function worldOrderBeat(): { tourId: string; beatId: string } | null {
  for (const tour of SCENARIO_TOURS) {
    for (const beat of tour.beats) {
      if (beat.kind === "world" && beat.injector === COMMERCE_ORDER_INJECTOR_ID) {
        return { tourId: tour.id, beatId: beat.id }
      }
    }
  }
  return null
}

/** Each org's restore in flight: concurrent reads of one store share one mark read. */
const restoring = new Map<string, Promise<void>>()

/**
 * Put the world order into this process's store overlay when its beat has
 * claimed or settled the mark. A no-op when the order is there. Never throws.
 *
 * The overlay is per process and the injection runs on one process only (the
 * worker that consumed the beat), while the orders list is read through any
 * api replica. So every demo store read asks the mark, on every process, and
 * never trusts an earlier miss: a miss cached for a while (it used to be a
 * minute) hid the order from the list's refetch that the order's own event
 * triggers a second later, and the tour waited on a row that never came. A
 * claimed mark counts: the claim commits before the order is placed and its
 * event fires, so the refetch that event triggers must already see it. A
 * released claim (its `claimed_at` set to the epoch) does not.
 */
export function restoreCommerceWorldOrder(orgId: string): Promise<void> {
  const inFlight = restoring.get(orgId)
  if (inFlight) return inFlight
  const run = restoreOnce(orgId).finally(() => {
    if (restoring.get(orgId) === run) restoring.delete(orgId)
  })
  restoring.set(orgId, run)
  return run
}

async function restoreOnce(orgId: string): Promise<void> {
  try {
    const beat = worldOrderBeat()
    if (!beat) return
    const [mark] = await withPrivilegedDb(orgId, "demo-world-order-restore", (tx) =>
      tx
        .select({ claimedAt: demoWorldMarks.claimedAt, generation: demoWorldMarks.generation })
        .from(demoWorldMarks)
        .where(
          and(
            eq(demoWorldMarks.orgId, orgId),
            eq(demoWorldMarks.tourId, beat.tourId),
            eq(demoWorldMarks.beatId, beat.beatId),
            or(
              eq(demoWorldMarks.state, "succeeded"),
              and(eq(demoWorldMarks.state, "claimed"), gt(demoWorldMarks.claimedAt, new Date(0))),
            ),
          ),
        )
        .limit(1),
    )
    if (!mark) return
    if (worldOrdersFor(orgId).some((o) => o.id === worldOrderId(mark.generation))) return
    addWorldOrder(orgId, worldOrder(new Date(mark.claimedAt), mark.generation))
  } catch {
    // A read without the restored order is still a coherent store.
  }
}

/**
 * The live order's shipment, prepared as soon as its invoice is issued: the
 * shop's To-prepare list syncs that order's row (Boxtal's own `prep_sync`, on
 * the demo's in-process carrier), so its draft resolves and its carrier offers
 * are quoted before anyone asks. That is the state a shop's prep dashboard is
 * in once an operator has synced it, and what the scenario's request ("book it
 * from its row in the shipping prep list, as it is, with the cheapest offer") reads.
 *
 * Called by the demo world consumer with every durable event. Acts only on an
 * issued invoicing document in a visitor demo org that has a live order in its
 * store; idempotent (a fresh quote is not re-quoted). Never throws.
 */
export async function prepareCommerceWorldShipment(event: AppEvent): Promise<void> {
  try {
    if (event.app !== "invoicing" || event.entity !== "document" || event.action !== "issued") {
      return
    }
    const orgId = event.orgId
    if (!orgId) return
    // This process may not be the one that placed the order (or restarted since).
    await restoreCommerceWorldOrder(orgId)
    const orders = worldOrdersFor(orgId)
    if (orders.length === 0) return
    if (!(await isVisitorDemoOrgId(orgId))) return
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const result = await executeTool<{ rows?: Array<{ requoted?: boolean; error?: string }> }>({
      toolName: "boxtal:prep_sync",
      orgId,
      actor: {
        actorType: "system",
        orgId,
        purpose: "job",
        scopes: ["boxtal:*", "shopify:*", "invoicing:*"],
      },
      params: { order_keys: orders.map((o) => `so:${o.numericId}`) },
      origin: "system",
    })
    const failed = (result.data?.rows ?? []).filter((r) => r.error)
    if (failed.length > 0) {
      log.warn(
        { orgId, errors: failed.map((r) => r.error) },
        "demo world: the live order's shipment did not quote",
      )
    }
  } catch (err) {
    log.warn({ err, orgId: event.orgId }, "demo world: preparing the live order's shipment failed")
  }
}

/** Test seam: forget restores in flight. */
export const CommerceOrderTestAccess = {
  resetRestoreCache(): void {
    restoring.clear()
  },
}

export const commerceOrderInjector: WorldInjector = {
  id: COMMERCE_ORDER_INJECTOR_ID,
  // The order this run brought in, as its row in the shop's list names it: the
  // scenario's next step rings that row.
  async entityOf({ run }) {
    return worldOrderId(run)
  },
  async injectWorldEvent({ orgId, run }) {
    const order = worldOrder(new Date(), run)
    addWorldOrder(orgId, order)
    const result = await deliverOrdersCreate(
      orgId,
      worldOrderPayload(order),
      worldId(orgId, worldRunKey("commerce-order:webhook", run)),
    )
    const status =
      typeof result === "object" && result !== null && "status" in result
        ? (result as { status?: unknown }).status
        : 200
    if (typeof status === "number" && status >= 400) {
      throw new Error(`demo world: the orders/create handler answered ${status}`)
    }
  },
}
