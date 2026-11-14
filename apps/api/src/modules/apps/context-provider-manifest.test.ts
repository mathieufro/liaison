// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A context provider names one of its app's own tools that writes nothing, and
// a scope that tool requires; anything else is refused at registration.

import { describe, expect, it } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"

const manifest = (tool: Record<string, unknown>, scope = "ctx-app:items:read") => ({
  name: "ctx-app",
  version: "1.0.0",
  contextProviders: [{ on: ["tickets:ticket"], tool: "item_facts", scope }],
  tools: {
    item_facts: {
      description: "Facts about an item",
      requiredScopes: ["ctx-app:items:read"],
      handler: "item_facts",
      ...tool,
    },
  },
})

const errorOf = (m: unknown) => {
  const judged = validateAppManifest(m)
  return judged.success ? "" : judged.error
}

describe("context provider manifest rules", () => {
  it("accepts a read-only tool and one of its required scopes", () => {
    expect(errorOf(manifest({ readOnly: true }))).toBe("")
  })

  it("refuses a provider on a tool that is not readOnly", () => {
    expect(errorOf(manifest({}))).toContain("contextProviders[0].tool")
    expect(errorOf(manifest({ writesToTable: "app_ctx.items", readOnly: true }))).toContain(
      "must be declared readOnly",
    )
  })

  it("refuses a provider whose scope is not in the tool's requiredScopes", () => {
    expect(errorOf(manifest({ readOnly: true }, "ctx-app:items"))).toContain(
      "contextProviders[0].scope",
    )
  })
})
