// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { formatDateTime } from "~/lib/relative-time"
import { openNotificationRoute } from "~/modules/notifications/open-route"
import { ApiContext } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { appHue } from "~/modules/shell/app-color"
import { markAttentionRead, openAttentionLink, openEntity } from "~/modules/shell/entity-opener"

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  openAttentionLink: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))

vi.mock("~/modules/notifications/open-route", () => ({
  openNotificationRoute: vi.fn(async () => true),
}))

import { handleWsCreate } from "~/modules/approvals/approvals-store"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { attentionStore } from "~/modules/shell/attention-store"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

// These tests pin each surface's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
})

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

function makeApi(post: any) {
  return {
    get: vi.fn(),
    post,
    patch: vi.fn(),
    delete: vi.fn(),
    getEnvelope: vi.fn(),
  } as any
}

describe("AttentionRow: a reply row quoting an agent's failure line", () => {
  it("renders it in the reader's language, never the provider's text", () => {
    const item: AttentionItem = {
      id: "kernel:thread_reply:t-9",
      app: "kernel",
      entity: "thread",
      entityId: "t-9",
      kind: "thread_reply",
      summary:
        "⚠️ I couldn't complete that response — the AI provider returned an error:\n\nYour project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend…",
      urgency: 30,
      occurredAt: "2026-09-23T10:00:00Z",
      action: { type: "open_entity", tabType: "kernel:thread", entityId: "t-9" },
    }
    const { getByTestId } = render(() => (
      <I18nProvider initialLocale="fr">
        <ApiContext.Provider value={makeApi(vi.fn())}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    const text = getByTestId("attention-row-kernel-thread-t-9").textContent ?? ""
    expect(text).toContain("plafond de dépenses atteint")
    expect(text).not.toContain("ai.studio")
  })
})

describe("AttentionRow: a message in a task's comments", () => {
  const TASK = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  const item: AttentionItem = {
    id: "kernel:mention:t-7",
    app: "kernel",
    entity: "thread",
    entityId: "t-7",
    kind: "mention",
    summary: "Maxime mentioned you",
    urgency: 60,
    occurredAt: "2026-11-04T10:00:00Z",
    action: { type: "open_entity", tabType: "kernel:thread", entityId: "t-7" },
    metadata: {
      messageId: "m-3",
      threadAnchor: {
        app: "projects",
        entityType: "task",
        entityId: TASK,
        kindLabel: "Task",
        label: "Fix the login page",
        secondaryLabel: "Website",
      },
    },
  }
  const renderRow = (locale: "en" | "fr") =>
    render(() => (
      <I18nProvider initialLocale={locale}>
        <ApiContext.Provider value={makeApi(vi.fn())}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      </I18nProvider>
    ))

  it("names the task the conversation belongs to", () => {
    const { getByTestId } = renderRow("en")
    expect(getByTestId("attention-row-kernel-thread-t-7-anchor").textContent).toBe(
      "Task: Fix the login page · Website",
    )
  })

  it("names it in the reader's language", () => {
    const { getByTestId } = renderRow("fr")
    expect(getByTestId("attention-row-kernel-thread-t-7-anchor").textContent).toBe(
      "Tâche: Fix the login page · Website",
    )
  })

  it("opens the task on the message, never the bare thread", () => {
    vi.mocked(openNotificationRoute).mockClear()
    vi.mocked(openEntity).mockClear()
    const { getByTestId } = renderRow("en")
    fireEvent.click(getByTestId("attention-row-kernel-thread-t-7"))
    expect(openNotificationRoute).toHaveBeenCalledWith(
      `attention/projects/task/${TASK}?thread=t-7&message=m-3`,
      expect.anything(),
    )
    expect(openEntity).not.toHaveBeenCalled()
    expect(markAttentionRead).toHaveBeenCalledWith(expect.anything(), "kernel", "thread", "t-7")
  })

  it("a plain conversation's row has no entity line", () => {
    const { metadata: _m, ...plain } = item
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={{ ...plain, metadata: { messageId: "m-3" } }} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-thread-t-7-anchor")).toBeNull()
  })
})

describe("AttentionRow: a computer session's notice (S16)", () => {
  const notice = (body: unknown): AttentionItem => ({
    id: "kernel:node_session:s-1",
    app: "kernel",
    entity: "node_session",
    entityId: "s-1",
    kind: "node_session_needs_you" as AttentionItem["kind"],
    summary: "Fix the build needs you",
    urgency: 60,
    occurredAt: "2026-10-15T10:00:00Z",
    action: { type: "open_entity", tabType: "kernel:session", entityId: "s-1" },
    metadata: { link: { tabType: "kernel:session", entityId: "s-1" }, body },
  })
  const renderRow = (item: AttentionItem) =>
    render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))

  it("S16: the row shows the session's words from metadata.body, plain text and bounded", () => {
    const words = `Which branch should I push to? <img src=x onerror=alert(1)> ${"x".repeat(900)}`
    const { getByTestId } = renderRow(notice(`Fix the build needs you\nThe session says: ${words}`))
    const body = getByTestId("attention-row-kernel-node_session-s-1-body")
    expect(
      body.textContent?.startsWith("The session says: Which branch should I push to? <img"),
    ).toBe(true)
    // Plain text: the markup is text, never an element.
    expect(body.querySelector("img")).toBeNull()
    // Bounded, and the fixed line (the title) is not repeated.
    expect(Array.from(body.textContent ?? "").length).toBeLessThanOrEqual(400)
    expect(body.textContent).not.toContain("Fix the build needs you")
  })

  it("S16: no body line when metadata.body is absent, only the fixed line, or not text", () => {
    for (const body of [undefined, "Fix the build needs you", 42]) {
      const { queryByTestId, unmount } = renderRow(notice(body))
      expect(queryByTestId("attention-row-kernel-node_session-s-1-body")).toBeNull()
      unmount()
    }
  })
})

