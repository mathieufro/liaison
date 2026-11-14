// SPDX-License-Identifier: FSL-1.1-ALv2
// Projects' settings page (settings overhaul P2 T8): the CI release-status
// connection (org section, projects:settings:admin) and the task label
// taxonomy (a tree block under projects:labels:admin). Statuses and
// validation levels are per-project and stay in the project itself.
import { describe, expect, it } from "bun:test"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { validateAppManifest } from "~/modules/apps/contract"

describe("projects settings manifest", () => {
  it("declares the ci connections section and the labels tree section, and no views.settings", () => {
    const m = projectsManifest as unknown as {
      kind?: string
      settings: {
        sections: Array<{ id: string; scope: string; adminScope?: string; blocks: any[] }>
      }
      views: Record<string, unknown>
    }
    expect(validateAppManifest(projectsManifest).success).toBe(true)
    expect(m.kind).toBe("app")
    expect(m.views.settings).toBeUndefined()
    expect(m.settings.sections).toEqual([
      expect.objectContaining({
        id: "ci",
        scope: "org",
        adminScope: "projects:settings:admin",
        blocks: [{ block: "connections", names: ["ci-source"] }],
      }),
      expect.objectContaining({
        id: "labels",
        scope: "org",
        adminScope: "projects:labels:admin",
        blocks: [
          {
            block: "tree",
            ops: {
              list: "labels.tree",
              create: "labels.create",
              update: "labels.update",
              reorder: "labels.reorder",
              archive: "labels.archive",
            },
            maxDepth: 2,
          },
        ],
      }),
      // Hours in a day and company days off, shown only once the org uses time and budgets.
      expect.objectContaining({
        id: "time",
        scope: "org",
        adminScope: "projects:settings:admin",
        feature: "time_budgets",
        blocks: [
          expect.objectContaining({ block: "field", key: "hoursPerDay", type: "number" }),
          expect.objectContaining({ block: "field", key: "daysOffCalendarId", type: "select" }),
          expect.objectContaining({
            block: "list",
            ops: { list: "days_off_list", create: "days_off_set", archive: "days_off_remove" },
          }),
        ],
      }),
    ])
  })
})
