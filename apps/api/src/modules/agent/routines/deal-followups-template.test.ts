// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Deal follow-ups template: a weekday follow-up routine whose prompt is the
// one instruction block it pays for on every run, so its size is held to a
// budget, and whose options (quiet days, one pipeline) live in the prompt's call
// line, so a reset to the template keeps them.

import { describe, expect, it } from "bun:test"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  DEAL_FOLLOWUPS_TEMPLATE_KEY,
  dealFollowupOptions,
  dealFollowupOptionsOf,
  KERNEL_TEMPLATE_APP,
  registerKernelRoutineTemplates,
} from "~/modules/agent/routines/kernel-routine-templates"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-4000-8000-00000000d0f1"
const PIPELINE = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b"

function template() {
  registerKernelRoutineTemplates(ORG)
  const tpl = routineTemplateRegistry.get([ORG, KERNEL_TEMPLATE_APP, DEAL_FOLLOWUPS_TEMPLATE_KEY])
  if (!tpl) throw new Error("not registered")
  return tpl
}

function render(options: { quietDays?: unknown; pipelineId?: unknown }): string {
  const out = template().renderPrompt!(options)
  if ("error" in out) throw new Error(out.error)
  return out.prompt
}

describe("the deal follow-ups template", () => {
  it("is a weekday follow-up routine at 8 in the owner's timezone that only drafts", () => {
    const tpl = template()
    expect(tpl).toMatchObject({
      kind: "recurring",
      cron: "0 8 * * 1-5",
      followUp: true,
      enabledByDefault: false,
      sourceKind: "kernel",
    })
    expect(tpl.timezone).toBeUndefined()
  })

  it("its prompt stays within 350 tokens, with a pipeline named", () => {
    expect(estimateTokens(render({ quietDays: 365, pipelineId: PIPELINE }))).toBeLessThanOrEqual(
      350,
    )
  })

  it("its prompt never hands the model a send check of its own", () => {
    const prompt = render({})
    expect(prompt).toContain("Never pass sendGuard.")
    expect(prompt).toContain('{"refs": [{"kind": "projects:deal", "id": <taskId>}]}')
  })

  it("the options are written into the call line and read back from it", () => {
    const prompt = render({ quietDays: 10, pipelineId: PIPELINE })
    expect(prompt).toContain(
      `projects__deals_followup_candidates with {"quietDays":10,"projectId":"${PIPELINE}"}`,
    )
    expect(dealFollowupOptionsOf(prompt)).toEqual({ quietDays: 10, pipelineId: PIPELINE })
    expect(dealFollowupOptionsOf(render({}))).toEqual({ quietDays: 7, pipelineId: null })
    expect(dealFollowupOptionsOf("Write my morning brief.")).toBeNull()
  })

  it("quiet days are refused at 0 and 366 and kept at 1 and 365; a pipeline id must be an id", () => {
    expect(dealFollowupOptions({ quietDays: 0 })).toHaveProperty("error")
    expect(dealFollowupOptions({ quietDays: 1 })).toEqual({ quietDays: 1, pipelineId: null })
    expect(dealFollowupOptions({ quietDays: 365 })).toEqual({ quietDays: 365, pipelineId: null })
    expect(dealFollowupOptions({ quietDays: 366 })).toHaveProperty("error")
    expect(dealFollowupOptions({ quietDays: 2.5 })).toHaveProperty("error")
    expect(dealFollowupOptions({ pipelineId: "Sales" })).toEqual({
      error: "pipelineId is the id of a pipeline project.",
    })
  })
})
