// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe rail: Home, Customers and the dashboard link, a state dot, and the
// manifest wiring that keeps the rail away from an org that has not enabled the app.
import { afterEach, describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import * as bundle from "../../ui"
import { dotWord } from "./home-model"
import { dotTone, StripeSidebar, sidebarRows } from "./StripeSidebar"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

describe("the Stripe sidebar", () => {
  it("lists Home and Customers, then the dashboard as an external link", () => {
    const rows = sidebarRows("test")
    expect(rows.nav.map((r) => r.label)).toEqual(["Home", "Customers"])
    expect(rows.nav.map((r) => r.href)).toEqual(["/stripe", "/stripe/customers"])
    expect(rows.external.label).toBe("Stripe dashboard")
    expect(rows.external.href).toBe("https://dashboard.stripe.com/test")
    expect(sidebarRows("live").external.href).toBe("https://dashboard.stripe.com")
  })

  it("the state dot is calm: green when healthy, amber when something needs a person, grey otherwise", () => {
    expect(dotTone("home")).toBe("success")
    expect(dotTone("importing")).toBe("muted")
    expect(dotTone("not_connected")).toBe("muted")
    for (const k of ["revoked", "stalled", "partial", "other_account"] as const)
      expect(dotTone(k)).toBe("warning")
    // The dot is never colour alone: a word says the same.
    expect(dotWord("not_connected")).toBe("Not connected")
    expect(dotWord("home")).toBe("Connected")
    expect(dotWord("revoked")).toBe("Needs a look")
  })
})

describe("the app's views", () => {
  const views = (manifest as any).views
  it("declares an activity bar entry that opens Home, and the home tab type", () => {
    expect(views.activityBar.label).toBe("Stripe")
    expect(views.activityBar.tabAction).toMatchObject({ type: "home", entityId: "home" })
    expect(views.tabTypes.home).toMatchObject({
      component: "StripeHome",
      sidebar: "StripeSidebar",
      singleton: true,
      urlPattern: "/stripe",
    })
  })

  it("every component the manifest names is exported by the UI bundle", () => {
    const names = new Set<string>()
    for (const t of Object.values<any>(views.tabTypes)) {
      names.add(t.component)
      if (t.sidebar) names.add(t.sidebar)
    }
    names.add(views.activityBar.icon)
    for (const n of names) expect(typeof (bundle as Record<string, unknown>)[n], n).toBe("function")
    expect(typeof StripeSidebar).toBe("function")
  })

  it("the rail is the app's own entry, so an org without the app has no Stripe rail", () => {
    // The kernel builds the activity bar from the manifests of enabled apps only; the entry
    // has no always-on flag and the tab types list nothing outside this app.
    expect(JSON.stringify(views.activityBar)).not.toMatch(/always|pinned|forceShow/i)
    expect(
      Object.values<any>(views.tabTypes).every((t) => t.urlPattern.startsWith("/stripe")),
    ).toBe(true)
  })
})
