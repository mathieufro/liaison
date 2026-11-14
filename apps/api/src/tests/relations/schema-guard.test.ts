// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { columnKey, type SchemaColumn, staleBaseline, unnamedReferences } from "./schema-guard"

const col = (column: string, over: Partial<SchemaColumn> = {}): SchemaColumn => ({
  schema: "kernel",
  table: "widgets",
  column,
  hasForeignKey: false,
  ...over,
})

describe("relation schema guard", () => {
  it("an unnamed _id column fails the guard", () => {
    expect(unnamedReferences([col("owner_id")], new Set(), new Set())).toEqual([
      "kernel.widgets.owner_id",
    ])
  })

  it("an unnamed foreign key fails the guard whatever its name", () => {
    expect(
      unnamedReferences([col("requested_by", { hasForeignKey: true })], new Set(), new Set()),
    ).toEqual(["kernel.widgets.requested_by"])
  })

  it("a column a link names, or the baseline holds, passes; plain columns are not references", () => {
    const cols = [col("owner_id"), col("parent_ids"), col("title"), col("id"), col("org_id")]
    expect(
      unnamedReferences(
        cols,
        new Set(["kernel.widgets.owner_id"]),
        new Set(["kernel.widgets.parent_ids"]),
      ),
    ).toEqual([])
  })

  it("a baseline entry a link now names, or that is gone, is stale", () => {
    const baseline = new Set(["kernel.widgets.owner_id", "kernel.widgets.gone_id"])
    expect(
      staleBaseline([col("owner_id")], new Set(["kernel.widgets.owner_id"]), baseline),
    ).toEqual(["kernel.widgets.gone_id", "kernel.widgets.owner_id"])
  })

  it("a test namespace's app schema reads as the app's schema", () => {
    expect(columnKey({ schema: "w3_app_tickets", table: "tickets", column: "contact_id" })).toBe(
      "app_tickets.tickets.contact_id",
    )
  })
})
