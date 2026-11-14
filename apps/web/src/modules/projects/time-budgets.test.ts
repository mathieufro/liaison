// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  budgetFor,
  forgetBudget,
  loadBudget,
  readTaskTime,
  timeOn,
} from "~/modules/projects/time-budgets"

const apiAnswering = (answer: () => unknown) => ({ post: vi.fn(async () => answer()) }) as never

beforeEach(() => forgetBudget("p1"))

describe("timeOn", () => {
  it("reads the switch from the project payload, and an absent key is off", () => {
    expect(timeOn({ timeBudgets: true })).toBe(true)
    expect(timeOn({ timeBudgets: false })).toBe(false)
    expect(timeOn({})).toBe(false)
    expect(timeOn(null)).toBe(false)
  })

  it("a sales pipeline never reads as on", () => {
    expect(timeOn({ timeBudgets: true, kind: "pipeline" })).toBe(false)
  })
})

describe("tool answers", () => {
  it("planning_off, in the body or as an error, reads as off", async () => {
    expect(
      (
        await readTaskTime(
          apiAnswering(() => ({ code: "planning_off" })),
          "t1",
        )
      ).kind,
    ).toBe("off")
    const thrown = {
      post: vi.fn(async () => {
        throw new ApiError("off", 409, "planning_off")
      }),
    } as never
    expect((await readTaskTime(thrown, "t1")).kind).toBe("off")
  })

  it("another refusal keeps its code and sentence", async () => {
    const out = await readTaskTime(
      apiAnswering(() => ({ error: { code: "forbidden", message: "Nothing changed." } })),
      "t1",
    )
    expect(out).toEqual({ kind: "error", code: "forbidden", message: "Nothing changed." })
  })

  it("a budget that comes back off is dropped and the project is told", async () => {
    const onOff = vi.fn()
    await loadBudget(
      apiAnswering(() => ({ code: "planning_off" })),
      "p1",
      { onOff },
    )
    expect(onOff).toHaveBeenCalled()
    expect(budgetFor("p1")).toBeUndefined()
  })

  it("a failed read leaves an error state, not a broken project", async () => {
    const api = {
      post: vi.fn(async () => {
        throw new Error("network")
      }),
    } as never
    await loadBudget(api, "p1")
    expect(budgetFor("p1")?.status).toBe("error")
  })
})
