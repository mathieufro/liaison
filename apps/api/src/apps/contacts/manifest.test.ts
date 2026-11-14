// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { exportContacts } from "~/apps/contacts/export"
import { contactsAppManifest } from "~/apps/contacts/manifest-descriptor"
import { validateAppManifest } from "~/modules/apps/contract"
import { CORE_EXPORT_HANDLERS } from "~/modules/apps/core/exports"
import contactsManifest from "./app.manifest.json"

describe("contacts manifest", () => {
  it("passes manifest validation", () => {
    expect(validateAppManifest(contactsManifest).success).toBe(true)
  })

  it("declares views.tabTypes for contact-list and contact-detail", () => {
    expect(contactsAppManifest.views.tabTypes["contact-list"].component).toBe("ContactList")
    expect(contactsAppManifest.views.tabTypes["contact-list"].singleton).toBe(true)
    expect(contactsAppManifest.views.tabTypes["contact-detail"].component).toBe("ContactDetail")
    expect(contactsAppManifest.views.tabTypes["contact-detail"].resolveLabel).toBe(
      "resolveContactTabLabel",
    )
  })

  it("is version 0.1.3 (the companies list and the company page)", () => {
    expect(contactsManifest.version).toBe("0.2.0")
  })

  it("declares the companies list and the company page, labelled by the company's name", () => {
    const tabs = contactsAppManifest.views.tabTypes as Record<string, Record<string, unknown>>
    expect(tabs["company-list"]).toMatchObject({
      component: "CompanyList",
      singleton: true,
      urlPattern: "/contacts/companies",
    })
    expect(tabs["company-detail"]).toMatchObject({
      component: "CompanyDetail",
      entity: "kernel:company",
      referenceable: true,
      resolveLabel: "resolveCompanyTabLabel",
      urlPattern: "/contacts/companies/:entityId",
    })
  })

  it("hosts the company page's slot, where other apps' panels sit as sections", () => {
    expect(contactsManifest.slots).toEqual({ company_detail: { position: "sections" } })
  })

  it("gives the contact-list page the groups sidebar, the contact page its picker", () => {
    expect(contactsAppManifest.views.tabTypes["contact-list"].sidebar).toBe("ContactListSidebar")
    expect(contactsAppManifest.views.tabTypes["contact-detail"].sidebar).toBe("ContactsSidebar")
  })

  it("declares views.activityBar with order 20", () => {
    expect(contactsAppManifest.views.activityBar.label).toBe("Contacts")
    expect(contactsAppManifest.views.activityBar.order).toBe(20)
  })

  it("declares wsHandlers for the contact and company entities", () => {
    expect(contactsAppManifest.views.wsHandlers).toMatchObject({
      contact: { key: "kernel:contact", handler: "handleContactEvent" },
      company: { key: "kernel:company", handler: "handleCompanyEvent" },
    })
  })

  it("declares no tools", () => {
    expect((contactsAppManifest as any).tools).toBeUndefined()
  })
})

describe("getDefaultApps", () => {
  it("includes the contacts manifest", async () => {
    const { getDefaultApps } = await import("~/modules/apps/init")
    const apps = await getDefaultApps()
    expect(apps.some((app) => app.name === "contacts")).toBe(true)
  })

  it("is server code: no handler bundle, its export is the app's own module", () => {
    expect("_bundlePath" in contactsAppManifest).toBe(false)
    expect(contactsManifest.export.handler).toBe("exportContacts")
    expect(CORE_EXPORT_HANDLERS.contacts).toBe(exportContacts)
  })
})
