// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring invoicing at 1440 by 900: the schedules list with its computed first line, the
// schedule editor with its actions at the top and no number before issue, and an issued run with
// its number range and each invoice's e-invoice status.
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { expectNoSidewaysScroll, installRecurringMocks } from "./_recurring-mocks"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

test.describe("Invoicing: recurring screens", () => {
  test.setTimeout(120_000)

  test("the list, editor and run detail render at 1440 by 900 with no horizontal scroll", async ({
    page,
    env,
    world,
    qa,
  }) => {
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
    })
    await installRecurringMocks(page)
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAs(page, env, qa.admin.email, "12345678")
    const base = `http://localhost:${env.ports[1]}`

    await page.goto(`${base}/invoicing/recurring`)
    await expect(page.getByTestId("recurring-list")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("recurring-title-line")).toHaveText(
      "Soonest first. Next: 7 drafts on Fri 27 Nov, to issue on Mon 30 Nov.",
    )
    await expect(
      page.getByTestId("schedule-bills-00000000-0000-4000-8000-000000000001"),
    ).toHaveText("On-site training days")
    await page.getByTestId("recurring-filter-paused").click()
    await expect(page.getByTestId("schedule-00000000-0000-4000-8000-000000000009")).toBeVisible()
    await expect(page.getByTestId("schedule-00000000-0000-4000-8000-000000000001")).toHaveCount(0)
    await expectNoSidewaysScroll(page, "recurring-list")

    await page.getByTestId("new-schedule").click()
    await expect(page.getByTestId("schedule-editor")).toBeVisible({ timeout: 20_000 })
    // Actions at the top; Start waits for a customer and a line; no number before issue.
    await expect(page.getByTestId("schedule-save")).toBeDisabled()
    await expect(page.getByTestId("schedule-number-line")).toContainText(
      "Taken the moment it issues",
    )
    await expect(page.getByTestId("schedule-next")).not.toContainText("F-20")
    const header = await page.getByTestId("schedule-save").boundingBox()
    expect(header?.y ?? 999).toBeLessThan(200)
    await expectNoSidewaysScroll(page, "schedule-editor")

    await page.goto(`${base}/invoicing/run/run-nov`)
    await expect(page.getByTestId("recurring-run-detail")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("run-numbers")).toContainText("F-2026-0463 to F-2026-0465")
    await expect(page.getByTestId("run-no-gaps")).toBeVisible()
    await expect(page.getByTestId("run-einvoice-F-2026-0464")).toHaveText("Collected")
    await expect(page.getByTestId("run-einvoice-F-2026-0465")).toHaveText("Refused by the buyer")
    await expectNoSidewaysScroll(page, "recurring-run-detail")
  })
})
