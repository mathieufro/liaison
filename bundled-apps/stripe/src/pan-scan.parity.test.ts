// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bundled apps cannot import @liaison/shared, so the app carries a copy of the
// card and key mask. It must stay the same file byte for byte: a rule fixed in
// the shared mask is fixed here only when this copy is refreshed.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("card mask copy", () => {
  it("is byte for byte the shared mask", () => {
    const copy = readFileSync(join(import.meta.dir, "pan-scan.ts"), "utf8")
    const shared = readFileSync(
      join(import.meta.dir, "..", "..", "..", "packages", "shared", "src", "pan-scan.ts"),
      "utf8",
    )
    expect(copy).toBe(shared)
  })
})
