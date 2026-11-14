// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two people on one month-end run, each in their own browser: one changes a row's price and saves
// it for this month; the other, who approves but does not edit, sees without reloading what
// changed, who changed it and both totals, and approves the run as it is now.

import { loginAs } from "../fixtures/test"
import { createApprovalActor } from "../helpers/approvals-seed"
import { ks } from "../helpers/db-reads"
import { expect, test } from "./_invoicing-fixtures"
import { draftMonthEndRun } from "./_month-end-run"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE } from "./helpers/invoicing-bundle"

test.describe("Invoicing: one month-end run in two browsers", () => {
  test.setTimeout(240_000)

  test("a change in one browser shows as changed in the other, which approves the new version", async ({
    page,
    browser,
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
    // The approver exists before the run is drafted, so the card's approvers include them.
    const approver = await createApprovalActor(world, {
      name: "Maison Approver",
      scopes: ["invoicing:documents:read", "invoicing:approve"],
    })
    const run = await draftMonthEndRun(env, {
      orgId: world.org.id,
      adminToken: qa.admin.token,
      accountManagerId: qa.admin.id,
      count: 3,
    })
    const base = `http://localhost:${env.ports[1]}`

    // The editor: the QA admin, who may edit and approve.
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`${base}/approvals`)
    const mine = page.getByTestId(`approvals-item-${run.approvalId}`).getByTestId("month-end-panel")
    await expect(mine.getByTestId("month-end-approve-count")).toContainText(
      "3 invoices to approve",
      { timeout: 30_000 },
    )

    // The approver, in a second browser.
    const other = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const theirs = await other.newPage()
    try {
      await loginAs(theirs, env, approver.email, approver.password)
      await theirs.goto(`${base}/approvals`)
      const panel = theirs
        .getByTestId(`approvals-item-${run.approvalId}`)
        .getByTestId("month-end-panel")
      await expect(panel.getByTestId("month-end-approve-count")).toContainText(
        "3 invoices to approve",
        { timeout: 30_000 },
      )
      // Approving without editing: the panel's own Approve N, and no row editing.
      await expect(panel.getByTestId("month-end-approve")).toBeVisible()
      await expect(panel.getByTestId("month-end-add")).toHaveCount(0)
      await expect(panel.getByTestId("month-end-changed")).toHaveCount(0)

      // The editor changes the first row's price from 490 to 650 and saves it for this month. Rows
      // of one run may list in any order, so the row is named by what it shows.
      const firstRow = mine.locator('[data-testid^="month-end-row-open-"]').first()
      const customer = (await firstRow.innerText()).match(/Maison Client \d+/)?.[0]
      expect(customer).toBeTruthy()
      await firstRow.click()
      const price = mine.getByTestId("editor-line-1-unit-price")
      await expect(price).toBeVisible({ timeout: 20_000 })
      await price.fill("650")
      await expect(mine.locator('[data-testid^="month-end-row-unsaved-"]')).toContainText("780")
      await mine.getByTestId("month-end-row-save-month").click()
      await expect(mine.locator('[data-testid^="month-end-row-editor-"]')).toHaveCount(0, {
        timeout: 20_000,
      })

      // The approver's panel follows without a reload: what changed, by whom, both totals.
      const changed = panel.getByTestId("month-end-changed")
      await expect(changed).toBeVisible({ timeout: 30_000 })
      await expect(changed).toContainText(`${customer} changed`)
      await expect(changed).toContainText(qa.admin.name)
      await expect(panel.getByTestId("month-end-changed-totals")).toContainText(
        /1[\s ,.]?764.*1[\s ,.]?956/,
      )
      await expect(panel.getByTestId("month-end-approve-count")).toContainText(/1[\s ,.]?956/)

      // Approving now approves the run as it is now.
      await panel.getByTestId("month-end-approve-new").click()
      await expect
        .poll(
          async () => {
            const [row] = (await env.db.sql.unsafe(
              `SELECT status FROM ${ks(env)}.approval_requests WHERE id = $1`,
              [run.approvalId],
            )) as Array<{ status: string }>
            return row?.status
          },
          { timeout: 30_000 },
        )
        .toBe("approved")
    } finally {
      await other.close()
    }
  })
})
