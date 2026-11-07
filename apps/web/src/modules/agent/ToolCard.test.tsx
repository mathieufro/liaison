// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool result's card, drawn from the stored card alone: no app bundle, no markup from a result,
// and card actions and inline edits that send exactly what the stored card offers.
import type { ResolvedCard, ResolvedCardGroupRow } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), rawPost: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

import { registerTabType, unregisterTabType } from "~/framework/app-registry"
import { ApiError } from "~/lib/api-error"
import {
  getMessage,
  handleWsMessageEvent,
  loadMessagesIntoStore,
  type Message,
  resetMessageStore,
  type ToolCallState,
} from "~/modules/threads/message-store"
import { ToolCard } from "./ToolCard"

const THREAD = "th-1"
const MESSAGE = "msg-1"

function answer(data: unknown, meta?: Record<string, unknown>) {
  return { json: async () => (meta ? { data, meta } : { data }) } as unknown as Response
}

/** Store the call on a finished reply, as a reload does, so a card action can name it. */
function stored(tc: ToolCallState, metadata: Record<string, unknown> = {}): ToolCallState {
  loadMessagesIntoStore(THREAD, [
    {
      id: MESSAGE,
      threadId: THREAD,
      authorId: "agent-1",
      authorName: "Agent",
      authorAvatarUrl: null,
      authorType: "agent",
      content: "",
      metadata: { ...metadata, toolCalls: [tc] },
      reactions: [],
      createdAt: "2026-11-07T08:00:00.000Z",
    } as unknown as Message,
  ])
  return tc
}

const entity = (over: Partial<ResolvedCard> = {}): ResolvedCard => ({
  kind: "entity",
  pill: { label: "Contacts" },
  title: "Maison Arlon",
  sub: "Hotel group",
  open: { view: "contacts:company", id: "co-1" },
  rows: [{ label: { label: "Plan" }, value: "Pro" }],
  ...over,
})

const call = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolCallId: "tc-1",
  toolName: "contacts__companies_read",
  status: "completed",
  args: { id: "co-1" },
  readOnly: true,
  card: entity(),
  ...over,
})

function groupRow(i: number, over: Partial<ResolvedCardGroupRow> = {}): ResolvedCardGroupRow {
  return {
    id: `row-${i}`,
    name: `Item ${i}`,
    cells: { qty: { t: "number", n: i }, total: { t: "money", minor: 1000 * i, currency: "EUR" } },
    links: [],
    edit: { qty: { value: i } },
    ...over,
  }
}

const groups = (rows: ResolvedCardGroupRow[], over: Partial<ResolvedCard> = {}): ResolvedCard => ({
  kind: "groups",
  pill: { label: "Stock" },
  title: "Order lines",
  columns: [
    { key: "qty", label: { label: "Qty" }, format: "number" },
    { key: "total", label: { label: "Total" }, format: "money" },
  ],
  groups: [{ label: "Lines", rows }],
  edit: {
    openLabel: { label: "Change" },
    doneLabel: { label: "Done" },
    tool: "lines_set",
    params: { orderId: "ord-1" },
    rowParam: "lineId",
    fields: [{ param: "qty", label: { label: "Qty" }, kind: "quantity" }],
  },
  ...over,
})

beforeEach(() => {
  apiMocks.rawPost.mockReset()
  resetMessageStore()
})
afterEach(() => {
  unregisterTabType("contacts:company", { notifyRemoval: false })
})

