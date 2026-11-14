// SPDX-License-Identifier: FSL-1.1-ALv2
import { expect, loginAs, test } from "./fixtures/test"
import { createApprovalActor, seedGatedApproval, seedOrgSkill } from "./helpers/approvals-seed"

// ─────────────────────────────────────────────────────────────────────────────
// Visual Regression Tests — Approval surfaces (Phase 6.3 § 11)
//
// Captures targeted, component-scoped baselines so a regression in the
// ApprovalCard, the approval-thread header, or the Home decidable-list does
// not get masked by sidebar/thread-list churn.
// ─────────────────────────────────────────────────────────────────────────────

async function waitForFontsAndSettle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
}

const TIME_MASK = /minutes? ago|just now|hours? ago|days? ago/
const SCREENSHOT_OPTS = {
  maxDiffPixelRatio: 0.05,
}

test.describe("Approval Card", () => {
  test("approval card visual self-approver pending", async ({ page, env, world }) => {
    const actor = await createApprovalActor(world, {
      name: "Visual Self Approver",
      scopes: ["test:gated:write", "test:approve"],
    })
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Approval card self-approve visual",
      toolCallMessage: true,
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    const card = tab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId("approval-card-action-approve")).toBeVisible()
    await waitForFontsAndSettle(page)

    await expect(card).toHaveScreenshot("approval-card-pending-self-approve.png", {
      ...SCREENSHOT_OPTS,
      mask: [card.locator(`text=${TIME_MASK}`)],
    })
  })

  test("approval card visual update_skill body diff", async ({ page, env, world }) => {
    // update_skill renders a git-style diff (removed red / added green) of the
    // proposed body against the currently-deployed skill, not a raw payload dump.
    const actor = await createApprovalActor(world, {
      name: "Visual Skill Reviewer",
      // skills:read → the diff view fetches the current skill; kernel:approve →
      // the Approve button renders (representative decidable state).
      scopes: ["kernel:skills:read", "kernel:skills:write", "kernel:approve"],
    })
    const oldBody =
      "# Support voice\n\nKeep replies short.\n\n## Register\n- Two to five sentences per reply.\n- Stay warm."
    const newBody =
      "# Support voice\n\nKeep replies short and chill.\n\n## Register\n- Two to four sentences per reply.\n- Stay warm.\n- No filler closers."
    const skillId = await seedOrgSkill(env, world.org.id, "team-voice", oldBody)
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Update skill visual",
      toolCallMessage: true,
      toolName: "kernel:update_skill",
      params: { id: skillId, body: newBody },
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    const card = tab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId("skill-approval-diff")).toBeVisible()
    await waitForFontsAndSettle(page)

    await expect(card).toHaveScreenshot("skill-approval-update-diff.png", {
      ...SCREENSHOT_OPTS,
      // The request handle is a random per-run slice; mask it with the time text.
      mask: [card.locator(`text=${TIME_MASK}`), card.getByTestId("approval-card-handle")],
    })
  })

  test("approval card visual create_skill full skill", async ({ page, env, world }) => {
    // create_skill renders the complete skill: name, visibility, description, body.
    const actor = await createApprovalActor(world, {
      name: "Visual Skill Creator",
      scopes: ["kernel:skills:write", "kernel:approve"],
    })
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: actor.id,
      participantUserIds: [actor.id],
      approverUserIds: [actor.id],
      title: "Create skill visual",
      toolCallMessage: true,
      toolName: "kernel:create_skill",
      params: {
        name: "greeting-skill",
        description: "Says hello",
        visibility: "org",
        body: "# Greeting skill\nAlways say hello\nand be brief",
      },
    })

    await loginAs(page, env, actor.email, actor.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    const card = tab.locator(
      `[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`,
    )
    await expect(card).toBeVisible({ timeout: 10000 })
    await expect(card.getByTestId("skill-approval-create")).toBeVisible()
    await waitForFontsAndSettle(page)

    await expect(card).toHaveScreenshot("skill-approval-create.png", {
      ...SCREENSHOT_OPTS,
      mask: [card.locator(`text=${TIME_MASK}`), card.getByTestId("approval-card-handle")],
    })
  })

  test("approval card visual approval-thread header pending", async ({ page, env, world }) => {
    const requester = await createApprovalActor(world, {
      name: "Visual Header Requester",
      scopes: ["test:gated:write"],
    })
    const approver = await createApprovalActor(world, {
      name: "Visual Header Approver",
      scopes: ["test:gated:write", "test:approve"],
    })
    const seeded = await seedGatedApproval(env, world.org.id, {
      requesterUserId: requester.id,
      participantUserIds: [approver.id, requester.id],
      approverUserIds: [approver.id],
      title: "Approval thread header visual",
      toolCallMessage: true,
    })

    await loginAs(page, env, approver.email, approver.password)
    await page.goto(`http://localhost:${env.ports[1]}/threads/${seeded.threadId}`)
    // The conversation the call was made in renders the request as a live
    // ApprovalCard inline, in the agent's tool-call row.
    const tab = page.locator('[data-testid="tab-content-area"] > [data-tab-active="true"]')
    await tab.getByTestId("message-row-tools-toggle").first().click()
    await expect(
      tab.locator(`[data-testid="approval-card"][data-request-id="${seeded.approvalRequestId}"]`),
    ).toBeVisible({ timeout: 15000 })
  })
})