describe("AttentionRow", () => {
  // Sales walk 2026-10-27: the scenario sends the visitor to Home to decide
  // the routine's requests; each step rings its request's row by the tool it
  // runs, as it rings a card by its `data-tool-name`.
  it("an approval row says which tool its request runs; another row says none", () => {
    const approval: AttentionItem = {
      id: "kernel:approval_pending:wf",
      app: "kernel",
      entity: "approval_request",
      entityId: "wf",
      kind: "approval_pending",
      summary: "Read northwind.example",
      urgency: 60,
      occurredAt: "2026-10-27T10:00:00Z",
      action: { type: "decide_approval", approvalId: "wf" },
      metadata: { toolName: "kernel:web_fetch" },
    }
    const { getByTestId, unmount } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={approval} />
      </ApiContext.Provider>
    ))
    expect(
      getByTestId("attention-row-kernel-approval_request-wf").getAttribute("data-tool-name"),
    ).toBe("kernel:web_fetch")
    unmount()
    const other = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow
          item={{
            ...approval,
            id: "kernel:thread_reply:t1",
            entity: "thread",
            entityId: "t1",
            kind: "thread_reply",
            action: { type: "open_entity", tabType: "thread", entityId: "t1" },
          }}
        />
      </ApiContext.Provider>
    ))
    expect(
      other.getByTestId("attention-row-kernel-thread-t1").getAttribute("data-tool-name"),
    ).toBeNull()
  })

  it("a wedged approval (approved, outcome unknown) offers no Approve/Reject and no countdown", () => {
    const item: AttentionItem = {
      id: "kernel:approval_pending:r3",
      app: "kernel",
      entity: "approval_request",
      entityId: "r3",
      kind: "approval_pending",
      summary: "Stalled: Remediation: delete rgpd customer",
      urgency: 95,
      occurredAt: "2026-07-07T10:00:00Z",
      action: { type: "decide_approval", approvalId: "r3" },
      metadata: {
        wedged: true,
        expiresInSeconds: 0,
        subtitle: "Pending approval",
        failureReason: "App execution timed out",
        summaryLines: ['{"hub_id":"h-1","customer_id":"c-12"}'],
        actionLabel: "Remediation: delete rgpd customer",
      },
    }
    const { queryByTestId, getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const id = "attention-row-kernel-approval_request-r3"
    expect(queryByTestId(`${id}-approve`)).toBeNull()
    expect(queryByTestId(`${id}-reject`)).toBeNull()
    expect(queryByTestId(`${id}-metric`)).toBeNull()
    // Still expandable into the card, which carries the close-out.
    expect(getByTestId(`${id}-details`)).toBeTruthy()
    const text = getByTestId(id).textContent ?? ""
    expect(text).not.toContain('{"hub_id"')
    expect(text).toContain("hub_id: h-1")
    expect(text).not.toContain("Pending approval")
    // Says why it stalled on the row, not only in the logs.
    expect(getByTestId(`${id}-last-failure`).textContent).toContain("App execution timed out")
  })

  it("a decision dropped at boot as too old says on its row that it was not sent", () => {
    const item: AttentionItem = {
      id: "kernel:approval_pending:old1",
      app: "kernel",
      entity: "approval_request",
      entityId: "old1",
      kind: "approval_pending",
      summary: "Reply to the customer",
      urgency: 50,
      occurredAt: "2026-07-07T10:00:00Z",
      action: { type: "decide_approval", approvalId: "old1" },
      metadata: { subtitle: "Pending approval", actionLabel: "Reply to the customer" },
    }
    const { queryByTestId, getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const id = "attention-row-kernel-approval_request-old1"
    expect(queryByTestId(`${id}-not-sent`)).toBeNull()
    DecisionQueueTestAccess.markNotSent("approval", "old1")
    expect(getByTestId(`${id}-not-sent`).textContent).toBe(
      "Not sent: this decision was more than 15 minutes old. Decide again.",
    )
  })

  it("a notification about this approval opens its card and scrolls it into view (LIF-18)", async () => {
    const { focusApproval, focusedApproval } = await import("~/modules/shell/approval-focus")
    const item: AttentionItem = {
      id: "kernel:approval_pending:f1",
      app: "kernel",
      entity: "approval_request",
      entityId: "f1",
      kind: "approval_pending",
      summary: "Reply to customer",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "f1" },
      metadata: { requestHandle: "request-7" },
    }
    const scroll = vi.fn()
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scroll
    try {
      const { getByTestId } = render(() => (
        <ApiContext.Provider value={makeApi(vi.fn())}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      ))
      const details = getByTestId("attention-row-kernel-approval_request-f1-details")
      expect(details.getAttribute("aria-expanded")).toBe("false")
      focusApproval("other")
      expect(details.getAttribute("aria-expanded")).toBe("false")
      focusApproval("f1")
      await vi.waitFor(() => expect(details.getAttribute("aria-expanded")).toBe("true"))
      await vi.waitFor(() => expect(scroll).toHaveBeenCalled())
      expect(focusedApproval()).toBeNull()
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it("attention-row.approval prints the request-N handle on the collapsed row, the uuid on hover", () => {
    // The agent says "approve request-42"; the collapsed feed row must show
    // it. The uuid prefix used to print next to it and read as noise on every
    // row — it now lives on the title (hover) and in the expanded card.
    const item: AttentionItem = {
      id: "kernel:approval_pending:3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab",
      app: "kernel",
      entity: "approval_request",
      entityId: "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab",
      kind: "approval_pending",
      summary: "Reply to customer",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab" },
      metadata: { requestHandle: "request-42" },
    }
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const ref = getByTestId(
      "attention-row-kernel-approval_request-3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab-ref",
    )
    expect(ref.textContent).toBe("request-42")
    expect(ref.getAttribute("title")).toBe("3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab")
  })

  it("attention-row.approval shows WHAT changes and WHO asked, without opening the card", () => {
    // "Update status column: backlog" in a project told the reviewer nothing
    // about what the column would become; the summarizer had written it.
    const item: AttentionItem = {
      id: "kernel:approval_pending:l1",
      app: "kernel",
      entity: "approval_request",
      entityId: "l1",
      kind: "approval_pending",
      summary: "Update status column: backlog",
      urgency: 60,
      occurredAt: "2026-09-09T00:00:00Z",
      action: { type: "decide_approval", approvalId: "l1" },
      metadata: {
        requestHandle: "request-78",
        subtitle: "In Roadmap Produit 2026",
        summaryLines: ["Label -> Idea", 7, "Color -> #fff"],
        requesterName: "Dana Girard",
        actionLabel: "Projects: update status",
        approvalImpact: "internal",
      },
    }
    const { getByTestId, getAllByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const lines = getByTestId("attention-row-kernel-approval_request-l1-lines")
    expect(Array.from(lines.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "Label -> Idea",
      "Color -> #fff",
    ])
    expect(getByTestId("attention-row-kernel-approval_request-l1-requester").textContent).toContain(
      "by Dana Girard",
    )
    expect(getByTestId("attention-row-kernel-approval_request-l1-subtitle").textContent).toBe(
      "In Roadmap Produit 2026",
    )
    // The uuid prefix and the "Approvals" app label are gone from the meta line.
    expect(getAllByTestId("attention-row-kernel-approval_request-l1-ref")[0]!.textContent).toBe(
      "request-78",
    )
  })

  it("attention-row.approval lists a sequence's steps in order, in place of the outcome's lines", () => {
    const item: AttentionItem = {
      id: "kernel:approval_pending:s1",
      app: "kernel",
      entity: "approval_request",
      entityId: "s1",
      kind: "approval_pending",
      summary: "Re: 40 Kestrel 6 for our studios",
      urgency: 60,
      occurredAt: "2026-09-09T00:00:00Z",
      action: { type: "decide_approval", approvalId: "s1" },
      metadata: {
        toolName: "api-connector:connector_write",
        outcomeToolName: "mail:reply",
        subtitle: "Reply to Inês Duarte via sales@example.com",
        summaryLines: ["To: ines@example.org"],
        bundleSteps: 3,
        bundleSequence: [
          {
            toolName: "api-connector:connector_write",
            title: "Create contact in CRM: Inês Duarte",
          },
          {
            toolName: "invoicing:quote_create_and_issue",
            title: "Issue quote for Northwind Acoustics",
          },
          { toolName: "mail:reply", title: "Re: 40 Kestrel 6 for our studios" },
        ],
      },
    }
    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const seq = getByTestId("attention-row-kernel-approval_request-s1-sequence")
    expect(Array.from(seq.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "1. Create contact in CRM: Inês Duarte",
      "2. Issue quote for Northwind Acoustics",
      "3. Re: 40 Kestrel 6 for our studios",
    ])
    expect(queryByTestId("attention-row-kernel-approval_request-s1-lines")).toBeNull()
    expect(getByTestId("attention-row-kernel-approval_request-s1-subtitle").textContent).toBe(
      "Reply to Inês Duarte via sales@example.com",
    )
  })

  it("attention-row.decide-in-context offers exactly ONE Open ticket button", () => {
    // Both the always-visible button and the generic Open button rendered
    // for these rows, each labelled "Open ticket" (screenshot 2026-09-09).
    const item: AttentionItem = {
      id: "kernel:approval:dup",
      app: "tickets",
      entity: "ticket",
      entityId: "tk-dup",
      kind: "approval_pending",
      summary: "Reply to customer",
      urgency: 60,
      occurredAt: "2026-08-05T00:00:00Z",
      action: { type: "decide_approval", approvalId: "dup" },
      metadata: { decideInContext: true, actionLabel: "Tickets: reply" },
    }
    const { container } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const buttons = Array.from(container.querySelectorAll("button")).filter((b) =>
      b.textContent?.includes("Open ticket"),
    )
    expect(buttons).toHaveLength(1)
  })

  it("attention-row.decide-approve calls /approvals/:id/decide", async () => {
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:a1",
      app: "kernel",
      entity: "approval_request",
      entityId: "a1",
      kind: "approval_pending",
      summary: "Approve me",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a1" },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a1-approve"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post).toHaveBeenCalledWith(
      "/approvals/a1/decide",
      { decision: "approve" },
      { suppressGlobalError: true },
    )
  })

  // Fabrikam, 2026-10-01: a bare decision on a sealed mail send is refused (409
  // mailbox_fulfilment_required) and read "decided by someone else". A mail
  // send is approved through its card, which decrypts the draft first.
  it("attention-row.decide-approve on a mail send opens the card instead of posting", async () => {
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:m1",
      app: "kernel",
      entity: "approval_request",
      entityId: "m1",
      kind: "approval_pending",
      summary: "Compose to someone",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      metadata: { toolName: "mail:compose" },
      action: { type: "decide_approval", approvalId: "m1" },
    }
    const api = makeApi(post)
    api.get.mockResolvedValue(undefined)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-m1-approve"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()
    expect(getByTestId("attention-row-kernel-approval_request-m1-expanded")).toBeTruthy()
  })

  // Field report (2026-11-09): a whole approval row folded on any click, with a
  // hand cursor everywhere, so nobody could select a request's text to copy it.
  it("an approval row: a click that ends a text selection does not fold it; the chevron and a plain click do", async () => {
    const item: AttentionItem = {
      id: "kernel:approval_pending:sel1",
      app: "kernel",
      entity: "approval_request",
      entityId: "sel1",
      kind: "approval_pending",
      summary: "Reply to customer about the delayed parcel",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "sel1" },
      metadata: { requestHandle: "request-8" },
    }
    const api = makeApi(vi.fn())
    api.get.mockResolvedValue(undefined)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const tid = "attention-row-kernel-approval_request-sel1"
    const row = getByTestId(tid)
    const details = getByTestId(`${tid}-details`)
    // Text, not a hand: the row is not one big button.
    expect(row.classList.contains("cursor-pointer")).toBe(false)

    // The person selects the title's text and lets go: the row stays as it was.
    const title = getByTestId(`${tid}-title`)
    const range = document.createRange()
    range.selectNodeContents(title)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(window.getSelection()?.toString()).toContain("delayed parcel")
    fireEvent.click(title)
    expect(details.getAttribute("aria-expanded")).toBe("false")

    // Nothing selected: a plain click on the row still unfolds it, the chevron folds it back.
    window.getSelection()?.removeAllRanges()
    fireEvent.click(title)
    expect(details.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(details)
    expect(details.getAttribute("aria-expanded")).toBe("false")
  })

  // Regression (prod, 2026-08-04): decide() had a bare `catch {}`, so a rejected
  // approve reset the button and reported NOTHING. Boxtal was refusing shipment
  // creation with InvalidPaymentException, the kernel returned that reason in
  // the 422, and the operator saw a dead Approve button and clicked it five
  // times in nine seconds. The upstream cause lives at details.details.message;
  // the top-level `message` is only the opaque code.
  it("attention-row.decide surfaces the upstream cause when the handler fails", async () => {
    const err = new ApiError("handler_failed", 422, "handler_failed", undefined, {
      code: "validation",
      details: {
        code: "validation",
        message:
          'Boxtal rejected the shipment (422): {"errors":[{"code":"InvalidPaymentException"}]}',
      },
    })
    resetToastStore()
    const post = vi.fn().mockRejectedValue(err)
    const item: AttentionItem = {
      id: "kernel:approval:a9",
      app: "kernel",
      entity: "approval_request",
      entityId: "a9",
      kind: "approval_pending",
      summary: "Ship it",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a9" },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a9-approve"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const messages = toasts().map((t) => t.message)
    expect(messages.some((m) => m.includes("InvalidPaymentException"))).toBe(true)
  })

  // Demo walk: a Shopify discount and a social reply refused with no effect went
  // back to pending, and once the toast faded their rows showed nothing, while
  // mail and ticket approvals (decided from the open card) kept a banner.
  it("attention-row.decide keeps a no-effect failure on the row after the toast", async () => {
    resetToastStore()
    const err = new ApiError("handler_failed", 422, "handler_failed", undefined, {
      code: "DEMO_RESTRICTED",
      details: { code: "DEMO_RESTRICTED", message: "This is a demo: nothing was sent." },
    })
    const post = vi.fn().mockRejectedValue(err)
    const item: AttentionItem = {
      id: "kernel:approval:a12",
      app: "kernel",
      entity: "approval_request",
      entityId: "a12",
      kind: "approval_pending",
      summary: "Shopify: create discount",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a12" },
    }
    const api = makeApi(post)
    const { getByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-approval_request-a12-last-failure")).toBeNull()
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a12-approve"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    resetToastStore()
    expect(
      getByTestId("attention-row-kernel-approval_request-a12-last-failure").textContent,
    ).toContain("This is a demo: nothing was sent.")
  })

  it("attention-row shows the recorded last failure the feed item carries", () => {
    const item: AttentionItem = {
      id: "kernel:approval:a13",
      app: "kernel",
      entity: "approval_request",
      entityId: "a13",
      kind: "approval_pending",
      summary: "Social: reply to finding",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a13" },
      metadata: {
        lastFailure: { code: "DEMO_RESTRICTED", message: "Posting is off in the demo.", at: "x" },
      },
    }
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const banner = getByTestId("attention-row-kernel-approval_request-a13-last-failure")
    expect(banner.textContent).toContain("Last attempt failed:")
    expect(banner.textContent).toContain("Posting is off in the demo.")
  })

  // Regression (prod, ticket-10197 / ticket-10200): two "Stalled: Knowledge:
  // update" rows could not be cleared. Approve returned 409 "just decided by
  // someone else" — a TERMINAL state — but only the success path reloaded the
  // feed, so the dead row stayed on screen under the toast and took the same
  // click again and again.
  it.each([
    [409, "conflict"],
    [404, "not_found"],
  ])(
    "attention-row.decide reloads the feed when decide fails %i (terminal)",
    async (status, code) => {
      resetToastStore()
      const reload = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
      const post = vi.fn().mockRejectedValue(new ApiError(code, status, code))
      const item: AttentionItem = {
        id: "kernel:approval:a10",
        app: "kernel",
        entity: "approval_request",
        entityId: "a10",
        kind: "approval_pending",
        summary: "Knowledge: update",
        urgency: 60,
        occurredAt: "2026-05-06T00:00:00Z",
        action: { type: "decide_approval", approvalId: "a10" },
      }
      const api = makeApi(post)
      const { getByTestId } = render(() => (
        <ApiContext.Provider value={api}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      ))
      fireEvent.click(getByTestId("attention-row-kernel-approval_request-a10-approve"))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(reload).toHaveBeenCalled()
      reload.mockRestore()
    },
  )

  // Control: a RETRYABLE failure must NOT reload — the row is still live and
  // reloading would throw away an inline reason the operator had open.
  it("attention-row.decide does NOT reload the feed on a retryable handler failure", async () => {
    resetToastStore()
    const reload = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    const post = vi.fn().mockRejectedValue(new ApiError("handler_failed", 422, "handler_failed"))
    const item: AttentionItem = {
      id: "kernel:approval:a11",
      app: "kernel",
      entity: "approval_request",
      entityId: "a11",
      kind: "approval_pending",
      summary: "Ship it",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a11" },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a11-approve"))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(reload).not.toHaveBeenCalled()
    reload.mockRestore()
  })

  it("attention-row.decide-reject opens reason input then submits", async () => {
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:a2",
      app: "kernel",
      entity: "approval_request",
      entityId: "a2",
      kind: "approval_pending",
      summary: "Reject me",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a2" },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a2-reject"))
    const input = getByTestId(
      "attention-row-kernel-approval_request-a2-reject-reason",
    ) as HTMLInputElement
    fireEvent.input(input, { target: { value: "duplicate" } })
    fireEvent.click(getByTestId("attention-row-kernel-approval_request-a2-reject-submit"))
    await Promise.resolve()
    await Promise.resolve()
    expect(post).toHaveBeenCalledWith(
      "/approvals/a2/decide",
      { decision: "deny", reason: "duplicate" },
      { suppressGlobalError: true },
    )
  })

  it("attention-row.action-chip takes its app's colour, whatever the impact; kernel is neutral", () => {
    const baseItem = (id: string, metadata: Record<string, unknown>): AttentionItem => ({
      id: `kernel:approval:${id}`,
      app: "kernel",
      entity: "approval_request",
      entityId: id,
      kind: "approval_pending",
      summary: "Bug Report: tessera_lab V.2.0.82",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: id },
      metadata,
    })
    const api = makeApi(vi.fn())
    const chip = (id: string, metadata: Record<string, unknown>): HTMLElement => {
      const r = render(() => (
        <ApiContext.Provider value={api}>
          <AttentionRow item={baseItem(id, metadata)} />
        </ApiContext.Provider>
      ))
      return r.getByTestId(`attention-row-kernel-approval_request-${id}-action-chip`)
    }

    const external = chip("ax", {
      actionLabel: "Tickets: reply",
      toolName: "tickets:reply",
      approvalImpact: "external",
    })
    expect(external.textContent).toBe("Tickets: reply")
    expect(external).toHaveAttribute("data-app", "tickets")
    expect(external).toHaveAttribute("data-impact", "external")
    expect(external.style.getPropertyValue("--app-pill-fg-light")).toBe(
      `hsl(${appHue("tickets")} 55% 28%)`,
    )
    // Colour names the app, never the risk: no amber on an external action.
    expect(external.className).not.toContain("text-warning")

    // Same app, internal impact: the same colour.
    const internal = chip("ay", {
      actionLabel: "Tickets: close",
      toolName: "tickets:close",
      approvalImpact: "internal",
    })
    expect(internal).toHaveAttribute("data-impact", "internal")
    expect(internal.style.getPropertyValue("--app-pill-fg-light")).toBe(
      external.style.getPropertyValue("--app-pill-fg-light"),
    )

    const shopify = chip("as", {
      actionLabel: "Shopify: create discount",
      toolName: "shopify:create_discount",
    })
    expect(shopify).toHaveAttribute("data-app", "shopify")
    expect(shopify.style.getPropertyValue("--app-pill-fg-light")).toBe(
      `hsl(${appHue("shopify")} 55% 28%)`,
    )

    const kernel = chip("ak", {
      actionLabel: "Kernel: update skill",
      toolName: "kernel:update_skill",
    })
    expect(kernel).toHaveAttribute("data-app-tone", "system")
    expect(kernel.className).not.toContain("app-pill")
  })

  it("attention-row.action-chip absent without actionLabel (older cached items)", () => {
    const api = makeApi(vi.fn())
    const item: AttentionItem = {
      id: "kernel:approval:a9",
      app: "kernel",
      entity: "approval_request",
      entityId: "a9",
      kind: "approval_pending",
      summary: "Approve me",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a9" },
    }
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-approval_request-a9-action-chip")).toBeNull()
  })

  it("attention-row.action-chip leads the title line, not the meta line", () => {
    const api = makeApi(vi.fn())
    const item: AttentionItem = {
      id: "kernel:approval:chip-order",
      app: "kernel",
      entity: "approval_request",
      entityId: "chip-order",
      kind: "approval_pending",
      summary: "Approve the refund for order 9981",
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "chip-order" },
      metadata: { actionLabel: "Boxtal: refund", approvalImpact: "external" },
    }
    const { getByTestId, container } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))

    const chip = getByTestId("attention-row-kernel-approval_request-chip-order-action-chip")
    const refChip = getByTestId("attention-row-kernel-approval_request-chip-order-ref")

    // The chip sits inside the title span (line-clamped with the summary),
    // ahead of the summary text, not down in the quiet meta line with the
    // request ref.
    const titleSpan = container.querySelector('[title="Approve the refund for order 9981"]')
    expect(titleSpan).not.toBeNull()
    expect(titleSpan?.contains(chip)).toBe(true)
    expect(refChip.contains(chip)).toBe(false)

    const summaryText = titleSpan?.textContent ?? ""
    expect(summaryText.indexOf("Boxtal: refund")).toBeLessThan(
      summaryText.indexOf("Approve the refund for order 9981"),
    )
  })

  // On the demo box four kinds rendered a badge, a handle and NO title: their
  // summary was the humanized tool name, which is the badge's own words, so the
  // row folded the duplicate away and left the line empty of content. The
  // server now names them from the payload; this pins that the row draws it.
  it.each([
    ["Kernel: update skill", "Update skill: shipment-exception"],
    ["Kernel: contacts merge", "Contacts merge: Lena Vos and L. Vos"],
    ["Invoicing: record document refund", "Record document refund: INV-2026-0418"],
    ["Shopify: create discount", "Create discount: TEACHING26"],
  ])("attention-row.title renders beside the %s badge", (actionLabel, summary) => {
    // The phone row is where the empty title line was seen.
    const realMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query === PHONE_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    syncShellTier()
    const api = makeApi(vi.fn())
    const item: AttentionItem = {
      id: "kernel:approval:titled",
      app: "kernel",
      entity: "approval_request",
      entityId: "titled",
      kind: "approval_pending",
      summary,
      urgency: 60,
      occurredAt: "2026-05-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "titled" },
      metadata: { actionLabel, approvalImpact: "internal" },
    }
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const title = getByTestId("attention-row-kernel-approval_request-titled-title")
    expect(title.textContent).toBe(summary)
    expect(title.textContent).not.toBe(actionLabel)
    window.matchMedia = realMatchMedia
    syncShellTier()
  })

  it("attention-row.open-url refuses anything but an http(s) URL", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    for (const url of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>"]) {
      const item: AttentionItem = {
        id: "kernel:agent_notification:bad",
        app: "kernel",
        entity: "agent_notification",
        entityId: "bad",
        kind: "agent_notification",
        summary: "Bad link",
        urgency: 40,
        occurredAt: "2026-05-06T00:00:00Z",
        action: { type: "open_url", url },
      }
      const { getByTestId, unmount } = render(() => (
        <ApiContext.Provider value={makeApi(vi.fn().mockResolvedValue({}))}>
          <AttentionRow item={item} />
        </ApiContext.Provider>
      ))
      fireEvent.click(getByTestId("attention-row-kernel-agent_notification-bad-open"))
      unmount()
    }
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it("attention-row.open-url opens the external URL and clears the row", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null)
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "shopify:order:9001",
      app: "shopify",
      entity: "order",
      entityId: "9001",
      kind: "system_alert",
      summary: "New order #1234",
      urgency: 40,
      occurredAt: "2026-05-06T00:00:00Z",
      action: {
        type: "open_url",
        url: "https://acme.myshopify.com/admin/orders/9001",
        label: "Open in Shopify",
      },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId("attention-row-shopify-order-9001-open"))
    expect(openSpy).toHaveBeenCalledWith(
      "https://acme.myshopify.com/admin/orders/9001",
      "_blank",
      "noopener,noreferrer",
    )
    // entity-opener is module-mocked in this file, so assert the mock rather
    // than the api call it would have made.
    expect(vi.mocked(markAttentionRead)).toHaveBeenCalledWith(
      expect.anything(),
      "shopify",
      "order",
      "9001",
    )
    openSpy.mockRestore()
  })

  // A customer-facing ticket reply cannot be judged from a feed row, so its
  // card offers only a way into the ticket. Declared per tool via
  // `decideInContext` and carried on the attention metadata.
  it("attention-row.decide-in-context hides approve/reject and offers Open instead", () => {
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:a7",
      app: "tickets",
      entity: "ticket",
      entityId: "tk-7",
      kind: "approval_pending",
      summary: "Reply to customer",
      urgency: 60,
      occurredAt: "2026-08-05T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a7" },
      metadata: { decideInContext: true, actionLabel: "Tickets: reply" },
    }
    const api = makeApi(post)
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-tickets-ticket-tk-7-approve")).toBeNull()
    expect(queryByTestId("attention-row-tickets-ticket-tk-7-reject")).toBeNull()
    // The withheld card must not be reachable via the details chevron either.
    expect(queryByTestId("attention-row-tickets-ticket-tk-7-details")).toBeNull()
    expect(queryByTestId("attention-row-tickets-ticket-tk-7-open")).not.toBeNull()
  })

  // Control: an ordinary approval WITHOUT the flag keeps inline decide.
  it("attention-row keeps approve/reject for an approval without decideInContext", () => {
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:a8",
      app: "boxtal",
      entity: "approval_request",
      entityId: "a8",
      kind: "approval_pending",
      summary: "Create shipment",
      urgency: 60,
      occurredAt: "2026-08-05T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a8" },
      metadata: { actionLabel: "Boxtal: create shipment" },
    }
    const api = makeApi(post)
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-boxtal-approval_request-a8-approve")).not.toBeNull()
  })

  // Reported 2026-08-06: "Open" on a ticket-reply approval opened the agent's
  // working thread (the approval entity), which is useless for judging a
  // customer reply. It must open the ACTUAL ticket, resolved by the backend
  // into metadata.openTarget, and say so.
  it("attention-row.decide-in-context opens the real ticket, labelled Open ticket", () => {
    const openEntityCalls: unknown[][] = []
    vi.mocked(openEntity).mockImplementation((async (...args: unknown[]) => {
      openEntityCalls.push(args)
    }) as never)
    const post = vi.fn().mockResolvedValue({})
    const item: AttentionItem = {
      id: "kernel:approval:a9",
      app: "kernel",
      entity: "approval_request",
      entityId: "a9",
      kind: "approval_pending",
      summary: "Re: Order #3270 confirmed",
      urgency: 60,
      occurredAt: "2026-08-06T00:00:00Z",
      action: { type: "decide_approval", approvalId: "a9" },
      metadata: {
        decideInContext: true,
        openTarget: { app: "tickets", entity: "ticket", entityId: "tk-3270" },
      },
    }
    const api = makeApi(post)
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    const open = getByTestId("attention-row-kernel-approval_request-a9-open")
    expect(open.textContent).toContain("Open ticket")
    fireEvent.click(open)
    // The TICKET, not the approval entity.
    expect(openEntityCalls[0]?.[1]).toBe("tickets")
    expect(openEntityCalls[0]?.[2]).toBe("ticket")
    expect(openEntityCalls[0]?.[3]).toBe("tk-3270")
  })
})

