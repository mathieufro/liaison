// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { For } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"

// The production build's `env.DEV` is false: a test flips it to see what a person sees there.
const devFlag = vi.hoisted(() => ({ value: true }))
vi.mock("~/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/lib/env")>()
  return {
    ...real,
    env: {
      ...real.env,
      get DEV() {
        return devFlag.value
      },
    },
  }
})

vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string; compact?: boolean }) => (
    <div data-testid="approval-card-stub" data-request-id={props.requestId} />
  ),
}))

vi.mock("~/modules/admin-scope-requests/ScopeRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="scope-request-card-stub" data-request-id={props.requestId} />
  ),
}))

vi.mock("~/modules/secret-request/SecretRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="secret-request-card-stub" data-request-id={props.requestId} />
  ),
}))

vi.mock("~/modules/imports/ImportRunCard", () => ({
  default: (props: { runId?: string; approvalRequestId?: string }) => (
    <div
      data-testid="import-run-card-stub"
      data-run-id={props.runId ?? ""}
      data-approval-id={props.approvalRequestId ?? ""}
    />
  ),
}))

import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { resetLocalPrompts } from "~/modules/desktop/LocalPermissionCard"
import {
  getAgentStream,
  handleWsAgentStreamEvent,
  resetMessageStore,
  type ToolCallState,
} from "~/modules/threads/message-store"
import ToolCallRow, { groupToolCalls, StackedToolCallGroup } from "./ToolCallRow"

/** A read of one app, as the server's `tool_call` and `tool_result` frames describe it. */
const read = (
  id: string,
  app: string,
  appLabel: string,
  over: Partial<ToolCallState> = {},
): ToolCallState => ({
  toolCallId: id,
  toolName: `${app}__records_read`,
  args: { id },
  status: "completed",
  result: { ok: true },
  readOnly: true,
  appLabel,
  ...over,
})

/** Draw a turn's calls as the turn blocks do: each group, a row or a stack. */
function TurnCalls(props: { calls: ToolCallState[] }) {
  return (
    <For each={groupToolCalls(props.calls)}>
      {(g) =>
        g.calls.length > 1 ? (
          <StackedToolCallGroup toolCalls={g.calls} />
        ) : (
          <ToolCallRow toolCall={g.calls[0]} />
        )
      }
    </For>
  )
}