describe("ToolCard", () => {
  it("<img onerror> in a title creates no img", () => {
    const markup = '<img src=x onerror="alert(1)">'
    const { container } = render(() => (
      <>
        <ToolCard toolCall={call({ card: entity({ title: markup, sub: markup }) })} />
        <ToolCard
          toolCall={call({
            toolCallId: "tc-2",
            card: groups([
              groupRow(1, {
                name: markup,
                tag: markup,
                links: [{ label: markup, url: "https://example.com/a" }],
              }),
            ]),
          })}
        />
      </>
    ))
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toContain(markup)
  })

  it("draws identically with no app registered", () => {
    const first = render(() => <ToolCard toolCall={call()} />)
    const without = first.container.textContent
    expect(first.container.querySelector("[data-testid='card-entity']")).not.toBeNull()
    expect(first.container.querySelector("[data-testid='card-open']")).toBeNull()
    first.unmount()
    registerTabType("contacts:company", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/contacts/companies/:entityId",
      defaultLabel: "Company",
    })
    const second = render(() => <ToolCard toolCall={call()} />)
    expect(second.container.textContent).toBe(without)
    // With the view registered the title is the link to it; without, the same words as text.
    expect(second.container.querySelector("[data-testid='card-open']")?.textContent).toBe(
      "Maison Arlon",
    )
  })

  it("narrow layout classes are on every cell", () => {
    const rows = [groupRow(1), groupRow(2)]
    render(() => <ToolCard toolCall={call({ card: groups(rows) })} />)
    const cells = screen.getAllByTestId("card-cell")
    expect(cells).toHaveLength(4)
    for (const cell of cells) {
      // Stacked under the row name with its column label until the card is wide enough.
      expect(cell.className).toContain("@md:block")
      const label = cell.querySelector("[data-testid='card-cell-label']")
      expect(label?.className).toContain("@md:hidden")
    }
    for (const row of screen.getAllByTestId("card-group-row")) {
      expect(row.className).toContain("flex-col")
      expect(row.className).toContain("@md:grid")
    }
  })

  it("http: and javascript: urlPath render as text", () => {
    const { container } = render(() => (
      <ToolCard
        toolCall={call({
          card: groups([
            groupRow(1, {
              links: [
                { label: "plain", url: "http://example.com/a" },
                { label: "script", url: "javascript:alert(1)" },
                { label: "safe", url: "https://example.com/b" },
              ],
            }),
          ]),
        })}
      />
    ))
    const anchors = [...container.querySelectorAll("a")]
    expect(anchors.map((a) => a.textContent)).toEqual(["safe"])
    expect(anchors[0]?.getAttribute("href")).toBe("https://example.com/b")
    expect(container.textContent).toContain("plain")
    expect(container.textContent).toContain("script")
  })

  it("draws a 40-row groups card", () => {
    const rows = Array.from({ length: 40 }, (_, i) => groupRow(i + 1))
    render(() => <ToolCard toolCall={call({ card: groups(rows) })} />)
    expect(screen.getAllByTestId("card-group-row")).toHaveLength(40)
    expect(screen.getByText("Item 40")).toBeInTheDocument()
  })

  it("draws each kind with its test id, and a number with its method and source", () => {
    render(() => (
      <>
        <ToolCard
          toolCall={call({
            card: {
              kind: "list",
              pill: { label: "Invoices" },
              title: "Unpaid",
              items: [
                { label: "F-2026-0418", num: { t: "money", minor: 120000, currency: "EUR" } },
              ],
            },
          })}
        />
        <ToolCard
          toolCall={call({
            toolCallId: "tc-2",
            card: {
              kind: "number",
              pill: { label: "Billing" },
              title: "Monthly revenue",
              value: { t: "money", minor: 4200000, currency: "EUR" },
              how: { label: "Sum of active subscriptions" },
              source: "Billing, 09:08",
            },
          })}
        />
      </>
    ))
    expect(screen.getByTestId("card-list")).toHaveTextContent("F-2026-0418")
    expect(screen.getByTestId("card-number")).toHaveTextContent("Monthly revenue")
    expect(screen.getByTestId("card-how")).toHaveTextContent("Sum of active subscriptions")
    expect(screen.getByTestId("card-source")).toHaveTextContent("Source: Billing, 09:08")
  })

  it("confirm asks first then POSTs", async () => {
    const tc = stored(
      call({
        card: entity({
          actions: [
            {
              kind: "tool",
              label: { label: "Cancel plan" },
              tool: "plan_cancel",
              params: { id: "co-1" },
              confirm: { label: "Cancel this plan?" },
            },
          ],
        }),
      }),
    )
    apiMocks.rawPost.mockResolvedValue(
      answer({ ok: true }, { card: entity({ title: "Cancelled" }), cardRevision: 2 }),
    )
    render(() => <ToolCard toolCall={tc} />)
    await fireEvent.click(screen.getByTestId("card-action"))
    expect(apiMocks.rawPost).not.toHaveBeenCalled()
    expect(screen.getByTestId("card-confirm")).toHaveTextContent("Cancel this plan?")
    await fireEvent.click(screen.getByTestId("card-confirm-yes"))
    await waitFor(() => expect(apiMocks.rawPost).toHaveBeenCalledTimes(1))
    const [path, body] = apiMocks.rawPost.mock.calls[0]
    expect(path).toBe("/apps/contacts/tools/plan_cancel")
    expect(body).toEqual({
      params: { id: "co-1" },
      cardRef: { messageId: MESSAGE, toolCallId: "tc-1", revision: 1 },
    })
    await waitFor(() => expect(screen.getByTestId("card-entity")).toHaveTextContent("Cancelled"))
  })

  it("a card action the server does not accept shows its message", async () => {
    const tc = stored(
      call({
        card: entity({
          actions: [{ kind: "tool", label: { label: "Pause" }, tool: "plan_pause", params: {} }],
        }),
      }),
    )
    apiMocks.rawPost.mockRejectedValue(
      new ApiError("This card does not offer that call. Nothing ran.", 422, "card_action_unknown"),
    )
    render(() => <ToolCard toolCall={tc} />)
    await fireEvent.click(screen.getByTestId("card-action"))
    await waitFor(() =>
      expect(screen.getByTestId("card-notice")).toHaveTextContent(
        "This card does not offer that call. Nothing ran.",
      ),
    )
  })

  it("button disabled while running", async () => {
    const tc = stored(
      call({
        card: entity({
          actions: [{ kind: "tool", label: { label: "Refresh" }, tool: "refresh", params: {} }],
        }),
      }),
    )
    let finish: (r: Response) => void = () => {}
    apiMocks.rawPost.mockReturnValue(new Promise<Response>((r) => (finish = r)))
    render(() => <ToolCard toolCall={tc} />)
    const button = screen.getByTestId("card-action") as HTMLButtonElement
    await fireEvent.click(button)
    expect(button.disabled).toBe(true)
    await fireEvent.click(button)
    expect(apiMocks.rawPost).toHaveBeenCalledTimes(1)
    finish(answer({ ok: true }))
    await waitFor(() => expect(button.disabled).toBe(false))
  })

  it("failed readOnly shows Retry with the same args", async () => {
    const tc = call({
      status: "error",
      card: undefined,
      cardError: { pill: { label: "Billing" } },
      toolName: "billing__subscriptions_list",
      args: { customer: "cus-1", limit: 5 },
      result: { error: { message: "The key was revoked at 09:10." } },
    })
    apiMocks.rawPost.mockResolvedValue(answer({ items: [] }))
    render(() => <ToolCard toolCall={tc} />)
    expect(screen.getByTestId("card-error")).toHaveTextContent("The key was revoked at 09:10.")
    await fireEvent.click(screen.getByTestId("card-retry"))
    await waitFor(() => expect(apiMocks.rawPost).toHaveBeenCalledTimes(1))
    const [path, body] = apiMocks.rawPost.mock.calls[0]
    expect(path).toBe("/apps/billing/tools/subscriptions_list")
    expect(body).toEqual({ params: { customer: "cus-1", limit: 5 } })
  })

  it("failed write shows no Retry", () => {
    render(() => (
      <ToolCard
        toolCall={call({
          status: "error",
          readOnly: false,
          card: undefined,
          cardError: { pill: { label: "Billing" } },
          result: { error: "Refused by the provider." },
        })}
      />
    ))
    expect(screen.getByTestId("card-error")).toHaveTextContent("Refused by the provider.")
    expect(screen.queryByTestId("card-retry")).toBeNull()
  })

  it("a superseded card draws collapsed with no action and no field", () => {
    render(() => (
      <ToolCard
        toolCall={call({
          cardSuperseded: true,
          card: groups([groupRow(1)], {
            latestKey: "ord-1",
            supersededLabel: { label: "An older stock view" },
            actions: [{ kind: "tool", label: { label: "Refresh" }, tool: "refresh", params: {} }],
          }),
        })}
      />
    ))
    expect(screen.getByTestId("card-superseded")).toHaveTextContent("An older stock view")
    expect(screen.queryByTestId("card-action")).toBeNull()
    expect(screen.queryByTestId("card-edit-toggle")).toBeNull()
    expect(screen.queryByTestId("card-edit-field")).toBeNull()
  })

  describe("inline edit", () => {
    async function openField() {
      await fireEvent.click(screen.getByTestId("card-edit-toggle"))
      return screen.getAllByTestId("card-edit-field")[0] as HTMLInputElement
    }

    it("change sends one call with row id, revision and one field", async () => {
      const tc = stored(
        call({
          toolName: "stock__lines_get",
          card: groups([groupRow(1), groupRow(2)]),
          cardRevision: 3,
        }),
      )
      const next = groups([
        groupRow(1, { cells: { qty: { t: "number", n: 7 } }, edit: { qty: { value: 7 } } }),
        groupRow(2),
      ])
      apiMocks.rawPost.mockResolvedValue(answer({ ok: true }, { card: next, cardRevision: 4 }))
      render(() => <ToolCard toolCall={tc} />)
      expect(screen.queryByRole("dialog")).toBeNull()
      const field = await openField()
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.queryByText("Save")).toBeNull()
      await fireEvent.input(field, { target: { value: "7" } })
      await fireEvent.change(field)
      await waitFor(() => expect(apiMocks.rawPost).toHaveBeenCalledTimes(1))
      const [path, body] = apiMocks.rawPost.mock.calls[0]
      expect(path).toBe("/apps/stock/tools/lines_set")
      expect(body).toEqual({
        params: { orderId: "ord-1", lineId: "row-1", qty: 7 },
        cardRef: { messageId: MESSAGE, toolCallId: "tc-1", revision: 3 },
      })
    })

    it("refused value keeps the text and shows the tool's message", async () => {
      const tc = stored(call({ toolName: "stock__lines_get", card: groups([groupRow(1)]) }))
      apiMocks.rawPost.mockRejectedValue(
        new ApiError("Quantity must be 0 or more. Nothing changed.", 422, "invalid_params"),
      )
      render(() => <ToolCard toolCall={tc} />)
      const field = await openField()
      await fireEvent.input(field, { target: { value: "-3" } })
      await fireEvent.change(field)
      await waitFor(() =>
        expect(screen.getByTestId("card-field-note")).toHaveTextContent(
          "Quantity must be 0 or more. Nothing changed.",
        ),
      )
      expect((screen.getByTestId("card-edit-field") as HTMLInputElement).value).toBe("-3")
    })

    it("card_changed draws latest and keeps the text", async () => {
      const tc = stored(call({ toolName: "stock__lines_get", card: groups([groupRow(1)]) }))
      const latest = groups([groupRow(1, { name: "Item 1 (changed elsewhere)" })])
      apiMocks.rawPost.mockRejectedValue(
        new ApiError(
          "This card changed since it was drawn. Nothing was saved.",
          409,
          "card_changed",
          undefined,
          {
            card: latest,
            cardRevision: 2,
          },
        ),
      )
      render(() => <ToolCard toolCall={tc} />)
      const field = await openField()
      await fireEvent.input(field, { target: { value: "9" } })
      await fireEvent.change(field)
      await waitFor(() =>
        expect(screen.getByTestId("card-groups")).toHaveTextContent("Item 1 (changed elsewhere)"),
      )
      expect((screen.getByTestId("card-edit-field") as HTMLInputElement).value).toBe("9")
      expect(screen.getByTestId("card-field-note")).toHaveTextContent("This card changed")
    })

    it("network failure keeps the text, says it did not save, and leaves the card as stored", async () => {
      const tc = stored(call({ toolName: "stock__lines_get", card: groups([groupRow(1)]) }))
      apiMocks.rawPost.mockRejectedValue(new TypeError("Failed to fetch"))
      render(() => <ToolCard toolCall={tc} />)
      const field = await openField()
      await fireEvent.input(field, { target: { value: "5" } })
      await fireEvent.change(field)
      await waitFor(() =>
        expect(screen.getByTestId("card-field-note")).toHaveTextContent("Not saved"),
      )
      expect((screen.getByTestId("card-edit-field") as HTMLInputElement).value).toBe("5")
      expect(tc.card).toEqual(groups([groupRow(1)]))
    })
  })

  it("a card that arrives by message update is kept, with the rest of the metadata", async () => {
    // The row's own copy also carries keys the update frame leaves out.
    stored(call(), { turnId: "turn-1" })
    const msg = () => getMessage(THREAD, MESSAGE)
    handleWsMessageEvent("update", {
      id: MESSAGE,
      threadId: THREAD,
      toolCalls: [call({ card: entity({ title: "Maison Arlon, renewed" }), cardRevision: 2 })],
    })
    const toolCalls = msg()?.metadata?.toolCalls ?? []
    expect(toolCalls[0]?.card?.title).toBe("Maison Arlon, renewed")
    expect(toolCalls[0]?.cardRevision).toBe(2)
    expect(msg()?.metadata?.turnId).toBe("turn-1")
    render(() => <ToolCard toolCall={toolCalls[0] as ToolCallState} />)
    expect(screen.getByTestId("card-entity")).toHaveTextContent("Maison Arlon, renewed")
  })
})
