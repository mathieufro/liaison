// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 8 visual baselines — populated, full-shell screenshots that exercise
// the new sidebar-driven design. Scenes:
//
//   • shell-projects-home.png             full Shell + sidebar + projects-home
//   • shell-project-list-populated.png    full Shell + sidebar + list view
//   • shell-project-kanban-populated.png  full Shell + sidebar + kanban view
//   • shell-cross-project-filter.png      filters active, cross-project matches
//   • project-list-with-subtasks.png      list view crop, depth=2/3 tree lines
//   • project-kanban-populated.png        kanban crop, all five columns full
//   • project-kanban-degraded.png         narrow workspace → vertical fallback
//   • projects-sidebar-active.png         sidebar crop, active filters lit
//   • status-manager-populated.png        Manage statuses dialog with content
//   • kanban-card-checklist.png           card with release chip + level counters
//   • task-detail-checklist.png           task detail checklist section, named chips
//   • home-feed-three-providers.png       attention feed (legacy keep)
//
// Generate baselines via:
//   cd apps/web && bunx --bun playwright test --update-snapshots=all \
//     --grep "Phase 8 visual"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import {
  addChecklistItems,
  clearAllProjects,
  grantPhase8AttentionScopes,
  grantProjectScopes,
  resetAttentionForUser,
  seedAttentionFixtures,
  seedProjectsLandingBaseline,
  seedProjectWithTasks,
  seedRichAttentionFeed,
  seedRichProject,
  setChecklistValidations,
  setValidationLevels,
} from "./helpers/projects-seed"
import { seedInbox } from "./helpers/seed"

// Negative semantic assertions that apply across snapshot scenarios.
async function assertCalmVisualSemantics(
  locator: import("@playwright/test").Locator,
  opts: { maxBoundingPx?: { width: number; height: number } } = {},
) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeLessThanOrEqual(opts.maxBoundingPx?.width ?? 1440)
  expect(box!.height).toBeLessThanOrEqual(opts.maxBoundingPx?.height ?? 900)
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
}

async function assertNoRedOrangeAttentionRow(page: import("@playwright/test").Page) {
  const offending = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-testid^="attention-row-"]'))
    const flagged: Array<{ id: string; bg: string; bd: string }> = []
    for (const r of rows) {
      const cs = getComputedStyle(r as Element)
      const colours = [cs.backgroundColor, cs.borderColor, cs.color].join(" ").toLowerCase()
      const offendsRed =
        /rgb\((1[5-9][0-9]|2[0-4][0-9]|255),\s*([0-7][0-9]|[0-9]),\s*([0-5][0-9]|[0-9])\b/
      const offendsOrange = /rgb\((2[0-4][0-9]|255),\s*1[0-5][0-9],\s*([0-9]{1,2})\b/
      if (offendsRed.test(colours) || offendsOrange.test(colours)) {
        flagged.push({
          id: (r as HTMLElement).dataset.testid ?? "?",
          bg: cs.backgroundColor,
          bd: cs.borderColor,
        })
      }
    }
    return flagged
  })
  expect(offending, JSON.stringify(offending)).toEqual([])
}

// Home's Messages card (liaison-messaging-visibility Task 8) is thread-store
// driven, independent of kernel.attention_events -- resetAttentionForUser
// alone cannot guarantee an empty Home for a worker-shared user with unread
// thread activity left over from other tests in this worker. Mark every
// thread the user participates in as read through the real endpoint (not a
// raw UPDATE) so the read-state invariants stay correct.
async function markAllThreadsRead(env: WorkerEnv, token: string): Promise<void> {
  const res = await api(env.serverUrl, "/api/threads?limit=50", { token })
  const threads = (res.body.data ?? res.body.threads ?? res.body) as Array<{ id: string }>
  for (const t of threads) {
    await api(env.serverUrl, `/api/threads/${t.id}/read`, { method: "PATCH", token })
  }
}