test.describe("Home", () => {
  // Cold walk 2026-11-08: Details on a Home row opened a long diff and Approve / Reject went
  // out of view, so a reader could not see how to decide after reading. The opened card now
  // leads with its decision row, sticky to the top of the scrolling Home while the details
  // scroll under it; the chat dock owns the bottom of the screen, so the row never sits there.
  // A layout claim only a browser proves, at desktop and at phone width.
  for (const vp of [
    { name: "desktop", width: 1440, height: 760, home: "activity-home", row: "actions-inline-row" },
    {
      name: "phone",
      width: 390,
      height: 844,
      home: "phone-tab-home",
      row: "approval-card-actions",
    },
  ]) {
    test(`details on a long approval keeps approve and reject at the top, in reach (${vp.name})`, async ({
      page,
      env,
      world,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const actor = await createApprovalActor(world, {
        name: `Visual Details Reader ${vp.name}`,
        scopes: ["test:gated:write", "test:approve"],
      })
      // Someone else asks, so the row is the reader's own decision (not folded as peer noise).
      const requester = await createApprovalActor(world, {
        name: `Visual Details Requester ${vp.name}`,
        scopes: ["test:gated:write"],
      })
      // A message long enough that the opened card is taller than the screen.
      const message = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the reply.`).join(
        "\n\n",
      )
      const seeded = await seedGatedApproval(env, world.org.id, {
        requesterUserId: requester.id,
        participantUserIds: [actor.id, requester.id],
        approverUserIds: [actor.id],
        title: "Long approval details",
        toolCallMessage: true,
        params: { message },
      })
      await loginAs(page, env, actor.email, actor.password)
      await page.getByTestId(vp.home).click()
      const rowId = `attention-row-kernel-approval_request-${seeded.approvalRequestId}`
      await expect(page.getByTestId(rowId)).toBeVisible({ timeout: 15000 })
      await page.getByTestId(`${rowId}-details`).click()
      const card = page.getByTestId(`${rowId}-expanded`).getByTestId("approval-card")
      const title = card.getByTestId("approval-card-title")
      await expect(title).toBeVisible({ timeout: 10000 })
      const decision = card.getByTestId(vp.row)
      await expect(decision).toHaveCount(1)
      // The card is taller than the screen: its end is below the fold.
      const cardBox = await card.boundingBox()
      expect((cardBox?.y ?? 0) + (cardBox?.height ?? 0)).toBeGreaterThan(vp.height)

      // The decision leads the card: at its top edge, above its title.
      const before = await decision.boundingBox()
      const titleBox = await title.boundingBox()
      expect(before).not.toBeNull()
      expect(before?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(titleBox?.y ?? 0)
      expect((before?.y ?? 0) - (cardBox?.y ?? 0)).toBeLessThanOrEqual(24)

      // Read on: the details scroll under the row, which stays at the top of the Home.
      await card.hover()
      await page.mouse.wheel(0, 1200)
      await expect
        .poll(async () => (await title.boundingBox())?.y ?? 0)
        .toBeLessThan((titleBox?.y ?? 0) - 400)
      const after = await decision.boundingBox()
      expect(after).not.toBeNull()
      expect(after?.y ?? -1).toBeGreaterThanOrEqual(0)
      expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual(vp.height / 2)
      // Approve and Reject are on screen and take the click: nothing (the chat dock included)
      // lies over them. A trial click runs Playwright's hit-target check without deciding.
      for (const id of ["approval-card-action-approve", "approval-card-action-deny"]) {
        const button = card.getByTestId(id).first()
        const box = await button.boundingBox()
        expect(box, id).not.toBeNull()
        expect(box?.y ?? -1, id).toBeGreaterThanOrEqual(0)
        expect((box?.y ?? 0) + (box?.height ?? 0), id).toBeLessThanOrEqual(vp.height / 2)
        await button.click({ trial: true, timeout: 5000 })
      }
    })
  }

  test("approval card visual home empty state", async ({ page, env, world }) => {
    const actor = await createApprovalActor(world, {
      name: "Visual Empty Home",
      scopes: ["test:gated:write", "test:approve"],
    })
    await loginAs(page, env, actor.email, actor.password)
    await page.getByTestId("activity-home").click()
    // The attention feed is part of Home itself now: there is no side pane to
    // toggle open, so the empty state is on the screen you arrive on.
    await expect(page.getByTestId("home")).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId("home-empty-state")).toBeVisible({ timeout: 10000 })
    await waitForFontsAndSettle(page)

    await expect(page.getByTestId("home-empty-state")).toHaveScreenshot(
      "home-empty-state.png",
      SCREENSHOT_OPTS,
    )
  })
})
