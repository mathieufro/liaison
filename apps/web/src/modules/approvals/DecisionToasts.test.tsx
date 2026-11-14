// SPDX-License-Identifier: FSL-1.1-ALv2
// Home approvals (owner, 2026-10-23): the row hid during the Undo window, then
// came BACK as "Approving…" while the decision ran, and the toast only said
// "Approved". The decision toast now names what was decided, carries it from
// countdown to done, and groups several decisions with their own Undo each.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DecisionToasts } from "~/modules/approvals/DecisionToasts"
import {
  DecisionQueueTestAccess,
  DecisionUndoneError,
  queueDecision,
  UNDO_WINDOW_MS,
} from "~/modules/approvals/decision-queue"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-1" }),
}))

function makeApi() {
  let answer: (v: unknown) => void = () => {}
  const post = vi.fn(() => new Promise((r) => (answer = r)))
  return { api: { post } as never, post, answer: (v: unknown) => answer(v) }
}

beforeEach(() => {
  vi.useFakeTimers()
  DecisionQueueTestAccess.reset()
})
afterEach(() => {
  cleanup()
  DecisionQueueTestAccess.reset()
  vi.useRealTimers()
})

const label = (n: number) => ({ title: `ticket-1088${n}: subject ${n}`, detail: "Reply" })