// The org setting `settings.tickets.approveRepliesFromHome` (default off). The
// server resolves it into the row: off, a ticket reply carries
// `decideInContext` and the row only opens the ticket; on, the flag is left
// off and the SAME reply row is decidable like any other approval, posting to
// the same decide endpoint the ticket page uses.
describe("AttentionRow: ticket reply approval, approve-from-Home setting", () => {
  const replyItem = (metadata: Record<string, unknown>): AttentionItem => ({
    id: "kernel:approval:tr1",
    app: "kernel",
    entity: "approval_request",
    entityId: "tr1",
    kind: "approval_pending",
    summary: "Where is my order",
    urgency: 60,
    occurredAt: "2026-10-16T00:00:00Z",
    action: { type: "decide_approval", approvalId: "tr1" },
    metadata: { toolName: "tickets:reply", actionLabel: "Tickets: reply", ...metadata },
  })
  const tid = "attention-row-kernel-approval_request-tr1"

  it("setting off: only Open ticket, no approve/reject/details", () => {
    const post = vi.fn().mockResolvedValue({})
    const { queryByTestId, getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(post)}>
        <AttentionRow
          item={replyItem({
            decideInContext: true,
            openTarget: { app: "tickets", entity: "ticket", entityId: "tk-1" },
          })}
        />
      </ApiContext.Provider>
    ))
    expect(queryByTestId(`${tid}-approve`)).toBeNull()
    expect(queryByTestId(`${tid}-reject`)).toBeNull()
    expect(queryByTestId(`${tid}-details`)).toBeNull()
    expect(getByTestId(`${tid}-open`).textContent).toContain("Open ticket")
  })

  it("setting on: Approve/Reject on the row, approve posts the shared decide path", async () => {
    const post = vi.fn().mockResolvedValue({})
    const { queryByTestId, getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(post)}>
        <AttentionRow item={replyItem({})} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId(`${tid}-open`)).toBeNull()
    expect(queryByTestId(`${tid}-reject`)).not.toBeNull()
    expect(queryByTestId(`${tid}-details`)).not.toBeNull()
    fireEvent.click(getByTestId(`${tid}-approve`))
    await Promise.resolve()
    await Promise.resolve()
    expect(post).toHaveBeenCalledWith(
      "/approvals/tr1/decide",
      { decision: "approve" },
      { suppressGlobalError: true },
    )
  })

  it("setting on: Details opens the full card with the reply text", async () => {
    handleWsCreate(
      {
        id: "tr1",
        handle: "request-0101",
        status: "pending",
        createdAt: "2026-10-16T00:00:00.000Z",
        expiresAt: "2026-10-23T00:00:00.000Z",
        toolName: "tickets:reply",
        summary: { kind: "tickets.reply", title: "Where is my order", lines: [] },
        editableFields: [{ field: "textBody", label: "Body", widget: "richtext" }],
        currentPayload: { ticketId: "tk-1", textBody: "Your parcel ships tomorrow." },
        requestedBy: { id: "u-agent" },
        requester: { kind: "agent", id: "u-agent", name: "Support agent" },
        notifyUserIds: [],
        lastEdit: null,
        lastFailure: null,
      } as never,
      "u-approver",
    )
    const api = makeApi(vi.fn().mockResolvedValue({}))
    api.get.mockResolvedValue(undefined)
    const { getByTestId, findByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={replyItem({})} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId(`${tid}-details`))
    expect(getByTestId(`${tid}-expanded`)).toBeTruthy()
    // A ticket reply previews as the customer gets the email (sandboxed iframe).
    const body = await findByTestId("approval-card-message-body")
    const preview = body.querySelector("iframe")?.getAttribute("srcdoc") ?? body.textContent
    expect(preview).toContain("Your parcel ships tomorrow.")
  })
})

