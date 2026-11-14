// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 cluster-5 lifecycle fix — `teardownAppRegistrations` /
// `unregisterAppEverywhere` must remove every in-memory registry entry,
// external-search handler, and event subscription that registration populated,
// so a reinstall does not stack stale/duplicate handlers.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  appCapabilitiesRegistry,
  connectionConfigRegistry,
  declaredEmits,
  entityRegistry,
  eventSubscriptionDisposers,
  manifestAttentionRegistry,
  registeredApps,
  resetAppRegistries,
  setDeclaredEmits,
  slotRegistry,
  toolRegistry,
  viewRegistry,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { teardownAppRegistrations, unregisterAppEverywhere } from "~/modules/apps/runtime"
import {
  ExternalSearchHandlersTestAccess,
  fanoutExternal,
  registerExternalSearchHandler,
} from "~/modules/search/external-handlers"

const ORG_A = "00000000-0000-0000-0000-0000000000a1"
const ORG_B = "00000000-0000-0000-0000-0000000000b2"
const APP = "shopify"

function populate(orgId: string, appName: string) {
  registeredApps.add(`${orgId}:${appName}`)
  toolRegistry.set([orgId, appName, "orders_get"], {
    appName,
    name: "orders_get",
    description: "",
    requiredScopes: [`${appName}:orders:read`],
    handler: async () => ({}),
  })
  webhookHandlers.set([orgId, appName, "orders_create"], {
    handler: async () => {},
    verify: async () => ({ ok: true }) as never,
    appName,
    orgId,
  })
  entityRegistry.set([orgId, appName, "order"], {
    labelField: "name",
    handlePrefix: "o",
  })
  viewRegistry.set([orgId, appName], { detail: {} })
  slotRegistry.set([orgId, appName, "contact_detail"], { panels: [] })
  connectionConfigRegistry.set([orgId, appName, "shop"], {
    type: "oauth2",
    allowedDomains: ["*.myshopify.com"],
  })
  manifestAttentionRegistry.set([orgId, appName], [])
  appCapabilitiesRegistry.set([orgId, appName], [])
  setDeclaredEmits(orgId, appName, new Set(["order:created"]))
}

describe("teardownAppRegistrations", () => {
  beforeEach(() => {
    resetAppRegistries()
    ExternalSearchHandlersTestAccess.reset()
  })
  afterEach(() => {
    resetAppRegistries()
    ExternalSearchHandlersTestAccess.reset()
  })

  it("removes every registry entry registration populated for (org, app)", async () => {
    populate(ORG_A, APP)
    registerExternalSearchHandler(ORG_A, APP, async () => ({
      hits: [{ id: "x", app: APP, entity: "order", title: "X" }],
      nextCursor: null,
    }))

    await teardownAppRegistrations(ORG_A, APP)

    expect(registeredApps.has(`${ORG_A}:${APP}`)).toBe(false)
    expect(toolRegistry.get([ORG_A, APP, "orders_get"])).toBeUndefined()
    expect(webhookHandlers.get([ORG_A, APP, "orders_create"])).toBeUndefined()
    expect(entityRegistry.get([ORG_A, APP, "order"])).toBeUndefined()
    expect(viewRegistry.get([ORG_A, APP])).toBeUndefined()
    expect(slotRegistry.get([ORG_A, APP, "contact_detail"])).toBeUndefined()
    expect(connectionConfigRegistry.get([ORG_A, APP, "shop"])).toBeUndefined()
    expect(manifestAttentionRegistry.get([ORG_A, APP])).toBeUndefined()
    expect(appCapabilitiesRegistry.get([ORG_A, APP])).toBeUndefined()
    expect(declaredEmits.get(`${ORG_A}:${APP}`)).toBeUndefined()
    // External-search handler for this org is gone.
    const r = await fanoutExternal({ orgId: ORG_A, userId: "u", q: "x", filters: {} })
    expect(r.hits).toEqual([])
  })

  it("calls every event-subscription disposer registered for the app", async () => {
    let disposed = 0
    eventSubscriptionDisposers.set(
      [ORG_A, APP],
      [
        async () => {
          disposed++
        },
        async () => {
          disposed++
        },
      ],
    )
    await teardownAppRegistrations(ORG_A, APP)
    expect(disposed).toBe(2)
    expect(eventSubscriptionDisposers.get([ORG_A, APP])).toBeUndefined()
  })

  it("a registry reset disposes the event subscriptions it forgets", () => {
    let disposed = 0
    eventSubscriptionDisposers.set(
      [ORG_A, APP],
      [
        async () => {
          disposed++
        },
      ],
    )
    eventSubscriptionDisposers.set(
      [ORG_B, APP],
      [
        async () => {
          disposed++
        },
      ],
    )
    resetAppRegistries()
    expect(disposed).toBe(2)
    expect(eventSubscriptionDisposers.get([ORG_A, APP])).toBeUndefined()
  })

  it("is idempotent — a second teardown is a no-op", async () => {
    populate(ORG_A, APP)
    await teardownAppRegistrations(ORG_A, APP)
    await expect(teardownAppRegistrations(ORG_A, APP)).resolves.toBeUndefined()
  })
})

describe("unregisterAppEverywhere", () => {
  beforeEach(() => {
    resetAppRegistries()
    ExternalSearchHandlersTestAccess.reset()
  })
  afterEach(() => {
    resetAppRegistries()
    ExternalSearchHandlersTestAccess.reset()
  })

  it("tears the app down across every org it was registered in", async () => {
    populate(ORG_A, APP)
    populate(ORG_B, APP)
    registerExternalSearchHandler(ORG_A, APP, async () => ({ hits: [], nextCursor: null }))
    registerExternalSearchHandler(ORG_B, APP, async () => ({ hits: [], nextCursor: null }))

    await unregisterAppEverywhere(APP)

    expect(registeredApps.has(`${ORG_A}:${APP}`)).toBe(false)
    expect(registeredApps.has(`${ORG_B}:${APP}`)).toBe(false)
    expect(toolRegistry.get([ORG_A, APP, "orders_get"])).toBeUndefined()
    expect(toolRegistry.get([ORG_B, APP, "orders_get"])).toBeUndefined()
    const rA = await fanoutExternal({ orgId: ORG_A, userId: "u", q: "x", filters: {} })
    const rB = await fanoutExternal({ orgId: ORG_B, userId: "u", q: "x", filters: {} })
    expect(rA.hits).toEqual([])
    expect(rB.hits).toEqual([])
  })

  it("leaves a different app's registrations untouched", async () => {
    populate(ORG_A, APP)
    populate(ORG_A, "tickets")
    await unregisterAppEverywhere(APP)
    expect(toolRegistry.get([ORG_A, "tickets", "orders_get"])).toBeDefined()
    expect(registeredApps.has(`${ORG_A}:tickets`)).toBe(true)
  })
})
