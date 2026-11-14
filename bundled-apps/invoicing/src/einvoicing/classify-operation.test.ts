// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { bookingData } from "./booking"
import { bt23, operationCategory } from "./classify-operation"
import type { EinvCtx } from "./transmit"

describe("operationCategory", () => {
  test("goods, and shipping counts with goods", () => {
    expect(operationCategory([{ line_kind: "goods" }], { authoritative: true })).toEqual({
      category: "goods",
      source: "lines_authoritative",
    })
    expect(
      operationCategory([{ line_kind: "goods" }, { line_kind: "shipping" }], {
        authoritative: false,
      }),
    ).toEqual({
      category: "goods",
      source: "lines_default",
    })
    expect(operationCategory([{ line_kind: "shipping" }], { authoritative: true }).category).toBe(
      "goods",
    )
  })
  test("software is services", () => {
    expect(operationCategory([{ line_kind: "software" }], { authoritative: true }).category).toBe(
      "services",
    )
  })
  test("mixed", () => {
    expect(
      operationCategory([{ line_kind: "software" }, { line_kind: "goods" }], {
        authoritative: true,
      }).category,
    ).toBe("mixed")
    expect(
      operationCategory([{ line_kind: "software" }, { line_kind: "shipping" }], {
        authoritative: true,
      }).category,
    ).toBe("mixed")
  })
  test("empty -> null", () => {
    expect(operationCategory([], { authoritative: true })).toEqual({
      category: null,
      source: "lines_authoritative",
    })
    expect(operationCategory([], { authoritative: false })).toEqual({
      category: null,
      source: "lines_default",
    })
  })
  test("a missing line_kind is the goods default", () => {
    expect(operationCategory([{ line_kind: null }], { authoritative: false }).category).toBe(
      "goods",
    )
  })
})

describe("service lines", () => {
  test("a consulting line classifies as services, a goods line as before, and an old document re-reads unchanged", async () => {
    const authoritative = { authoritative: true }
    expect(operationCategory([{ line_kind: "service" }], authoritative).category).toBe("services")
    expect(
      operationCategory([{ line_kind: "service" }, { line_kind: "goods" }], authoritative).category,
    ).toBe("mixed")
    expect(
      operationCategory([{ line_kind: "service" }, { line_kind: "shipping" }], authoritative)
        .category,
    ).toBe("mixed")
    expect(operationCategory([{ line_kind: "goods" }], authoritative).category).toBe("goods")

    // The booking data of a stored document reads each line's kind: a document issued before the
    // service kind existed (goods, software, shipping, no kind) re-reads exactly as it did.
    const kinds = ["service", "software", "goods", "shipping", null, "service"] as const
    const db = createMockDb({
      seed: {
        document_lines: kinds.map((line_kind, position) => ({
          id: `line-${position}`,
          document_id: "doc-1",
          position,
          description: `Line ${position}`,
          quantity: "1",
          unit_price_minor: 1000,
          subtotal_minor: 1000,
          tax_minor: 200,
          tax_rate_bp: 2000,
          ...(line_kind ? { line_kind } : {}),
        })),
      },
    })
    const ctx = { db } as unknown as EinvCtx
    const data = await bookingData(ctx, {
      id: "doc-1",
      type: "invoice",
      number: "INV-2026-0001",
      issued_at: "2026-11-10",
      tax_treatment: "domestic",
    })
    expect(data.lines.map((l) => l.operation_category)).toEqual([
      "services",
      "services",
      "goods",
      "goods",
      "goods",
      "services",
    ])
  })
})

describe("bt23", () => {
  test("exactly nine codes", () => {
    const out = new Set<string>()
    for (const c of ["goods", "services", "mixed"] as const) {
      for (const p of ["due", "paid", "final_after_deposit"] as const) out.add(bt23(c, p))
    }
    expect([...out].sort()).toEqual(["B1", "B2", "B4", "M1", "M2", "M4", "S1", "S2", "S4"])
  })
  test("mapping", () => {
    expect(bt23("goods", "due")).toBe("B1")
    expect(bt23("services", "paid")).toBe("S2")
    expect(bt23("mixed", "final_after_deposit")).toBe("M4")
  })
})