// ticket-10174: the operator asked for double-click-to-open because the Open
// button was invisible until the row was hovered. Adding a second way in would
// have left the first just as hidden, so the controls were made discoverable
// instead. Pinned as a layout-safe property: dimmed at rest, never `display`,
// so nothing resizes under the cursor (the ticket-10226 trap).
describe("AttentionRow row controls are discoverable at rest", () => {
  const navigableItem: AttentionItem = {
    id: "kernel:t:x1",
    app: "tickets",
    entity: "ticket",
    entityId: "x1",
    kind: "sla_risk",
    summary: "SLA approaching",
    urgency: 60,
    occurredAt: "2026-05-06T00:00:00Z",
    action: { type: "open_entity" } as never,
  }

  it("renders Open dimmed rather than invisible, and does not hide it with display", () => {
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={navigableItem} />
      </ApiContext.Provider>
    ))
    const cls = getByTestId("attention-row-tickets-ticket-x1-open").className
    expect(cls).not.toContain("opacity-0 ")
    expect(cls).toContain("opacity-60")
    expect(cls).toContain("group-hover/row:opacity-100")
    // `hidden` would change the row's width on hover, which is the defect the
    // sibling fix removed from the shortcut chip.
    expect(cls).not.toMatch(/\bhidden\b/)
  })
})

