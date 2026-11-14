// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The document's PDF tab, in a browser: the inline preview must load under the app's own CSP (the
// fixture fails any test that logs a CSP violation), and a browser with no PDF viewer says so.
import { api } from "@liaison/test-helpers"
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

function unwrap(body: unknown): Record<string, unknown> {
  const b = body as { data?: Record<string, unknown> }
  return b.data ?? (body as Record<string, unknown>)
}

test.describe("Invoicing: the document's PDF tab", () => {
  test("the inline preview loads under the CSP, and without a viewer the tab says so", async ({
    page,
    env,
    world,
    qa,
  }) => {
    const installed = await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Pdf Tab Customer",
          email: "pdf-tab@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    const contact = installed.additionalContactIds[0]
    const issued = await api(env.serverUrl, "/api/apps/invoicing/tools/invoice_create_and_issue", {
      method: "POST",
      token: qa.admin.token,
      body: {
        params: {
          counterparty: {
            contact_id: contact,
            legal_name: "Pdf Tab Customer",
            country: "FR",
            address: "1 rue de Test, 75011 Paris",
            email: "pdf-tab@e2e.test",
            customer_kind: "individual",
          },
          issuer_profile_id: installed.primaryIssuerProfileId,
          currency: "EUR",
          operation_category: "services",
          items: [
            {
              description: "Service",
              quantity: "1",
              unit_price_minor: "10000",
              line_kind: "software",
            },
          ],
        },
      },
    })
    expect(issued.status).toBe(200)
    const id = unwrap(issued.body).document_id as string

    await loginAs(page, env, qa.admin.email, "12345678")
    const viteUrl = `http://localhost:${env.ports[1]}`
    // The lane's headless browser reports no PDF viewer; a real one does. Claim one, so the frame
    // is made and the CSP decides on it.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "pdfViewerEnabled", { configurable: true, get: () => true })
    })
    const violations: string[] = []
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text())
    })
    // Every read is held back, as on a slow (cold, loaded) server: the document itself, then the
    // reads that start once it has drawn (header chips, regime line, e-invoice panel) and the PDF
    // preview. While the document loads, the detail says so (never a blank pane); once it has
    // drawn, the header and tab strip stay on screen and usable, never back on "Loading…", until
    // the other reads return.
    const held = new Map<string, Array<() => void>>()
    const released = new Set<string>()
    const releaseAll = (tool: string) => {
      released.add(tool)
      for (const r of held.get(tool) ?? []) r()
      held.delete(tool)
    }
    await page.route(
      /\/api\/apps\/invoicing\/tools\/(documents_get|einvoice_transmission_get|einvoicing_classify|documents_preview_pdf)$/,
      async (route) => {
        const tool = new URL(route.request().url()).pathname.split("/").pop() as string
        if (!released.has(tool)) {
          await new Promise<void>((resolve) => held.set(tool, [...(held.get(tool) ?? []), resolve]))
        }
        await route.continue().catch(() => {})
      },
    )
    const documentAsked = page.waitForRequest(/\/tools\/documents_get$/)
    await page.goto(`${viteUrl}/invoicing/document/${id}`)
    await documentAsked
    await expect(page.getByTestId("document-detail-loading")).toBeVisible()
    const documentRead = page.waitForResponse(/\/tools\/documents_get$/)
    releaseAll("documents_get")
    await documentRead
    await expect(page.getByTestId("document-detail-tabs")).toBeVisible()
    await expect(page.getByTestId("document-detail-loading")).toHaveCount(0)
    const previewAsked = page.waitForRequest(/\/tools\/documents_preview_pdf$/)
    await page.getByTestId("document-detail-tab-pdf").click()
    await previewAsked
    await expect(page.getByTestId("document-detail-pdf")).toBeVisible()
    await expect(page.getByTestId("document-detail-tabs")).toBeVisible()
    await expect(page.getByTestId("document-detail-loading")).toHaveCount(0)
    for (const tool of [
      "einvoice_transmission_get",
      "einvoicing_classify",
      "documents_preview_pdf",
    ]) {
      releaseAll(tool)
    }
    await page.unrouteAll({ behavior: "ignoreErrors" })
    const embed = page.getByTestId("document-detail-pdf-embed")
    await expect(embed).toBeVisible()
    await expect(embed).toHaveJSProperty("tagName", "IFRAME")
    await expect.poll(() => embed.getAttribute("src")).toMatch(/^blob:/)
    await page.waitForTimeout(500)
    expect(violations).toEqual([])

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "pdfViewerEnabled", { configurable: true, get: () => false })
    })
    await page.reload()
    await page.getByTestId("document-detail-tab-pdf").click()
    await expect(page.getByTestId("document-detail-pdf-unavailable")).toBeVisible()
    await expect(embed).toHaveCount(0)
  })
})
