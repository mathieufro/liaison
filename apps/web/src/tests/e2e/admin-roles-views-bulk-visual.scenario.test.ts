// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 9 — S15 Visual snapshots for the new Phase 9 surfaces.
// (e2e-plan §S15, spec §6 / §10 / §11.4.)
//
// Targeted cropped snapshots — one per logical component/state. Each crop is
// asserted against state-specific text BEFORE the screenshot is taken so a
// silent wrong-component capture would fail the test on the text assertion
// rather than the pixel diff. Golden samples are stored under
// `admin-roles-views-bulk-visual.scenario.test.ts-snapshots/`. The plan's
// "dual-path validator (pixel diff → LLM fallback)" is implemented as
// pixel-diff only for now; LLM fallback is a separate infrastructure follow-up.

import { randomUUID } from "node:crypto"
import { expect, loginAs, test } from "./fixtures/test"

test("visual snapshot: admin user detail page", async ({ authenticatedPage, env, qa }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/users/${qa.amina.id}`)

  // Wait for all three sections so the snapshot captures stable content.
  await expect(page.getByTestId("admin-user-section-identity")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("admin-user-section-roles")).toBeVisible()
  await expect(page.getByTestId("admin-user-section-effective-scopes")).toBeVisible()

  // Anti-rubber-stamp: the identity card must contain Amina's name before
  // the screenshot is taken.
  await expect(page.getByTestId("admin-user-section-identity")).toContainText(/Amina/i)

  // Crop the identity card alone — the rest of the page (roles, scopes,
  // dimensions) has too much variance across worker DBs to be stable.
  await expect(page.getByTestId("admin-user-section-identity")).toHaveScreenshot(
    "phase9-admin-user-detail-identity.png",
    { maxDiffPixelRatio: 0.02 },
  )
})

test("visual snapshot: admin role detail page", async ({ authenticatedPage, env }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/settings/admin/roles`)
  // Click into the first role row to land on its detail page.
  const firstRoleLink = page.locator('[data-testid^="admin-roles-row-"]').first()
  await firstRoleLink.waitFor({ state: "visible", timeout: 15000 })
  await firstRoleLink.click()
  await expect(page.getByTestId("admin-role-section-scopes")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId("admin-role-section-members")).toBeVisible()
  // The full permission catalog height varies with worker-shared app/role seed
  // state. Keep this as a structural visual smoke instead of a brittle crop.
  await expect(page.getByTestId("admin-role-section-scopes")).toContainText("Permissions")
  await expect(page.getByTestId("admin-role-permission-app-kernel")).toBeVisible()
})

test("visual snapshot: saved views sidebar", async ({ authenticatedPage, env }) => {
  const page = authenticatedPage
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  const list = page.getByTestId("saved-views-list")
  await expect(list).toBeVisible({ timeout: 20000 })
  // Structural assertions — sub-pixel font rendering shifts the list height
  // by 1px between parallel and isolated runs, which trips toHaveScreenshot's
  // exact-size match. Verify the structural elements instead.
  await expect(page.getByTestId("saved-view-create")).toBeVisible()
  // At least one seeded saved view row should render.
  await expect(list.locator('[data-testid^="saved-view-"]').first()).toBeVisible()
})