describe("DecisionToasts", () => {
  it("one decision: names it, counts down with Undo, then says it is approving and approved", async () => {
    const { api, answer } = makeApi()
    render(() => <DecisionToasts />)
    const done = queueDecision(api, "approval", "a1", { decision: "approve" }, { label: label(9) })
    const toast = await screen.findByTestId("decision-toast")
    expect(screen.getByTestId("decision-toast-title").textContent).toBe("ticket-10889: subject 9")
    expect(toast.textContent).toContain("Reply")
    expect(screen.getByTestId("decision-toast-status").textContent).toBe("Approving in 8s")
    // Fixed width: a long title truncates instead of stretching the toast across Home.
    expect(toast.className).toContain("w-[380px]")
    expect(toast.className).toContain("max-w-full")
    expect(screen.getByTestId("decision-toast-undo")).toBeTruthy()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(screen.getByTestId("decision-toast").dataset.phase).toBe("sending")
    expect(screen.getByTestId("decision-toast-status").textContent).toBe("Approving…")
    expect(screen.queryByTestId("decision-toast-undo")).toBeNull()
    expect(screen.getByTestId("decision-toast-spinner")).toBeTruthy()
    answer({ status: "approved" })
    await done
    expect(screen.getByTestId("decision-toast-status").textContent).toBe("Approved")
    expect(screen.getByTestId("decision-toast-done")).toBeTruthy()
  })

  it("Undo in the toast cancels the decision", async () => {
    const { api, post } = makeApi()
    render(() => <DecisionToasts />)
    const done = queueDecision(api, "approval", "a1", { decision: "deny" }, { label: label(1) })
    expect((await screen.findByTestId("decision-toast-status")).textContent).toBe("Rejecting in 8s")
    fireEvent.click(screen.getByTestId("decision-toast-undo"))
    await expect(done).rejects.toBeInstanceOf(DecisionUndoneError)
    expect(screen.queryByTestId("decision-toast")).toBeNull()
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(post).not.toHaveBeenCalled()
  })

  it("Dismiss on a stopped draft says Dismissing, then Dismissed, never Rejecting", async () => {
    const { api, post, answer } = makeApi()
    render(() => <DecisionToasts />)
    const done = queueDecision(
      api,
      "approval",
      "a1",
      { decision: "deny", reason: "" },
      { label: { ...label(5), verb: "dismiss" } },
    )
    expect((await screen.findByTestId("decision-toast-status")).textContent).toBe(
      "Dismissing in 8s",
    )
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(screen.getByTestId("decision-toast-status").textContent).toBe("Dismissing…")
    expect(post).toHaveBeenCalledTimes(1)
    answer({ status: "denied" })
    await done
    expect(screen.getByTestId("decision-toast-status").textContent).toBe("Dismissed")
  })

  it("a sequence is ONE toast, titled by its outcome and marked as N steps, whose Undo takes back every step", async () => {
    const { api, post } = makeApi()
    render(() => <DecisionToasts />)
    const done = queueDecision(
      api,
      "approval",
      "head",
      { decision: "approve" },
      {
        label: {
          title: "Reply to Lena Hart",
          detail: null,
          steps: ["Create the contact Lena Hart", "Create quote Q-12", "Reply to Lena Hart"],
        },
      },
    )
    await screen.findByTestId("decision-toast")
    // One item, never the first step's: the outcome, and that it is a sequence.
    expect(screen.queryByTestId("decision-toast-group")).toBeNull()
    expect(screen.getByTestId("decision-toast-title").textContent).toBe("Reply to Lena Hart")
    expect(screen.getByTestId("decision-toast-step-count").textContent).toBe("3 steps")
    expect(screen.getByTestId("decision-toast-step-1").textContent).toContain(
      "Create the contact Lena Hart",
    )
    expect(screen.getByTestId("decision-toast-step-3").textContent).toContain("Reply to Lena Hart")
    // The one Undo cancels the one decision: no step is sent.
    fireEvent.click(screen.getByTestId("decision-toast-undo"))
    await expect(done).rejects.toBeInstanceOf(DecisionUndoneError)
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS)
    expect(post).not.toHaveBeenCalled()
  })

  it("a single action shows no step count", async () => {
    const { api } = makeApi()
    render(() => <DecisionToasts />)
    void queueDecision(api, "approval", "a1", { decision: "approve" }, { label: label(2) }).catch(
      () => {},
    )
    await screen.findByTestId("decision-toast")
    expect(screen.queryByTestId("decision-toast-step-count")).toBeNull()
    expect(screen.queryByTestId("decision-toast-steps")).toBeNull()
  })

  it("several decisions group into one toast, each with its own Undo, and Undo all cancels the waiting ones", async () => {
    const { api } = makeApi()
    render(() => <DecisionToasts />)
    const a = queueDecision(api, "approval", "a1", { decision: "approve" }, { label: label(1) })
    const b = queueDecision(api, "approval", "a2", { decision: "approve" }, { label: label(2) })
    const c = queueDecision(api, "approval", "a3", { decision: "deny" }, { label: label(3) })
    await screen.findByTestId("decision-toast-group")
    expect(screen.queryByTestId("decision-toast")).toBeNull()
    expect(screen.getByTestId("decision-toast-group-title").textContent).toBe("3 decisions")
    expect(screen.getByTestId("decision-toast-group").className).toContain("w-[380px]")
    expect(screen.getByTestId("decision-toast-group-summary").textContent).toBe("3 waiting")
    expect(screen.getAllByTestId("decision-toast-row")).toHaveLength(3)
    // One row's Undo cancels only that one.
    fireEvent.click(screen.getAllByTestId("decision-toast-undo")[1] as HTMLElement)
    await expect(b).rejects.toBeInstanceOf(DecisionUndoneError)
    expect(screen.getByTestId("decision-toast-group-title").textContent).toBe("2 decisions")
    fireEvent.click(screen.getByTestId("decision-toast-undo-all"))
    await expect(a).rejects.toBeInstanceOf(DecisionUndoneError)
    await expect(c).rejects.toBeInstanceOf(DecisionUndoneError)
    expect(screen.queryByTestId("decision-toast-group")).toBeNull()
  })

  it("the group can be folded to its header", async () => {
    const { api } = makeApi()
    render(() => <DecisionToasts />)
    void queueDecision(api, "approval", "a1", { decision: "approve" }, { label: label(1) }).catch(
      () => {},
    )
    void queueDecision(api, "approval", "a2", { decision: "approve" }, { label: label(2) }).catch(
      () => {},
    )
    const toggle = await screen.findByTestId("decision-toast-group-toggle")
    fireEvent.click(toggle)
    expect(screen.queryAllByTestId("decision-toast-row")).toHaveLength(0)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
  })
})