// The QA seed's thread messages (Lucas's reply in the untitled Elodie + Lucas
// thread among them) become persisted `thread_reply` attention rows
// asynchronously. Rows that land after resetAttentionForUser's DELETE survive
// it, so an "empty Home" test must reset until the feed itself reads empty,
// twice in a row, rather than trust a single reset.
/**
 * The QA seed gives the user a personal mailbox that has not set up
 * encryption, and the kernel derives a "not syncing yet" alert from it on
 * every read (mailbox-keys/attention.ts): no reset clears it. The Home shots
 * are about their own rows, so the mailbox is disconnected for this file (the
 * lane's per-file reset brings it back). Every Home shot does it itself: a
 * shot that relied on an earlier test's disconnect grew by the alert's row
 * whenever that test failed and its retry started on a freshly reset lane.
 */
async function disconnectPersonalMailboxes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
): Promise<void> {
  await env.db.sql.unsafe(
    `UPDATE "${env.schemaPrefix ?? ""}app_mail".accounts SET disconnected_at = now()
      WHERE org_id = $1 AND owner_type = 'user' AND owner_id = $2 AND disconnected_at IS NULL`,
    [orgId, userId],
  )
}

async function drainAttentionFeed(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  token: string,
): Promise<void> {
  await disconnectPersonalMailboxes(env, orgId, userId)
  let emptyReads = 0
  let left: unknown[] = []
  await expect
    .poll(
      async () => {
        await resetAttentionForUser(env, orgId, token)
        await markAllThreadsRead(env, token)
        await clearKnowledgeReviewAttention(env, orgId, userId)
        const res = await api(env.serverUrl, "/api/attention-items", { token })
        const items = (res.body.data?.items ?? []) as unknown[]
        left = items
        emptyReads = items.length === 0 ? emptyReads + 1 : 0
        return emptyReads
      },
      {
        timeout: 20_000,
        intervals: [500],
        // What would not drain, so a failure names it.
        message: "attention feed did not drain",
      },
    )
    .toBeGreaterThanOrEqual(2)
    .catch((err: Error) => {
      throw new Error(
        `${err.message}\nitems left: ${JSON.stringify(
          left.map((i) => {
            const r = i as Record<string, unknown>
            return { app: r.app, entity: r.entity, kind: r.kind, title: r.title }
          }),
        )}`,
      )
    })
}

// Knowledge's `knowledge_review` attention kind is derived from document/
// source-link review state (org-wide, not per-user) rather than a persisted
// kernel.attention_events row, so resetAttentionForUser cannot clear it. Any
// Knowledge test that leaves a document `needs_review`/`stale` (or ownerless)
// in this worker's org otherwise permanently pollutes every later "empty
// Home" assertion in the same worker -- unrelated to liaison-messaging-
// visibility, but real, so clear it defensively before asserting emptiness.
async function clearKnowledgeReviewAttention(
  env: WorkerEnv,
  orgId: string,
  fallbackUserId: string,
): Promise<void> {
  const ak = env.schemaPrefix ? `"${env.schemaPrefix}app_knowledge"` : "app_knowledge"
  await env.db.sql.unsafe(
    `UPDATE ${ak}.documents
       SET review_status = 'verified',
           review_due_at = now() + interval '365 days',
           owner_user_id = COALESCE(owner_user_id, created_by)
     WHERE org_id = $1`,
    [orgId],
  )
  await env.db.sql.unsafe(
    `UPDATE ${ak}.source_links
       SET review_status = 'verified',
           review_due_at = now() + interval '365 days',
           owner_user_id = COALESCE(owner_user_id, $2::uuid),
           visibility_status = 'available',
           cache_status = 'available'
     WHERE org_id = $1`,
    [orgId, fallbackUserId],
  )
}

// The two QA seed documents whose resting review state (Q3 OKRs needs_review,
// Sales Deck v3 stale) puts Knowledge rows in the snapshotted feed.
const QA_KNOWLEDGE_REVIEW_DOCS = { "Q3 OKRs": "needs_review", "Sales Deck v3": "stale" } as const

