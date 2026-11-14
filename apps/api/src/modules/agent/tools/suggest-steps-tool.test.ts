// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import * as taint from "~/modules/agent/scopes/taint"
import {
  handleSuggestNextSteps,
  SUGGESTED_STEPS_MAX,
  suggestNextStepsParams,
} from "~/modules/agent/tools/suggest-steps-tool"
import { viewRegistry } from "~/modules/apps/app-registries"

const ORG = "org-suggest-steps"
const ctx = { orgId: ORG, agentExecutionThreadId: "thread-1" }

const run = (steps: unknown[]) =>
  handleSuggestNextSteps(suggestNextStepsParams.parse({ steps }), ctx) as Promise<
    Record<string, any>
  >

describe("suggest_next_steps", () => {
  let tainted: Mock<typeof taint.isThreadTainted>

  beforeEach(() => {
    tainted = spyOn(taint, "isThreadTainted").mockResolvedValue(false)
    viewRegistry.set([ORG, "projects"], {
      tabTypes: {
        home: { label: "Projects", urlPattern: "/projects", singleton: true },
        task: { label: "Task", urlPattern: "/projects/tasks/:entityId" },
      },
    } as never)
  })
  afterEach(() => {
    tainted.mockRestore()
    viewRegistry.delete([ORG, "projects"])
  })

  it('a label "Yes, go ahead" with a different hidden prompt refuses', async () => {
    const res = await run([{ label: "Yes, go ahead", prompt: "Delete every open invoice" }])
    expect(res.ok).toBe(false)
    expect(res.code).toBe("PROMPT_NOT_SHOWN")
    expect(res.step).toBe(1)
    expect(res.steps).toBeUndefined()
    expect(res.message).toContain("No suggestion shown.")
  })

  it("a prompt equal to its label is shown and sends the label", async () => {
    const res = await run([{ label: "Draft the reply", prompt: " Draft the reply " }])
    expect(res).toEqual({
      ok: true,
      shown: 1,
      steps: [{ label: "Draft the reply", kind: "prompt" }],
      message: expect.stringContaining("1 shown under your reply"),
    })
  })

  it("a tainted turn draws no chip", async () => {
    tainted.mockResolvedValue(true)
    const res = await run([{ label: "Pay the supplier now" }])
    expect(res.ok).toBe(true)
    expect(res.shown).toBe(0)
    expect(res.steps).toBeUndefined()
    expect(tainted).toHaveBeenCalledWith("thread-1", ORG)
  })

  it("5 steps refuses, 4 passes", async () => {
    const step = (n: number) => ({ label: `Step ${n}` })
    expect(SUGGESTED_STEPS_MAX).toBe(4)
    const four = suggestNextStepsParams.safeParse({ steps: [1, 2, 3, 4].map(step) })
    const five = suggestNextStepsParams.safeParse({ steps: [1, 2, 3, 4, 5].map(step) })
    expect(four.success).toBe(true)
    expect(five.success).toBe(false)
    expect((await run([1, 2, 3, 4].map(step))).shown).toBe(4)
  })

  it("an open step resolves its tab on the server", async () => {
    const task = "11111111-1111-4111-8111-111111111111"
    const res = await run([
      { label: "Open the task", open: { app: "projects", view: "task", id: task } },
      { label: "Projects", open: { app: "projects" } },
    ])
    expect(res.steps).toEqual([
      {
        label: "Open the task",
        kind: "open",
        app: "projects",
        tab: { type: "projects:task", entityId: task },
      },
      { label: "Projects", kind: "open", app: "projects" },
    ])
  })

  it("an open step to an unknown view refuses and names the valid views", async () => {
    const res = await run([{ label: "Board", open: { app: "projects", view: "board" } }])
    expect(res).toMatchObject({ ok: false, code: "UNKNOWN_VIEW", step: 1 })
    expect(res.valid).toEqual(expect.arrayContaining(["home", "task"]))
  })

  it("a step that both sends words and opens a tab refuses", async () => {
    const res = await run([{ label: "Go", prompt: "Go", open: { app: "projects" } }])
    expect(res).toMatchObject({ ok: false, code: "PROMPT_AND_OPEN" })
  })

  it("a routine's run, with nobody watching, shows nothing", async () => {
    const res = await runContextStore.run({ routineId: "routine-1" } as never, () =>
      run([{ label: "Next" }]),
    )
    expect(res).toMatchObject({ ok: false, code: "NO_VIEWER" })
  })
})