// ticket-10176: the ask was "put the customer name on the approval cards in
// Home". Generalised to the real question -- can this be judged WITHOUT opening
// it? -- the missing fact is who/what the action reaches, which the summarizers
// have always written as the approval's subtitle and the feed never carried.
describe("AttentionRow surfaces who an approval reaches", () => {
  const approval = (metadata: Record<string, unknown>): AttentionItem => ({
    id: "kernel:approval:s1",
    app: "kernel",
    entity: "approval_request",
    entityId: "s1",
    kind: "approval_pending",
    summary: "Tickets: reply",
    urgency: 60,
    occurredAt: "2026-05-06T00:00:00Z",
    action: { type: "decide_approval", approvalId: "s1" },
    metadata,
  })

  it("renders the subtitle so the row names who it reaches", () => {
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={approval({ subtitle: "Reply to Fabien Saye kanou on ticket-10013" })} />
      </ApiContext.Provider>
    ))
    expect(getByTestId("attention-row-kernel-approval_request-s1-subtitle").textContent).toContain(
      "Fabien Saye kanou",
    )
  })

  it("renders nothing extra when the summary carried no subtitle", () => {
    // Absence must stay silent -- an empty line would be worse than none.
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={approval({ actionLabel: "Tickets: reply" })} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-approval_request-s1-subtitle")).toBeNull()
  })

  // S23/A10: the row names WHICH record first (`ticket-B2B-123`), as the card does.
  it("renders the record ref first, before the action chip", () => {
    const { getByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow
          item={approval({
            actionLabel: "Tickets: reply",
            ref: "ticket-B2B-123",
            subtitle: "Reply to Jean Dupont",
          })}
        />
      </ApiContext.Provider>
    ))
    const ref = getByTestId("attention-row-kernel-approval_request-s1-record-ref")
    expect(ref.textContent).toBe("ticket-B2B-123")
    expect(ref.className).toContain("font-mono")
    const chip = getByTestId("attention-row-kernel-approval_request-s1-action-chip")
    expect(ref.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // D10 (APR-01): the "Last message:" summary line is French for a French reader.
  it("renders the ticket summary line and subtitle in French", () => {
    const { getByTestId } = render(() => (
      <I18nProvider initialLocale="fr">
        <ApiContext.Provider value={makeApi(vi.fn())}>
          <AttentionRow
            item={approval({
              actionLabel: "Tickets: reply",
              toolName: "tickets:reply",
              subtitle: "Reply to Jean Dupont",
              summaryLines: ["Last message: 2026-09-28 22:03"],
            })}
          />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    const text = getByTestId("attention-row-kernel-approval_request-s1").textContent ?? ""
    expect(text).toContain("Réponse à Jean Dupont")
    expect(text).toContain(`Dernier message : ${formatDateTime("2026-09-28T22:03:00Z", "fr")}`)
    expect(text).not.toContain("Last message")
  })

  it("renders no ref chip when the approval carried none", () => {
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={approval({ actionLabel: "Tickets: reply" })} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-approval_request-s1-record-ref")).toBeNull()
  })

  it("ignores a non-string subtitle rather than rendering junk", () => {
    const { queryByTestId } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={approval({ subtitle: 42 })} />
      </ApiContext.Provider>
    ))
    expect(queryByTestId("attention-row-kernel-approval_request-s1-subtitle")).toBeNull()
  })
})