describe("ToolCallRow", () => {
  it("walk N45: two identical request_secret calls are never folded into a group, and the card is drawn once", () => {
    const first = {
      toolCallId: "tc-a",
      toolName: "kernel__request_secret",
      status: "completed" as const,
      result: { requestId: "sec-1", kind: "oauth_connect", target: {}, card: "posted" },
    }
    const second = {
      toolCallId: "tc-b",
      toolName: "kernel__request_secret",
      status: "completed" as const,
      result: { requestId: "sec-1", kind: "oauth_connect", target: {}, card: "already_posted" },
    }
    expect(groupToolCalls([first, second]).map((g) => g.calls.length)).toEqual([1, 1])
    // Calls with no card still stack.
    const read = (id: string) => ({
      toolCallId: id,
      toolName: "kernel__thread_read",
      status: "completed" as const,
    })
    expect(groupToolCalls([read("r1"), read("r2")]).map((g) => g.calls.length)).toEqual([2])
    render(() => (
      <>
        <ToolCallRow toolCall={first} />
        <ToolCallRow toolCall={second} />
      </>
    ))
    expect(screen.getAllByTestId("secret-request-card-stub")).toHaveLength(1)
  })

  it("draws the secret card under a request_secret call, keyed by the request it filed", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc-sec",
          toolName: "kernel__request_secret",
          status: "completed",
          result: { requestId: "sec-9", kind: "byok", target: { provider: "openrouter" } },
        }}
      />
    ))
    expect(screen.getByTestId("secret-request-card-stub").getAttribute("data-request-id")).toBe(
      "sec-9",
    )
  })

  it("draws the import card under a started import, an import waiting for approval, and a status read", () => {
    render(() => (
      <>
        <ToolCallRow
          toolCall={{
            toolCallId: "tc-imp1",
            toolName: "kernel__import_start",
            status: "completed",
            result: { runId: "run-1", status: "queued" },
          }}
        />
        <ToolCallRow
          toolCall={{
            toolCallId: "tc-imp2",
            toolName: "kernel__import_start",
            status: "completed",
            result: { blocked: { reason: "approval", approvalRequestId: "apr-7" } },
          }}
        />
        <ToolCallRow
          toolCall={{
            toolCallId: "tc-imp3",
            toolName: "kernel__import_status",
            status: "completed",
            args: { runId: "run-2" },
            result: { runId: "run-2", status: "running", preview: false },
          }}
        />
        <ToolCallRow
          toolCall={{
            toolCallId: "tc-imp4",
            toolName: "kernel__import_status",
            status: "completed",
            args: { runId: "prev-1" },
            result: { runId: "prev-1", status: "done", preview: true },
          }}
        />
      </>
    ))
    const cards = screen.getAllByTestId("import-run-card-stub")
    expect(
      cards.map((c) => [c.getAttribute("data-run-id"), c.getAttribute("data-approval-id")]),
    ).toEqual([
      ["run-1", ""],
      ["", "apr-7"],
      ["run-2", ""],
    ])
  })

  it("draws no secret card for a failed request_secret call", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc-sec2",
          toolName: "kernel__request_secret",
          status: "error",
          result: { requestId: "sec-10" },
        }}
      />
    ))
    expect(screen.queryByTestId("secret-request-card-stub")).toBeNull()
  })

  it("renders tool name and running status", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc1",
          toolName: "search_threads",
          status: "running",
          args: { q: "test" },
        }}
      />
    ))
    expect(screen.getByText("Search Threads")).toBeInTheDocument()
  })

  it("renders completed status with green dot", () => {
    const { container } = render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc1",
          toolName: "search_threads",
          status: "completed",
          result: { items: [] },
        }}
      />
    ))
    const dot = container.querySelector("[data-status='completed']")
    expect(dot).toBeInTheDocument()
  })

  it("toggles expanded content on click", async () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "tc1",
          toolName: "search_threads",
          status: "completed",
          args: { q: "test query" },
          result: { items: [{ id: "1" }] },
        }}
      />
    ))
    const row = screen.getByText("Search Threads").closest("button")!
    await fireEvent.click(row)
    expect(screen.getByText(/"q"/)).toBeInTheDocument()
  })

  it("forwards approvalRequestId to ApprovalCard for the flattened blocked result", () => {
    const toolCall = {
      toolCallId: "t1",
      toolName: "mail__reply",
      args: { conversationId: "c1", textBody: "hi" },
      result: {
        blocked: true,
        reason: "gated",
        approvalRequestId: "ar-1",
        summary: { kind: "mail.reply", title: "Re: x", lines: ["L1"] },
      },
      status: "completed",
    }

    render(() => <ToolCallRow toolCall={toolCall as any} />)

    expect(screen.getByTestId("approval-card-stub").getAttribute("data-request-id")).toBe("ar-1")
    expect(screen.queryByTestId("approval-legacy-summary")).toBeNull()
  })

  it("renders the regular row without ApprovalCard for non-blocked results", () => {
    const toolCall = {
      toolCallId: "t1",
      toolName: "mail__search",
      args: {},
      result: { items: [] },
      status: "completed",
    }

    render(() => <ToolCallRow toolCall={toolCall as any} />)

    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
    expect(screen.queryByTestId("approval-legacy-summary")).toBeNull()
  })

  it("shows the card of a pending request the agent edited, so the person decides on the edit", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "t1",
          toolName: "kernel__approval_update_payload",
          args: { requestId: "ar-9", fields: { textBody: "new" } },
          result: { id: "ar-9", currentPayload: { textBody: "new" }, payloadHash: "h2" },
          status: "completed",
        }}
      />
    ))
    expect(screen.getByTestId("approval-card-stub").getAttribute("data-request-id")).toBe("ar-9")
  })

  it("shows the access request the agent filed, so an approver decides it in the conversation", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "t1",
          toolName: "kernel__request_scope",
          args: { scopes: ["kernel:approvals:write"] },
          result: { requested: true, requestId: "sr-1", scopes: ["kernel:approvals:write"] },
          status: "completed",
        }}
      />
    ))
    expect(screen.getByTestId("scope-request-card-stub").getAttribute("data-request-id")).toBe(
      "sr-1",
    )
  })

  it("shows no card when the agent's edit failed", () => {
    render(() => (
      <ToolCallRow
        toolCall={{
          toolCallId: "t1",
          toolName: "kernel__approval_update_payload",
          args: { requestId: "ar-9", fields: {} },
          result: { error: "invalid_edit" },
          status: "error",
        }}
      />
    ))
    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
  })

  it("renders the legacy read-only summary fallback when approvalRequestId is missing", () => {
    const toolCall = {
      toolCallId: "t1",
      toolName: "mail__reply",
      args: {},
      result: {
        data: null,
        blocked: { reason: "gated", summary: { kind: "mail.reply", title: "Re: y", lines: [] } },
      },
      status: "completed",
    }

    render(() => <ToolCallRow toolCall={toolCall as any} />)

    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
    expect(screen.getByTestId("approval-legacy-summary")).toHaveTextContent("Re: y")
  })
  // P6d-T12: the prompt is answered where the tool is, in the row that raised
  // it, the same place this row already renders an ApprovalCard.
  describe("local permission prompt", () => {
    afterEach(() => {
      resetLocalPrompts()
      uninstallFakeBridge()
    })

    it("local permission card renders inside the tool call row that raised it", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_edit",
              toolName: "Edit",
              summary: "src/main.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
          pendingPermissions: [
            {
              requestId: "req-1",
              toolName: "Edit",
              summary: "Write 24 lines to src/main.ts",
              toolUseId: "toolu_edit",
            },
          ],
        }),
      )
      const { container } = render(() => (
        <ToolCallRow toolCall={{ toolCallId: "toolu_edit", toolName: "Edit", status: "running" }} />
      ))
      const row = container.querySelector('[data-testid="tool-call-row"]')
      const card = screen.getByTestId("local-permission-card")
      expect(row?.contains(card)).toBe(true)
    })

    it("a row that did not raise the prompt renders no card", () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          toolActivity: [
            {
              id: "toolu_edit",
              toolName: "Edit",
              summary: "src/main.ts",
              status: "running",
              startedAt: 1_000,
            },
          ],
          pendingPermissions: [
            {
              requestId: "req-1",
              toolName: "Edit",
              summary: "Write 24 lines to src/main.ts",
              toolUseId: "toolu_edit",
            },
          ],
        }),
      )
      render(() => (
        <ToolCallRow toolCall={{ toolCallId: "toolu_read", toolName: "Read", status: "running" }} />
      ))
      expect(screen.queryByTestId("local-permission-card")).toBeNull()
    })

    it("a browser row is the row it has always been", () => {
      uninstallFakeBridge()
      render(() => (
        <ToolCallRow toolCall={{ toolCallId: "toolu_edit", toolName: "Edit", status: "running" }} />
      ))
      expect(screen.queryByTestId("local-permission-card")).toBeNull()
    })
  })

  describe("result cards and the roll-up of reads", () => {
    afterEach(() => {
      devFlag.value = true
      resetMessageStore()
    })

    it("with env.DEV false no pre in the DOM", async () => {
      devFlag.value = false
      // A tool whose card resolved to null: the ordinary row, and nothing of the JSON.
      const { container } = render(() => (
        <ToolCallRow
          toolCall={{
            toolCallId: "tc-raw",
            toolName: "billing__subscriptions_list",
            status: "completed",
            args: { customer: "cus-1" },
            result: { items: [{ id: "sub-1", secretish: "raw value" }] },
          }}
        />
      ))
      await fireEvent.click(screen.getByText("Subscriptions List").closest("button")!)
      expect(container.querySelector("pre")).toBeNull()
      expect(container.textContent).not.toContain("raw value")
    })

    it("a row with a card draws the card instead of its line and is never folded", () => {
      const withCard = read("r1", "contacts", "Contacts", {
        card: { kind: "entity", pill: { label: "Contacts" }, title: "Maison Arlon" },
      })
      expect(
        groupToolCalls([withCard, read("r2", "billing", "Billing")]).map((g) => g.calls.length),
      ).toEqual([1, 1])
      render(() => <ToolCallRow toolCall={withCard} />)
      expect(screen.getByTestId("card-entity")).toHaveTextContent("Maison Arlon")
      expect(screen.queryByText("Records Read")).toBeNull()
    })

    it("Read N apps", () => {
      const calls = [
        read("r1", "contacts", "Contacts"),
        read("r2", "billing", "Billing"),
        read("r3", "invoicing", "Invoicing"),
      ]
      expect(groupToolCalls(calls).map((g) => g.calls.length)).toEqual([3])
      render(() => <TurnCalls calls={calls} />)
      expect(screen.getByTestId("tool-rollup-title")).toHaveTextContent("Read 3 apps")
      expect(screen.getByTestId("tool-rollup-summary")).toHaveTextContent(
        "Contacts, Billing, Invoicing",
      )
      expect(screen.queryAllByTestId("tool-call-row")).toHaveLength(0)
    })

    it("Read N-1 of N apps, and <App> did not answer", () => {
      const calls = [
        read("r1", "contacts", "Contacts"),
        read("r2", "billing", "Billing", {
          status: "error",
          result: { error: { message: "timeout" } },
        }),
        read("r3", "invoicing", "Invoicing"),
      ]
      render(() => <TurnCalls calls={calls} />)
      expect(screen.getByTestId("tool-rollup-title")).toHaveTextContent("Read 2 of 3 apps")
      expect(screen.getByTestId("tool-rollup-summary")).toHaveTextContent("Billing did not answer")
    })

    it("while the reads run, one line per app in order, with the tool's running label", () => {
      const calls = [
        read("r1", "contacts", "Contacts"),
        read("r2", "billing", "Billing", {
          status: "running",
          runningLabel: "Reading subscriptions",
        }),
      ]
      render(() => <TurnCalls calls={calls} />)
      const lines = screen.getAllByTestId("tool-rollup-line")
      expect(lines.map((l) => l.textContent)).toEqual(["Contacts", "BillingReading subscriptions"])
    })

    it("1 read stays a plain row", () => {
      const calls = [read("r1", "contacts", "Contacts")]
      expect(groupToolCalls(calls).map((g) => g.calls.length)).toEqual([1])
      render(() => <TurnCalls calls={calls} />)
      expect(screen.queryByTestId("tool-rollup")).toBeNull()
      expect(screen.getByTestId("tool-call-row")).toBeInTheDocument()
    })

    it("roll-up is the same live and after reload", () => {
      // Live: the frames the server streams. A tool that returned an error object is "error"
      // live and "completed" in the stored row: both read as did not answer.
      const thread = "th-roll"
      handleWsAgentStreamEvent("start", { threadId: thread, turnId: "turn-1" })
      const frames: Array<[string, Record<string, unknown>]> = [
        ["contacts", { appLabel: "Contacts" }],
        ["billing", { appLabel: "Billing", runningLabel: "Reading subscriptions" }],
        ["invoicing", { appLabel: "Invoicing" }],
      ]
      frames.forEach(([app, presentation], i) => {
        handleWsAgentStreamEvent("tool_call", {
          threadId: thread,
          turnId: "turn-1",
          toolCallId: `r${i}`,
          toolName: `${app}__records_read`,
          args: { id: `r${i}` },
          readOnly: true,
          ...presentation,
        })
      })
      frames.forEach(([app], i) => {
        handleWsAgentStreamEvent("tool_result", {
          threadId: thread,
          turnId: "turn-1",
          toolCallId: `r${i}`,
          result: app === "billing" ? { error: "timeout" } : { ok: true },
        })
      })
      const live = render(() => <TurnCalls calls={getAgentStream(thread).toolCalls} />)
      const liveText = live.container.textContent
      live.unmount()
      // Reload: the same calls as `metadata.toolCalls` stores them.
      const storedCalls: ToolCallState[] = frames.map(([app, presentation], i) => ({
        toolCallId: `r${i}`,
        toolName: `${app}__records_read`,
        args: { id: `r${i}` },
        result: app === "billing" ? { error: "timeout" } : { ok: true },
        status: "completed",
        readOnly: true,
        ...(presentation as Partial<ToolCallState>),
      }))
      const reloaded = render(() => <TurnCalls calls={storedCalls} />)
      expect(liveText).toContain("Read 2 of 3 apps")
      expect(reloaded.container.textContent).toBe(liveText)
    })
  })
})
