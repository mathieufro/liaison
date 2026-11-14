// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A TAB WHOSE ID IS A RECORD NAMES ITS ENTITY. A turn sent from a tab learns which
// record is open by resolving the tab's id through the entity it names. A tab
// named for the page (`invoicing:detail`, `contacts:contact-detail`) resolved to
// nothing, so its turn said nothing about the open record and the agent picked one
// from earlier in the conversation. This walks every manifest in the tree.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { TABS_WHOSE_ID_IS_NOT_A_RECORD as NOT_A_RECORD } from "~/modules/agent/tools/open-targets"

const ROOT = join(import.meta.dir, "../../../../..")

interface Manifest {
  name: string
  entities?: Record<string, { tableName?: string; external?: boolean }>
  views?: {
    tabTypes?: Record<string, { urlPattern?: string; referenceable?: boolean; entity?: string }>
  }
}

function manifests(): Manifest[] {
  const out: Manifest[] = []
  for (const base of ["apps/api/src/apps", "bundled-apps"]) {
    for (const name of readdirSync(join(ROOT, base))) {
      try {
        out.push(JSON.parse(readFileSync(join(ROOT, base, name, "app.manifest.json"), "utf8")))
      } catch {
        // No manifest here.
      }
    }
  }
  return out
}

/** Kernel kinds reference-display.ts reads by name. */
const KERNEL_ENTITIES = new Set([
  "thread",
  "contact",
  "company",
  "approval_request",
  "routine",
  "skill",
])

describe("every tab whose id is a record resolves to an entity", () => {
  const all = manifests()
  const byName = new Map(all.map((m) => [m.name, m]))

  test("the walk found the apps it is about", () => {
    expect(byName.has("invoicing")).toBe(true)
    expect(byName.has("contacts")).toBe(true)
    expect(byName.has("boxtal")).toBe(true)
  })

  for (const m of all) {
    for (const [tab, decl] of Object.entries(m.views?.tabTypes ?? {})) {
      const qualified = `${m.name}:${tab}`
      const namesRecord = decl.referenceable === true || decl.urlPattern?.includes(":") === true
      if (!namesRecord || NOT_A_RECORD.has(qualified)) continue
      test(qualified, () => {
        const named = decl.entity ?? tab
        const sep = named.indexOf(":")
        const app = sep === -1 ? m.name : named.slice(0, sep)
        const entity = sep === -1 ? named : named.slice(sep + 1)
        const known =
          app === "kernel" ? KERNEL_ENTITIES.has(entity) : !!byName.get(app)?.entities?.[entity]
        expect(known).toBe(true)
      })
    }
  }
})
