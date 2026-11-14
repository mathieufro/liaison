// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run's panel inside its approval card on a phone (390 by 844): the count and total
// come first, a long run folds the rows with nothing to look at under one line that still counts
// in the total, a search by customer reaches any row, a row opens in place, nothing scrolls
// sideways and every control is at least 44 px tall.
import { loginAs } from "../fixtures/test"
import { expect, test } from "./_invoicing-fixtures"
import { draftMonthEndRun } from "./_month-end-run"
import { expectNoSidewaysScroll, expectTapSize } from "./_recurring-mocks"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

test.describe("Invoicing: the month-end panel on a phone", () => {
  test.setTimeout(180_000)

  test("a long run folds, searches and opens a row in place, with no sideways scroll and no small control", async ({
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
    const run = await draftMonthEndRun(env, {
      orgId: world.org.id,
      adminToken: qa.admin.token,
      accountManagerId: qa.admin.id,
      count: 24,
    })
    await loginAs(page, env, qa.admin.email, "12345678")
    expect(page.viewportSize()?.width).toBe(390)
    await page.goto(`http://localhost:${env.ports[1]}/approvals`)
    const card = page.getByTestId(`approvals-item-${run.approvalId}`)
    const panel = card.getByTestId("month-end-panel")
    await expect(panel).toBeVisible({ timeout: 30_000 })

    // The count and total lead; every row bills what the last invoice billed, so all fold.
    await expect(panel.getByTestId("month-end-approve-count")).toContainText(
      "24 invoices to approve",
      { timeout: 20_000 },
    )
    const folded = panel.getByTestId("month-end-folded")
    await expect(folded).toHaveText(/^24 same as /)
    const count = await panel.getByTestId("month-end-approve-count").boundingBox()
    const fold = await folded.boundingBox()
    expect(count && fold && count.y < fold.y).toBe(true)
    await expectNoSidewaysScroll(page, "month-end-panel")
    await expectTapSize(page, "month-end-panel")

    // Search by customer reaches a folded row.
    await panel.getByTestId("month-end-search").fill("Maison Client 17")
    const rows = panel.getByTestId("month-end-rows")
    const rowItems = rows.locator('[data-testid^="month-end-row-"][data-state]')
    await expect(rowItems).toHaveCount(1)
    await expect(rows).toContainText("Maison Client 17")

    // The row opens where it is: same address, the editor's fields inside the card.
    const url = page.url()
    await rows.locator('[data-testid^="month-end-row-open-"]').first().click()
    const editor = panel.locator('[data-testid^="month-end-row-editor-"]')
    await expect(editor).toBeVisible({ timeout: 20_000 })
    await expect(editor.getByTestId("editor-field-customer-name")).toBeVisible({ timeout: 20_000 })
    expect(page.url()).toBe(url)
    await expectNoSidewaysScroll(page, "month-end-panel")

    // Unfolded, every row is there and still nothing scrolls sideways.
    await panel.getByTestId("month-end-row-cancel").click()
    await panel.getByTestId("month-end-search").fill("")
    await folded.click()
    await expect(rowItems).toHaveCount(24)
    await expectNoSidewaysScroll(page, "month-end-panel")
    await expectTapSize(page, "month-end-rows")

    // The run's discussion opens (never "could not be opened"), and a message posted there shows.
    const discussion = panel.getByTestId("month-end-discussion")
    await expect(discussion.getByTestId("month-end-discussion.thread")).toBeVisible({
      timeout: 30_000,
    })
    await expect(discussion.getByTestId("month-end-discussion.unavailable")).toHaveCount(0)
    await discussion.getByTestId("month-end-discussion.thread.composer").click()
    await page.keyboard.type("Maison check before the run issues")
    await discussion.getByTestId("month-end-discussion.thread.send").click()
    await expect(discussion.getByTestId("month-end-discussion.thread.messages")).toContainText(
      "Maison check before the run issues",
      { timeout: 20_000 },
    )
  })
})