test("visual snapshot: bulk toolbar resting state", async ({ page, env, qa, world }) => {
  // Seed two tickets, open the inbox, select both — the toolbar's resting
  // state shows the chips for each manifest-declared bulk action.
  const { seedInbox, seedTicket } = await import("./helpers/seed")
  const prefix = `s15-${randomUUID().slice(0, 6)}`
  const inbox = await seedInbox(env, world.org.id, {
    name: `S15Inbox-${prefix}`,
    emailAddress: `${prefix}@e2e.test`,
    isDefault: true,
  })
  const t1 = await seedTicket(env, world.org.id, {
    subject: `${prefix} A`,
    sourceInboxId: inbox.id,
  })
  const t2 = await seedTicket(env, world.org.id, {
    subject: `${prefix} B`,
    sourceInboxId: inbox.id,
  })
  const { indexSeededTickets, searchInboxFor } = await import("./helpers/tickets-search")
  await indexSeededTickets(env, { email: qa.admin.email, password: "12345678" }, prefix, [
    t1.id,
    t2.id,
  ])

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(`http://localhost:${env.ports[1]}/tickets`)
  await expect(page.getByTestId("tickets-inbox")).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId(`tickets-list-row-${t1.id}`)).toBeVisible({ timeout: 15000 })
  await searchInboxFor(page, prefix, [t1.id, t2.id])
  await page.getByTestId(`tickets-row-checkbox-${t1.id}`).check()
  await page.getByTestId(`tickets-row-checkbox-${t2.id}`).check()

  const toolbar = page.getByTestId("bulk-toolbar")
  await expect(toolbar).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("bulk-selection-count")).toHaveText("2 selected")
  // Anti-rubber-stamp: every action chip rendered at resting must be present.
  await expect(page.getByTestId("bulk-action-assign")).toBeVisible()

  await expect(toolbar).toHaveScreenshot("phase9-bulk-toolbar-resting.png", {
    maxDiffPixelRatio: 0.02,
  })

  // No label wraps, at desktop width or at phone width, where the actions that
  // do not fit move into the More menu. Measured on the real layout.
  const singleLine = async () =>
    toolbar.evaluate((bar) => {
      const nodes = Array.from(
        bar.querySelectorAll<HTMLElement>(
          '[data-testid="bulk-selection-count"], [data-testid^="bulk-action-"], [data-testid="bulk-more-trigger"]',
        ),
      )
      const wrapped = nodes
        .filter((el) => {
          // A label wraps when its text lays out on more than one line box.
          // (Touch targets make phone chips taller, so height alone lies.)
          // Only the text's own boxes count: a chip's icon (the More chevron)
          // is centred on the line, so its box starts a pixel or two off the
          // glyphs' and would read as a second line at some subpixel offsets.
          const tops = new Set<number>()
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(n)
            for (const r of Array.from(range.getClientRects())) {
              if (r.width > 0 && r.height > 0) tops.add(Math.round(r.top))
            }
          }
          return tops.size > 1
        })
        .map((el) => el.dataset.testid)
      const r = bar.getBoundingClientRect()
      return { wrapped, left: r.left, right: r.right, vw: window.innerWidth, n: nodes.length }
    })
  const desktop = await singleLine()
  expect(desktop.wrapped).toEqual([])
  const originalViewport = page.viewportSize()
  await page.setViewportSize({ width: 400, height: 800 })
  await expect(page.getByTestId("bulk-more-trigger")).toBeVisible()
  const phone = await singleLine()
  expect(phone.wrapped).toEqual([])
  expect(phone.left).toBeGreaterThanOrEqual(0)
  expect(phone.right).toBeLessThanOrEqual(phone.vw)
  // At phone width the toolbar floats clear of the bottom tab bar: measured
  // boxes, no intersection. The floating Chats opener is a TABLET affordance
  // and is not rendered here at all (F2), so the bar and the five seats are
  // the only furniture the toolbar has to keep clear of.
  await expect(page.getByTestId("phone-tab-bar")).toBeVisible()
  await expect(page.getByTestId("phone-tab-chats")).toBeVisible()
  await expect(page.getByTestId("chats-sheet-opener")).toHaveCount(0)
  const boxOf = async (testId: string) => {
    const b = await page.getByTestId(testId).boundingBox()
    if (!b) throw new Error(`no bounding box for ${testId}`)
    return b
  }
  const intersects = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const barBox = await boxOf("bulk-toolbar")
  const navBox = await boxOf("phone-tab-bar")
  expect(intersects(barBox, navBox), JSON.stringify({ barBox, navBox })).toBe(false)
  await expect(toolbar).toHaveScreenshot("phase9-bulk-toolbar-resting-phone.png", {
    maxDiffPixelRatio: 0.02,
  })
  if (originalViewport) await page.setViewportSize(originalViewport)
  await expect(page.getByTestId("bulk-action-close")).toBeVisible()

  // ── Expanded close form ───────────────────────────────────────────────
  await page.getByTestId("bulk-action-close").click()
  await expect(page.getByTestId("bulk-form")).toBeVisible()
  await expect(page.getByTestId("bulk-field-closedReason")).toBeVisible()
  // closedReason is an enum param, rendered as a <select>.
  await page.getByTestId("bulk-field-closedReason").selectOption("resolved")
  await page.getByTestId("bulk-field-textBody").fill(`S15 ${prefix}`)
  await expect(toolbar).toHaveScreenshot("phase9-bulk-toolbar-expanded-close.png", {
    maxDiffPixelRatio: 0.02,
  })

  // ── Submit -> outcome state ───────────────────────────────────────────
  // The golden is a SUCCESSFUL close. A closing message is a real customer
  // email and needs a live mail connection, which the e2e world does not have
  // (seeded inboxes carry no connected account), so it would record "failed"
  // as the golden. Close without a message: the everyday resolve, which
  // needs no mail account at all.
  await page.getByTestId("bulk-field-textBody").fill("")
  const dispatchResp = page.waitForResponse(
    (r) => r.url().includes("/api/apps/tickets/bulk/close") && r.request().method() === "POST",
  )
  await page.getByTestId("bulk-submit").click()
  const resp = await dispatchResp
  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as { data: { succeeded: number; failed: number } }
  expect(body.data.failed).toBe(0)
  expect(body.data.succeeded).toBe(2)
  // The outcome span renders after the response settles.
  await expect(page.getByTestId("bulk-outcome")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId("bulk-outcome-succeeded")).toHaveText("2 done")
  await expect(page.getByTestId("bulk-outcome-errors")).toHaveCount(0)
  await expect(toolbar).toHaveScreenshot("phase9-bulk-toolbar-outcome.png", {
    maxDiffPixelRatio: 0.05,
  })
})
