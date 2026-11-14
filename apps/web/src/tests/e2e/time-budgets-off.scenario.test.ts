// SPDX-License-Identifier: FSL-1.1-ALv2
// Time and budgets are per project. An organisation where no project uses them shows none of
// their test ids; once one project is turned on, only that project shows them, on a desktop
// window and on a phone, and its task shows the Timebox chip and the Took field. The sidebar's
// Capacity row is org-wide: it appears once any project uses time, on every project's page.
import { api } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { clearAllProjects, grantProjectScopes, seedProjectWithTasks } from "./helpers/projects-seed"

const TIME_IDS = [
  "task-timebox-chip",
  "task-took",
  "budget-line",
  "budget-panel",
  "month-close-line",
] as const
const CAPACITY_ROW = "side-capacity"
const SEE = { timeout: 20_000 } as const

/**
 * The time ids the reader can see. Every open tab stays mounted, the inactive ones hidden, so after
 * a visit to the project using time its task tab (restored on the next page load) still holds a
 * hidden Timebox chip and Took field: what this page shows is the visible ones.
 */
async function countTimeIds(page: Page): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const id of TIME_IDS) out[id] = await page.getByTestId(id).filter({ visible: true }).count()
  return out
}

const NONE = Object.fromEntries(TIME_IDS.map((id) => [id, 0]))

test.describe("time and budgets are per project", () => {
  test("an org with no project using time shows none of the time test ids", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await clearAllProjects(env, qa.admin.token)
    const house = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Studio internal",
      key: "HOUSE",
      tasks: [{ title: "Tidy the shelves" }],
    })
    await loginAs(page, env, "admin@test.com", "12345678")
    const base = `http://localhost:${env.ports[1]}`
    await page.goto(`${base}/projects/${house.id}`)
    await expect(page.getByTestId("project-workspace.title")).toBeVisible(SEE)
    expect(await countTimeIds(page)).toEqual(NONE)
    await expect(page.getByTestId(CAPACITY_ROW)).toHaveCount(0)
    await page.goto(`${base}/projects/tasks/${house.tasks[0]!.id}`)
    await expect(page.getByTestId("task-detail.meta-row")).toBeVisible(SEE)
    expect(await countTimeIds(page)).toEqual(NONE)
    await expect(page.getByTestId(CAPACITY_ROW)).toHaveCount(0)
  })

  test("the project without time shows nothing and the one with it shows everything, on desktop and phone", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await clearAllProjects(env, qa.admin.token)
    const house = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Studio internal",
      key: "STUDIO",
      tasks: [{ title: "Tidy the shelves" }],
    })
    const atlas = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Partner portal",
      key: "PORTAL",
      tasks: [{ title: "Draft the quote" }],
    })
    const on = await api(env.serverUrl, `/api/projects/${atlas.id}`, {
      token: qa.admin.token,
      method: "PATCH",
      body: { timeBudgets: true },
    })
    expect(on.status, JSON.stringify(on.body)).toBeLessThan(300)

    await loginAs(page, env, "admin@test.com", "12345678")
    const base = `http://localhost:${env.ports[1]}`
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size)

      await page.goto(`${base}/projects/${house.id}`)
      await expect(page.getByTestId("project-workspace.title")).toBeVisible(SEE)
      expect(await countTimeIds(page)).toEqual(NONE)
      // Another project uses time, so the org-wide Capacity row shows here too (desktop sidebar).
      if (size.width >= 1024) await expect(page.getByTestId(CAPACITY_ROW)).toHaveCount(1)
      await page.goto(`${base}/projects/tasks/${house.tasks[0]!.id}`)
      await expect(page.getByTestId("task-detail.meta-row")).toBeVisible(SEE)
      expect(await countTimeIds(page)).toEqual(NONE)

      await page.goto(`${base}/projects/${atlas.id}`)
      await expect(page.getByTestId("budget-line")).toBeVisible(SEE)
      await expect(page.getByTestId("budget-panel")).toBeVisible(SEE)
      await page.goto(`${base}/projects/tasks/${atlas.tasks[0]!.id}`)
      await expect(page.getByTestId("task-timebox-chip")).toBeVisible(SEE)
      await expect(page.getByTestId("task-took")).toBeVisible(SEE)
      // No dialog opens for either, and nothing scrolls sideways on the phone.
      await page.getByTestId("task-took-input").focus()
      await page.getByTestId("task-timebox-chip").click()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })

  test("typing a Took on the task saves it and the project's budget line follows", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await clearAllProjects(env, qa.admin.token)
    const atlas = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Partner portal",
      key: "ORBIT",
      tasks: [{ title: "Draft the quote" }],
    })
    await api(env.serverUrl, `/api/projects/${atlas.id}`, {
      token: qa.admin.token,
      method: "PATCH",
      body: { timeBudgets: true },
    })
    await loginAs(page, env, "admin@test.com", "12345678")
    const base = `http://localhost:${env.ports[1]}`
    await page.goto(`${base}/projects/tasks/${atlas.tasks[0]!.id}`)
    const took = page.getByTestId("task-took-input")
    await expect(took).toBeVisible(SEE)
    await took.fill("a while")
    await took.press("Enter")
    await expect(page.getByTestId("task-took-error")).toContainText("Could not read this")
    await took.fill("1h30")
    await took.press("Enter")
    await expect(page.getByTestId("task-took-total")).toHaveText("1 h 30 so far", SEE)
  })

  test("a timebox comes back with the task, and the task list shows Planned only on that project's rows", async ({
    page,
    env,
    qa,
    world,
  }) => {
    await grantProjectScopes(env, world.org.id, qa.admin.id)
    await clearAllProjects(env, qa.admin.token)
    const house = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Studio internal",
      key: "SHELF",
      tasks: [{ title: "Sort the shelves" }],
    })
    const atlas = await seedProjectWithTasks(env, qa.admin.token, {
      name: "Partner portal",
      key: "ATLAS",
      tasks: [{ title: "Sort the import" }],
    })
    await api(env.serverUrl, `/api/projects/${atlas.id}`, {
      token: qa.admin.token,
      method: "PATCH",
      body: { timeBudgets: true },
    })
    await loginAs(page, env, "admin@test.com", "12345678")
    const base = `http://localhost:${env.ports[1]}`
    await page.goto(`${base}/projects/tasks/${atlas.tasks[0]!.id}`)
    await page.getByTestId("task-timebox-chip").click()
    const box = page.getByTestId("task-timebox-input")
    await box.fill("2 days")
    await box.press("Enter")
    await expect(page.getByTestId("task-timebox-chip")).toHaveAttribute("data-state", "set", SEE)
    await page.reload()
    await expect(page.getByTestId("task-timebox-chip")).toHaveAttribute("data-state", "set", SEE)

    await page.goto(`${base}/projects`)
    await page.getByTestId("projects-sidebar.search").fill("Sort the")
    await expect(
      page.getByTestId(`projects-home.cross-project-row-${atlas.tasks[0]!.id}`),
    ).toBeVisible(SEE)
    await expect(
      page.getByTestId(`projects-home.cross-project-row-${house.tasks[0]!.id}`),
    ).toBeVisible(SEE)
    await expect(page.getByTestId(`projects-home.row-planned-${atlas.tasks[0]!.id}`)).toHaveText(
      /^Planned /,
    )
    await expect(page.getByTestId(`projects-home.row-planned-${house.tasks[0]!.id}`)).toHaveCount(0)
  })
})