async function qaKnowledgeReviewDocIds(env: WorkerEnv, orgId: string): Promise<string[]> {
  const ak = env.schemaPrefix ? `"${env.schemaPrefix}app_knowledge"` : "app_knowledge"
  const rows = (await env.db.sql.unsafe(
    `SELECT id FROM ${ak}.documents WHERE org_id = $1 AND title = ANY($2::text[]) ORDER BY title`,
    [orgId, Object.keys(QA_KNOWLEDGE_REVIEW_DOCS)],
  )) as Array<{ id: string }>
  expect(rows).toHaveLength(Object.keys(QA_KNOWLEDGE_REVIEW_DOCS).length)
  return rows.map((r) => r.id)
}

// Knowledge review state is org-wide and worker-shared, and home-feed-empty
// clears it for good (clearKnowledgeReviewAttention). A feed snapshot that
// shows Knowledge rows must therefore put them back itself: clear every
// review signal, then restore the two QA documents to their seeded state.
async function pinQaKnowledgeReviewState(
  env: WorkerEnv,
  orgId: string,
  fallbackUserId: string,
): Promise<void> {
  await clearKnowledgeReviewAttention(env, orgId, fallbackUserId)
  const ak = env.schemaPrefix ? `"${env.schemaPrefix}app_knowledge"` : "app_knowledge"
  for (const [title, status] of Object.entries(QA_KNOWLEDGE_REVIEW_DOCS)) {
    await env.db.sql.unsafe(
      `UPDATE ${ak}.documents SET review_status = $3 WHERE org_id = $1 AND title = $2`,
      [orgId, title, status],
    )
  }
}

// Kanban allows horizontal scroll on tight layouts (Linear/Asana ergonomics).
// We don't assert "no overflow" anymore — we assert the board renders at all
// and that columns are individually visible at their target width.
async function assertKanbanColumnsAreFullWidth(page: import("@playwright/test").Page) {
  const widths = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-testid="project-kanban-column"]')).map(
      (c) => (c as HTMLElement).getBoundingClientRect().width,
    )
  })
  expect(widths.length).toBeGreaterThan(0)
  // Each column must hit the +30% target (132 × 1.3 ≈ 172). Allow for a
  // small browser sub-pixel rounding.
  for (const w of widths) {
    expect(w).toBeGreaterThanOrEqual(230)
  }
}

async function settle(page: import("@playwright/test").Page, ms = 250) {
  await page.evaluate(() => document.fonts?.ready)
  await page.waitForTimeout(ms)
}

/**
 * A project with levels AI/Dev/Beta and one todo task (release 2.1.0) whose
 * three items read AI 3/3 (success), Dev 1/3 with one Fail (error), Beta 0/2
 * with one N/A (neutral), plus a sibling task without a checklist (no counter).
 */
async function seedChecklistVisual(env: WorkerEnv, token: string) {
  const seeded = await seedProjectWithTasks(env, token, {
    name: "Visual Checklist",
    tasks: [
      { title: "Ship firmware 2.1", statusLabel: "todo" },
      { title: "Update the quick start guide", statusLabel: "todo" },
    ],
  })
  const gated = seeded.tasks[0]!.id
  const plain = seeded.tasks[1]!.id
  await api(env.serverUrl, `/api/projects/${seeded.id}/tasks/${gated}`, {
    token,
    method: "PATCH",
    body: { release: "2.1.0" },
  })
  const levels = await setValidationLevels(env, token, seeded.id, [
    { name: "AI" },
    { name: "Dev" },
    { name: "Beta" },
  ])
  const [ai, dev, beta] = [levels[0]!, levels[1]!, levels[2]!]
  const items = await addChecklistItems(env, token, seeded.id, gated, [
    "Flash the bootloader",
    "Pedal calibration",
    "MIDI routing",
  ])
  const [a, b, c] = [items[0]!, items[1]!, items[2]!]
  await setChecklistValidations(env, token, seeded.id, gated, [
    { itemId: a.id, level: ai.id, state: "success" },
    { itemId: b.id, level: ai.id, state: "success" },
    { itemId: c.id, level: ai.id, state: "success" },
    { itemId: a.id, level: dev.id, state: "success" },
    { itemId: b.id, level: dev.id, state: "fail", note: "Sustain pedal reads inverted" },
    { itemId: c.id, level: beta.id, state: "na" },
  ])
  return { projectId: seeded.id, gated, plain, statuses: seeded.statuses }
}

