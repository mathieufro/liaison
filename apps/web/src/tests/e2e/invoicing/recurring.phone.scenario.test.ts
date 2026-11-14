// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recurring invoicing on a phone (390 by 844): the schedules list, the schedule editor and an
// issued run fit the width with nothing scrolling sideways, and every button and link is at least
// 44 px tall.
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { expectNoSidewaysScroll, expectTapSize, installRecurringMocks } from "./_recurring-mocks"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

test.describe("Invoicing: recurring screens at phone width", () => {
  test.setTimeout(120_000)

  test("the list, editor and run detail have no horizontal scroll and no small control", async ({
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
    await loginAs(page, env, qa.admin.email, "12345678")
    const base = `http://localhost:${env.ports[1]}`
    expect(page.viewportSize()?.width).toBe(390)

    await page.goto(`${base}/invoicing/recurring`)
    await expect(page.getByTestId("recurring-list")).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId("schedule-00000000-0000-4000-8000-000000000000")).toBeVisible()
    await expectNoSidewaysScroll(page, "recurring-list")
    await expectTapSize(page, "recurring-list")

    await page.goto(`${base}/invoicing/schedule/new`)
    await expect(page.getByTestId("schedule-editor")).toBeVisible({ timeout: 20_000 })
    await expectNoSidewaysScroll(page, "schedule-editor")
    await expectTapSize(page, "schedule-editor")

    await page.goto(`${base}/invoicing/run/run-nov`)
    await expect(page.getByTestId("recurring-run-detail")).toBeVisible({ timeout: 20_000 })
    await expectNoSidewaysScroll(page, "recurring-run-detail")
    await expectTapSize(page, "recurring-run-detail")
  })
})