// Reported 2026-10-05 (desktop and mobile): a "Nouvel e-mail de ..." card opened a tab
// "Type d'onglet inconnu « mail:new_email »". The row carries its destination in
// action.tabType (the item's metadata.link: mail:conversation), but the click rebuilt
// the tab type from the item's own app and entity, which no component registers.
describe("AttentionRow: an item whose link names another tab", () => {
  function newEmail(count: number, conversationId: string | null): AttentionItem {
    return {
      id: "mail:new_email:msg-1",
      app: "mail",
      entity: "new_email",
      entityId: "msg-1",
      kind: "new_email" as AttentionItem["kind"],
      summary: "Nouvel e-mail de Dana",
      urgency: 40,
      occurredAt: "2026-10-05T09:00:00Z",
      action: conversationId
        ? { type: "open_entity", tabType: "mail:conversation", entityId: conversationId }
        : { type: "open_entity", tabType: "mail:new_email", entityId: "msg-1" },
      metadata: {
        count,
        messageIds: ["msg-1"],
        accountId: "acc-1",
        ...(conversationId
          ? { conversationId, link: { tabType: "mail:conversation", entityId: conversationId } }
          : {}),
      },
    }
  }

  function click(item: AttentionItem): void {
    vi.mocked(openEntity).mockClear()
    vi.mocked(openAttentionLink).mockClear()
    vi.mocked(markAttentionRead).mockClear()
    const { getByTestId, unmount } = render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId(`attention-row-${item.app}-${item.entity}-${item.entityId}`))
    unmount()
  }

  it("one new email opens its conversation and clears the item itself", () => {
    click(newEmail(1, "conv-1"))
    expect(vi.mocked(openAttentionLink)).toHaveBeenCalledWith(
      expect.anything(),
      "mail:conversation",
      "conv-1",
      "Nouvel e-mail de Dana",
    )
    expect(vi.mocked(openEntity)).not.toHaveBeenCalled()
    expect(vi.mocked(markAttentionRead)).toHaveBeenCalledWith(
      expect.anything(),
      "mail",
      "new_email",
      "msg-1",
    )
  })

  it("a burst of several new emails opens the mail inbox, not the last conversation", () => {
    click(newEmail(3, "conv-9"))
    expect(vi.mocked(openAttentionLink)).not.toHaveBeenCalled()
    expect(vi.mocked(openEntity)).toHaveBeenCalledWith(
      expect.anything(),
      "mail",
      "new_email",
      "msg-1",
      "Nouvel e-mail de Dana",
      { markAttentionRead: true },
    )
  })

  it("an item without a link keeps the entity path (the mail opener sends it to the inbox)", () => {
    click(newEmail(1, null))
    expect(vi.mocked(openAttentionLink)).not.toHaveBeenCalled()
    expect(vi.mocked(openEntity)).toHaveBeenCalledWith(
      expect.anything(),
      "mail",
      "new_email",
      "msg-1",
      "Nouvel e-mail de Dana",
      { markAttentionRead: true },
    )
  })

  it("a routine notification linking to its output thread opens that thread", () => {
    click({
      id: "kernel:agent_notification:n-1",
      app: "kernel",
      entity: "agent_notification",
      entityId: "n-1",
      kind: "agent_notification",
      summary: "Routine finished",
      urgency: 30,
      occurredAt: "2026-10-05T09:00:00Z",
      action: { type: "open_entity", tabType: "thread", entityId: "t-7" },
      metadata: { link: { tabType: "thread", entityId: "t-7" } },
    })
    expect(vi.mocked(openAttentionLink)).toHaveBeenCalledWith(
      expect.anything(),
      "thread",
      "t-7",
      "Routine finished",
    )
    expect(vi.mocked(markAttentionRead)).toHaveBeenCalledWith(
      expect.anything(),
      "kernel",
      "agent_notification",
      "n-1",
    )
  })
})