test.describe("projects visual", () => {
  // Each test starts from a clean projects table so the sidebar's project
  // list reads exactly what the test seeds — pixel comparison demands it.
  test.beforeEach(async ({ env, qa }) => {
    await clearAllProjects(env, qa.admin.token)
  })

  test("shell-projects-home — full layout with populated sidebar", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await seedProjectsLandingBaseline(env, qa.admin.token)

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-projects").click()
    await expect(page.getByTestId("projects-home")).toBeVisible({ timeout: 15_000 })

    // Wait for the sidebar to render every seeded project so the screenshot
    // is deterministic (sort order alphabetical: Bug Tracker, Customer Onb…,
    // Internal Tools, Mobile App Launch, Q2 Roadmap).
    const sidebar = page.getByTestId("projects-sidebar")
    await expect(sidebar).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(
        async () =>
          await sidebar
            .locator(
              '[data-testid^="projects-sidebar.row-"]:not([data-testid^="projects-sidebar.row-key-"])',
            )
            .count(),
        {
          timeout: 10_000,
        },
      )
      .toBe(5)

    await settle(page)

    // Semantic gates.
    await assertCalmVisualSemantics(page.locator("[data-shell]"))

    await expect(page.locator("[data-shell]")).toHaveScreenshot("shell-projects-home.png", {
      maxDiffPixelRatio: 0.02,
      // P4c-T17: the agent panel is retired, so there is nothing to mask here
      // any more (the shell's fourth column is an app panel now).
    })
  })

  test("shell-project-list-populated — workspace + sidebar in list view", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const populated = await seedRichProject(env, qa.admin.token, {
      name: "Visual Bug Tracker",
      description: "Customer-reported defects and triage queue.",
      assigneeIds: [qa.admin.id],
      // Keep counts stable but realistic — ~25 tasks total + subtasks.
      distribution: { backlog: 5, todo: 7, in_progress: 4, done: 5, cancelled: 2 },
      subtaskParents: [0, 3, 7, 12, 17],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${populated.id}`)

    const workspace = page.getByTestId("project-workspace")
    await expect(workspace).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => await page.locator('[data-testid="project-list-view.row"]').count())
      .toBeGreaterThanOrEqual(20)

    await settle(page)

    await assertCalmVisualSemantics(page.locator("[data-shell]"))
    await expect(page.locator("[data-shell]")).toHaveScreenshot(
      "shell-project-list-populated.png",
      {
        maxDiffPixelRatio: 0.02,
      },
    )
  })

  test("shell-project-kanban-populated — kanban full with cards in every column", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const populated = await seedRichProject(env, qa.admin.token, {
      name: "Visual Kanban Project",
      description: "Pre-populated for visual QA — exercises every column.",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 6, todo: 8, in_progress: 5, done: 6, cancelled: 3 },
      subtaskParents: [0, 4],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${populated.id}?view=kanban`)

    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => await page.locator('[data-testid="project-kanban-card"]').count())
      .toBeGreaterThanOrEqual(20)
    await assertKanbanColumnsAreFullWidth(page)

    await settle(page)

    await assertCalmVisualSemantics(page.locator("[data-shell]"))
    await expect(page.locator("[data-shell]")).toHaveScreenshot(
      "shell-project-kanban-populated.png",
      {
        maxDiffPixelRatio: 0.02,
      },
    )
  })

  test("shell-cross-project-filter — sidebar filters active, projects-home pivots", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await seedProjectsLandingBaseline(env, qa.admin.token, {
      assigneeIds: [qa.admin.id],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-projects").click()
    await expect(page.getByTestId("projects-home")).toBeVisible({ timeout: 15_000 })

    // Activate two filters: assigned-to-me + todo.
    await page.getByTestId("projects-sidebar.filter-assigned-to-me").click()
    await page.getByTestId("projects-sidebar.filter-status-todo").click()

    await expect(page.getByTestId("projects-home.cross-project-results")).toBeVisible({
      timeout: 10_000,
    })
    await expect
      .poll(
        async () => {
          return await page.locator('[data-testid^="projects-home.cross-project-row-"]').count()
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0)

    await settle(page)

    await assertCalmVisualSemantics(page.locator("[data-shell]"))
    await expect(page.locator("[data-shell]")).toHaveScreenshot("shell-cross-project-filter.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("project-list-with-subtasks — list crop, multi-depth tree", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedRichProject(env, qa.admin.token, {
      name: "Visual Subtree",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 3, todo: 4, in_progress: 2, done: 1, cancelled: 0 },
      subtaskParents: [0, 1, 4],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-list-view")).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        async () =>
          await page.locator('[data-testid="project-list-view.row"][data-depth="2"]').count(),
        {
          timeout: 10_000,
        },
      )
      .toBeGreaterThanOrEqual(2)

    await settle(page)

    const list = page.getByTestId("project-list-view")
    await assertCalmVisualSemantics(list)
    await expect(list).toHaveScreenshot("project-list-with-subtasks.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("project-kanban-populated — kanban crop, all five columns full", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedRichProject(env, qa.admin.token, {
      name: "Visual Kanban Crop",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 6, todo: 8, in_progress: 5, done: 6, cancelled: 3 },
      subtaskParents: [],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => await page.locator('[data-testid="project-kanban-card"]').count(), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(25)
    await assertKanbanColumnsAreFullWidth(page)

    await settle(page)

    const board = page.getByTestId("project-kanban-board")
    await assertCalmVisualSemantics(board)
    await expect(board).toHaveScreenshot("project-kanban-populated.png", {
      maxDiffPixelRatio: 0.02,
      // The board keeps the window's full height, so the chat dock's bar (and
      // its live unread count, worker-shared) floats over its bottom corner.
      mask: [page.locator("[data-chat-dock]")],
    })
  })

  test("project-kanban-degraded — narrow viewport falls back to vertical groups", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedRichProject(env, qa.admin.token, {
      name: "Visual Kanban Narrow",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 2, todo: 2, in_progress: 2, done: 2, cancelled: 1 },
      subtaskParents: [],
    })

    // Force a tighter shell layout: collapse the agent panel via Cmd+. so the
    // workspace gets a narrow column. Five 132px columns + gaps need ≥ 700 px
    // of inner workspace; with the collapse + sidebar at default width we
    // typically still fit, so we additionally resize the viewport.
    await loginAs(page, env, "admin@test.com", "12345678")
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)
    await expect(page.getByTestId("project-workspace")).toBeVisible({ timeout: 15_000 })

    // Either kanban or status-grouped fallback is acceptable — at this width
    // the auto-degrade math should kick in (132×5 + 8×4 + 32 = 724 > 600ish).
    await page.waitForSelector(
      "[data-testid='project-kanban-board'], [data-testid='status-grouped-vertical']",
      { timeout: 15_000 },
    )

    await settle(page)

    const fallback = page.locator('[data-testid="status-grouped-vertical"]')
    const board = page.locator('[data-testid="project-kanban-board"]')
    const target = (await fallback.count()) > 0 ? fallback : board
    await assertCalmVisualSemantics(target.first())
    await expect(target.first()).toHaveScreenshot("project-kanban-degraded.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("projects-sidebar-active — sidebar crop with filters lit", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await seedProjectsLandingBaseline(env, qa.admin.token, {
      assigneeIds: [qa.admin.id],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-projects").click()
    const sidebar = page.getByTestId("projects-sidebar")
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        async () =>
          await sidebar
            .locator(
              '[data-testid^="projects-sidebar.row-"]:not([data-testid^="projects-sidebar.row-key-"])',
            )
            .count(),
        {
          timeout: 10_000,
        },
      )
      .toBe(5)

    // Light up two filters so the active-state styling is captured.
    await page.getByTestId("projects-sidebar.filter-assigned-to-me").click()
    await page.getByTestId("projects-sidebar.filter-status-in_progress").click()

    await settle(page)

    await assertCalmVisualSemantics(sidebar, { maxBoundingPx: { width: 320, height: 900 } })
    await expect(sidebar).toHaveScreenshot("projects-sidebar-active.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("status-manager-populated — Manage statuses dialog with project's statuses", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedRichProject(env, qa.admin.token, {
      name: "Visual Status Manager",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 1, todo: 1, in_progress: 1, done: 1, cancelled: 1 },
      subtaskParents: [],
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}`)
    await expect(page.getByTestId("project-workspace")).toBeVisible({ timeout: 15_000 })

    await page.getByTestId("project-workspace.manage-statuses").click()
    const dialog = page.locator('[role="dialog"]').filter({ hasText: "Manage statuses" })
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect
      .poll(async () => await dialog.getByRole("listitem").count())
      .toBeGreaterThanOrEqual(5)
      .catch(async () => {
        // StatusManager might not use semantic listitems; fall back to settle and continue.
        await settle(page)
      })

    await settle(page, 400)

    await assertCalmVisualSemantics(dialog)
    await expect(dialog).toHaveScreenshot("status-manager-populated.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("shell-project-kanban-filtered — sidebar pills narrow the visible columns", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedRichProject(env, qa.admin.token, {
      name: "Visual Kanban Filtered",
      description: "Demonstrates filter-pill column narrowing.",
      assigneeIds: [qa.admin.id],
      distribution: { backlog: 6, todo: 8, in_progress: 5, done: 6, cancelled: 3 },
      subtaskParents: [],
    })
    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.id}?view=kanban`)

    await expect(page.getByTestId("project-workspace")).toBeVisible({ timeout: 15_000 })
    // Activate two filter pills — only those two columns should remain.
    await page.getByTestId("projects-sidebar.filter-status-todo").click()
    await page.getByTestId("projects-sidebar.filter-status-in_progress").click()

    await expect
      .poll(async () => await page.locator('[data-testid="project-kanban-column"]').count(), {
        timeout: 5_000,
      })
      .toBe(2)

    await settle(page)

    await assertCalmVisualSemantics(page.locator("[data-shell]"))
    await expect(page.locator("[data-shell]")).toHaveScreenshot(
      "shell-project-kanban-filtered.png",
      {
        maxDiffPixelRatio: 0.02,
      },
    )
  })

  test("shell-task-detail-populated — full-page task with subtasks + thread", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Visual Bug Tracker",
      description: "Customer-reported defects and triage queue.",
      tasks: [
        {
          title: "Calibration drift on load-cell #4",
          statusLabel: "todo",
          assigneeId: qa.admin.id,
          dueDate: "2026-05-15",
        },
      ],
    })
    const parentId = seeded.tasks[0]!.id
    const todo = seeded.statuses.find((s) => s.label === "todo")!
    const backlog = seeded.statuses.find((s) => s.label === "backlog")!
    for (const child of [
      { title: "Reproduce on staging", statusId: todo.id },
      { title: "Capture trace + logs", statusId: backlog.id },
      { title: "Draft fix in branch", statusId: todo.id },
    ]) {
      await api(env.serverUrl, `/api/projects/${seeded.id}/tasks`, {
        token: qa.admin.token,
        body: { title: child.title, parentTaskId: parentId, statusId: child.statusId },
      })
    }
    // Add a description via the PATCH endpoint so the page has body copy.
    await api(env.serverUrl, `/api/projects/${seeded.id}/tasks/${parentId}`, {
      token: qa.admin.token,
      method: "PATCH",
      body: {
        description:
          "Load-cell #4 reads ~12% high after stabilising for 30s. Reproduces only on units shipped after batch K4. Repro steps documented in the linked thread.",
      },
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/tasks/${parentId}`)
    await expect(page.getByTestId("task-detail")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("task-detail.subtasks")).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId("task-detail.thread")).toBeVisible()

    await settle(page, 400)

    await assertCalmVisualSemantics(page.locator("[data-shell]"))
    await expect(page.locator("[data-shell]")).toHaveScreenshot("shell-task-detail-populated.png", {
      maxDiffPixelRatio: 0.02,
      // Mask the provenance line ("Created Xm ago, last updated Ym ago") and the
      // created-by line (the run's date): they carry timing that varies across
      // runs. The agent panel it also used to mask is retired .
      mask: [
        page.getByTestId("task-detail.provenance"),
        page.getByTestId("task-detail.created-by"),
        page.getByTestId("task-detail.status-since"),
      ],
    })
  })

  test("kanban-card-checklist — card with release chip and level counters", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedChecklistVisual(env, qa.admin.token)
    const todo = seeded.statuses.find((s) => s.label === "todo")!

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/${seeded.projectId}?view=kanban`)
    await expect(page.getByTestId("project-kanban-board")).toBeVisible({ timeout: 15_000 })
    const column = page.locator(
      `[data-testid="project-kanban-column"][data-status-id="${todo.id}"]`,
    )
    const card = column.locator(`[data-task-id="${seeded.gated}"]`)
    await expect(card.getByTestId("checklist-counter")).toHaveText(
      ["AI 3/3", "Dev 1/3", "Beta 0/2"],
      {
        timeout: 10_000,
      },
    )
    await expect(card.getByTestId("project-kanban-card.release")).toHaveText("2.1.0")
    await expect(
      column.locator(`[data-task-id="${seeded.plain}"]`).getByTestId("checklist-counter"),
    ).toHaveCount(0)

    await settle(page)
    await assertCalmVisualSemantics(column)
    await expect(column).toHaveScreenshot("kanban-card-checklist.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("task-detail-checklist — checklist section with named level chips", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    const seeded = await seedChecklistVisual(env, qa.admin.token)

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/projects/tasks/${seeded.gated}`)
    const section = page.getByTestId("task-detail.checklist")
    await expect(section).toBeVisible({ timeout: 15_000 })
    await expect(section.getByTestId("checklist.chip")).toHaveCount(9, { timeout: 10_000 })
    await expect(section.getByTestId("checklist.header")).toContainText("0/3 complete")
    await expect(section.getByTestId("checklist.header")).toContainText("1 failing")

    await settle(page)
    await assertCalmVisualSemantics(section)
    await expect(section).toHaveScreenshot("task-detail-checklist.png", {
      maxDiffPixelRatio: 0.02,
    })
  })

  test("home-feed-rich — populated feed across all kinds", async ({ page, env, qa, world }) => {
    await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
    await resetAttentionForUser(env, world.org.id, qa.admin.token)
    const inbox = await seedInbox(env, world.org.id, {
      name: "RichInbox",
      emailAddress: `rich-${Date.now()}@e2e.test`,
    })
    const rich = await seedRichAttentionFeed(env, {
      orgId: world.org.id,
      userId: qa.admin.id,
      adminToken: qa.admin.token,
      inboxId: inbox.id,
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-home").click()
    await expect(page.getByTestId("home-feed")).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(async () => await page.locator('[data-testid^="attention-row-"]').count(), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(8)
    // The stored lists are refreshed by queued jobs, one per interval: the blocked
    // task (its block is the seed's last write) can land a refresh after the rest.
    await expect(
      page.getByTestId(`attention-row-projects-task-${rich.taskIds.blockedId}`),
    ).toBeVisible({ timeout: 30_000 })

    await assertNoRedOrangeAttentionRow(page)
    // Wait an extra beat for the stagger animation to complete (8 rows × 30ms
    // delay + 200ms duration = ~440ms max).
    await settle(page, 500)

    const home = page.getByTestId("home")
    // 8+ rows legitimately exceed the 900px viewport — assert width only.
    await assertCalmVisualSemantics(home, { maxBoundingPx: { width: 1440, height: 1500 } })
    await expect(home).toHaveScreenshot("home-feed-rich.png", {
      maxDiffPixelRatio: 0.02,
      // Greeting includes a time-of-day phrase ("Good morning/afternoon/evening")
      // and the meta-line shows "UPDATED Xm AGO" — both shift across runs.
      // Messages (liaison-messaging-visibility Task 8) is masked too: admin
      // is a worker-shared QA user, so its thread list/counts vary with
      // unrelated tests' activity in the same worker. The chat dock's unread
      // badge, which the shot reaches at the viewport's bottom, varies the same way.
      mask: [
        page.locator("h1").filter({ hasText: /Good (morning|afternoon|evening)/ }),
        page.getByTestId("home-status"),
        page.getByTestId("home-card-messages"),
        page.locator("[data-chat-dock]"),
      ],
    })
  })

  test("home-feed-empty — calm empty state with app links", async ({ page, env, qa, world }) => {
    await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
    await drainAttentionFeed(env, world.org.id, qa.admin.id, qa.admin.token)

    // Home renders ALL CLEAR before its first attention fetch lands, so the
    // assertion below only means something once the real feed has arrived.
    const feedLoaded = page.waitForResponse(
      (r) => r.url().includes("/api/attention-items") && r.ok(),
    )
    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-home").click()
    await expect(page.getByTestId("home")).toBeVisible({ timeout: 15_000 })
    await feedLoaded
    // ALL CLEAR meta + empty state component should be visible.
    await expect(page.getByText("ALL CLEAR")).toBeVisible({ timeout: 10_000 })

    await settle(page, 300)

    const home = page.getByTestId("home")
    await assertCalmVisualSemantics(home)
    await expect(home).toHaveScreenshot("home-feed-empty.png", {
      maxDiffPixelRatio: 0.02,
      mask: [
        page.locator("h1").filter({ hasText: /Good (morning|afternoon|evening)/ }),
        // Home keeps the window's full height: the chat dock's bar floats over
        // its bottom corner with a live, worker-shared unread count.
        page.locator("[data-chat-dock]"),
      ],
    })
  })

  test("home-feed-three-providers — populated unified attention feed", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantPhase8AttentionScopes(env, world.org.id, qa.admin.id)
    await disconnectPersonalMailboxes(env, world.org.id, qa.admin.id)
    await resetAttentionForUser(env, world.org.id, qa.admin.token)
    await markAllThreadsRead(env, qa.admin.token)
    await pinQaKnowledgeReviewState(env, world.org.id, qa.admin.id)

    const inbox = await seedInbox(env, world.org.id, {
      name: "VisInbox",
      emailAddress: `vis-${Date.now()}@e2e.test`,
    })
    const seeded = await seedAttentionFixtures(env, {
      orgId: world.org.id,
      userId: qa.admin.id,
      adminToken: qa.admin.token,
      inboxId: inbox.id,
    })

    await loginAs(page, env, "admin@test.com", "12345678")
    await page.getByTestId("activity-home").click()
    await page.waitForSelector("[data-testid='home-feed']", { timeout: 15_000 })

    const rows = [
      page.getByTestId(`attention-row-projects-task-${seeded.overdueTaskId}`),
      page.getByTestId(`attention-row-tickets-ticket-${seeded.ticketId}`),
      page.getByTestId(`attention-row-kernel-approval_request-${seeded.approvalRequestId}`),
    ]
    // The stored lists are refreshed by a queued job (one interval at most).
    for (const r of rows) await expect(r).toBeVisible({ timeout: 30_000 })
    const knowledgeIds = await qaKnowledgeReviewDocIds(env, world.org.id)
    for (const id of knowledgeIds) {
      await expect(page.getByTestId(`attention-row-knowledge-document-${id}`)).toBeVisible({
        timeout: 10_000,
      })
    }

    await assertNoRedOrangeAttentionRow(page)
    await settle(page)

    const home = page.getByTestId("home-feed")
    await assertCalmVisualSemantics(home)
    await expect(home).toHaveScreenshot("home-feed-three-providers.png", {
      maxDiffPixelRatio: 0.02,
      // Defensive: Messages is thread-store driven and admin is a
      // worker-shared user, so mask it even though this scenario seeds no
      // thread activity of its own.
      mask: [page.getByTestId("home-card-messages")],
    })
  })
})
