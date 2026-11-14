// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world's desks speak with the products world's prompts, the
// company's facts swapped: each prompt is within 0 to +5 tokens of its
// counterpart, on the same chars/4 ruler production compaction uses, so a
// bench or a walk compares the worlds on the same amount of instruction.
import { describe, expect, it } from "bun:test"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { DEMO_ROLE_AGENTS } from "~/seed/world/fiction"
import { SAAS_ROLE_AGENTS } from "./fiction"

/** Each desk and the products desk whose prompt it is built from. */
const COUNTERPARTS: ReadonlyArray<[saas: string, products: string]> = [
  ["@support", "@support"],
  ["@sales", "@operations"],
  ["@finance", "@finance"],
]

const promptOf = (
  agents: ReadonlyArray<{ handle: string; systemPrompt: string }>,
  handle: string,
) => {
  const agent = agents.find((a) => a.handle === handle)
  if (!agent) throw new Error(`no desk ${handle}`)
  return agent.systemPrompt
}

describe("software world desk prompts", () => {
  for (const [saas, products] of COUNTERPARTS) {
    it(`the ${saas} desk's prompt is within 0 to +5 tokens of the products ${products} desk's`, () => {
      const delta =
        estimateTokens(promptOf(SAAS_ROLE_AGENTS, saas)) -
        estimateTokens(promptOf(DEMO_ROLE_AGENTS, products))
      expect(delta).toBeGreaterThanOrEqual(0)
      expect(delta).toBeLessThanOrEqual(5)
    })
  }

  it("every desk of the world has a counterpart, and no prompt names the other company", () => {
    expect(SAAS_ROLE_AGENTS.map((a) => a.handle).sort()).toEqual(
      COUNTERPARTS.map(([saas]) => saas).sort(),
    )
    for (const agent of SAAS_ROLE_AGENTS) {
      expect(agent.systemPrompt).not.toContain("Resonant")
      expect(agent.systemPrompt).toContain("Tideform")
    }
  })
})