describe("AttentionRow: Open on an approval whose item has its own page", () => {
  const linked = (id: string): AttentionItem => ({
    id: `kernel:approval:${id}`,
    app: "invoicing",
    entity: "approval_request",
    entityId: id,
    kind: "approval_pending",
    summary: "Issue invoice",
    urgency: 60,
    occurredAt: "2026-05-06T00:00:00Z",
    action: { type: "decide_approval", approvalId: id },
    metadata: {
      openLink: {
        label: "Open the draft invoice",
        app: "invoicing",
        entity: "detail",
        entityId: "doc-1",
      },
    },
  })

  const renderRow = (item: AttentionItem) => {
    const api = makeApi(vi.fn())
    return render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item} />
      </ApiContext.Provider>
    ))
  }

  it("desktop: offers Open beside the decision and opens the record", () => {
    vi.mocked(openEntity).mockClear()
    const { getByTestId } = renderRow(linked("ol1"))
    fireEvent.click(getByTestId("attention-row-invoicing-approval_request-ol1-open-link"))
    expect(openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "invoicing",
      "detail",
      "doc-1",
      "Issue invoice",
    )
  })

  it("phone: offers Open next to Approve / Reject", () => {
    const realMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query === PHONE_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    syncShellTier()
    try {
      vi.mocked(openEntity).mockClear()
      const { getByTestId } = renderRow(linked("ol2"))
      expect(getByTestId("attention-row-invoicing-approval_request-ol2-approve")).toBeTruthy()
      fireEvent.click(getByTestId("attention-row-invoicing-approval_request-ol2-open-link"))
      expect(openEntity).toHaveBeenCalledWith(
        expect.anything(),
        "invoicing",
        "detail",
        "doc-1",
        "Issue invoice",
      )
    } finally {
      window.matchMedia = realMatchMedia
      syncShellTier()
    }
  })

  it("no link, no Open", () => {
    const item = { ...linked("ol3"), metadata: {} }
    const { queryByTestId } = renderRow(item)
    expect(queryByTestId("attention-row-invoicing-approval_request-ol3-open-link")).toBeNull()
  })
})

