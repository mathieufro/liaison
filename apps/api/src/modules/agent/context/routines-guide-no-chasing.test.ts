// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Liaison never chases time, and time spent is optional: the guide that rides
// with create_routine and update_routine, whichever is loaded first, tells the
// agent to refuse a routine that asks people for their hours or lists who has
// not answered, to say why, and to offer what exists.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { normalizeAppGuide, parseGuideMarkdown } from "./app-guide"

const FILE = path.resolve(import.meta.dir, "../prompts/kernel/routines.md")
const RULE =
  "Never create a routine that asks people for their hours or lists who has not answered. Say no, say why, offer that a person can ask their own agent to reconcile."

describe("the routine tools carry the no-chasing rule", () => {
  const raw = readFileSync(FILE, "utf8")
  const front = /^tools:\s*(.+)$/m.exec(raw.split("---")[1] ?? "")?.[1] ?? ""
  const tools = front.split(",").map((t) => t.trim())
  const body = raw.split("---").slice(2).join("---")

  it("covers both routine tools with one guide", () => {
    expect(tools).toContain("kernel__create_routine")
    expect(tools).toContain("kernel__update_routine")
  })

  it("holds the rule in the part of the guide that always renders, not in a section", () => {
    const guide = normalizeAppGuide(parseGuideMarkdown(body, tools))
    expect(guide.core).toContain(RULE)
    expect(guide.sections.some((s) => s.text.includes(RULE))).toBe(false)
  })
})