// A newcomer reading the Home rows lost the decision, the deadline and the title to internal ids.
describe("AttentionRow: what a newcomer reads on a Home row", () => {
  const ID = "cw-1"
  const tid = `attention-row-kernel-approval_request-${ID}`
  const item = (metadata: Record<string, unknown> = {}): AttentionItem => ({
    id: `kernel:approval_pending:${ID}`,
    app: "kernel",
    entity: "approval_request",
    entityId: ID,
    kind: "approval_pending",
    summary: "Update skill: shipment-exception",
    urgency: 60,
    occurredAt: "2026-11-08T00:00:00Z",
    action: { type: "decide_approval", approvalId: ID },
    metadata: {
      toolName: "kernel:update_skill",
      actionLabel: "Workspace: update skill",
      requestHandle: "demo-skill-shipment-exception-customs",
      requesterName: "Margot Dufour",
      expiresInSeconds: 7 * 86_400,
      ...metadata,
    },
  })
  const asPhone = (fn: () => void) => {
    const realMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query === PHONE_QUERY,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList) as typeof window.matchMedia
    syncShellTier()
    try {
      fn()
    } finally {
      window.matchMedia = realMatchMedia
      syncShellTier()
    }
  }
  const renderRow = (it: AttentionItem) =>
    render(() => (
      <ApiContext.Provider value={makeApi(vi.fn())}>
        <AttentionRow item={it} />
      </ApiContext.Provider>
    ))

  it("says what runs out: Expires in 7 days, not 7d left", () => {
    const { getByTestId } = renderRow(item())
    expect(getByTestId(`${tid}-metric`).textContent).toBe("Expires in 7 days")
  })

  it("desktop meta line: who asked and when lead, the handle comes last", () => {
    const { getByTestId } = renderRow(item())
    const requester = getByTestId(`${tid}-requester`)
    const ref = getByTestId(`${tid}-ref`)
    expect(ref.textContent).toBe("demo-skill-shipment-exception-customs")
    // DOCUMENT_POSITION_FOLLOWING: the ref comes after the requester.
    expect(requester.compareDocumentPosition(ref) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("phone: the pill names the app only, the title leads, the handle is not the byline", () => {
    asPhone(() => {
      const { getByTestId } = renderRow(item())
      expect(getByTestId(`${tid}-action-chip`).textContent).toBe("Workspace")
      expect(getByTestId(`${tid}-title`).textContent).toBe("Update skill: shipment-exception")
      const secondary = getByTestId(`${tid}-secondary`).textContent ?? ""
      expect(secondary).not.toContain("demo-skill")
      expect(secondary).toContain("Margot Dufour")
      expect(getByTestId(`${tid}-deadline`).textContent).toBe("Expires in 7 days")
    })
  })

  it("Details keeps Approve and Reject in view: the card's decision row sticks, no id header", async () => {
    handleWsCreate(
      {
        id: ID,
        handle: "request-0102",
        status: "pending",
        createdAt: "2026-11-08T00:00:00.000Z",
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        toolName: "test:gated_write",
        summary: { kind: "generic", title: "Update skill: shipment-exception", lines: [] },
        editableFields: [],
        currentPayload: { a: 1 },
        requestedBy: { id: "u-agent" },
        requester: { kind: "agent", id: "u-agent", name: "Support agent" },
        notifyUserIds: [],
        lastEdit: null,
        lastFailure: null,
      } as never,
      "u-approver",
    )
    const api = makeApi(vi.fn().mockResolvedValue({}))
    api.get.mockResolvedValue(undefined)
    const { getByTestId, findByTestId, queryByTestId } = render(() => (
      <ApiContext.Provider value={api}>
        <AttentionRow item={item()} />
      </ApiContext.Provider>
    ))
    fireEvent.click(getByTestId(`${tid}-details`))
    const expanded = getByTestId(`${tid}-expanded`)
    await findByTestId("approval-card-title")
    const actions = expanded.querySelector('[data-testid="actions-inline-row"]')
    expect(actions).not.toBeNull()
    expect(actions?.className).toContain("sticky")
    expect(queryByTestId("approval-card-handle")).toBeNull()
  })
})
