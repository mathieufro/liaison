// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run inside its approval card, rendered: rows open where they are with the
// document editor's own fields, the total follows what is typed, a changed run says what changed
// and who changed it, and each viewer sees the controls their rights give.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
const decided: unknown[] = []
const mounted: Array<Record<string, unknown>> = []
let rows: Array<Record<string, unknown>> = []
let schedules: Array<Record<string, unknown>> = []
let toolAnswers: Record<string, unknown> = {}
const previews: string[] = []
/** When set, `recurring_run_get` answers only once it resolves (a slow read). */
let holdRunRead: Promise<void> | null = null
const ELODIE = "0e1d0000-0000-4000-8000-000000000001"
const SARA = "5a7a0000-0000-4000-8000-000000000002"

const row = (id: string, customer: string, total: string, extra: Record<string, unknown> = {}) => ({
  item_id: id,
  draft_id: `doc-${id}`,
  document_id: `doc-${id}`,
  state: "ready",
  customer,
  account_manager: null,
  net_minor: String((BigInt(total) * 5n) / 6n),
  vat_minor: String(BigInt(total) / 6n),
  total_minor: total,
  currency: "EUR",
  number: null,
  updated_at: "2026-11-27T07:00:00.000Z",
  latest_change: null,
  flags: ["Same as October"],
  failure: null,
  ...extra,
})

const RETAINER = ["Retainer"][0]
const [TEAM_PLAN_NOV, WORKSHOP, REFUSED] = [
  "Team plan, November 2026",
  "Workshop days",
  "Maison Lumen is already billed these lines in this run.",
]

const draftDoc = (id: string) => ({
  id: `doc-${id}`,
  type: "invoice",
  status: "draft",
  currency: "EUR",
  language: "en",
  incoterm: "EXW",
  issuer_profile_id: "iss-1",
  issuer_country: "FR",
  counterparty_name: "Hôtels Belcour",
  counterparty_email: "billing@belcour.example",
  counterparty_address: "1 rue de Test, 75011 Paris",
  counterparty_country: "FR",
  due_at: "2026-12-30",
  tax_treatment: "domestic",
  lines: [
    {
      position: 1,
      description: RETAINER,
      quantity: "1",
      unit_price_minor: "49000",
      tax_rate_bp: 2000,
    },
  ],
})

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  onEntityChange: () => () => {},
  fetch: async (path: string) => {
    if (path.endsWith("/preview")) previews.push(path)
    if (path.includes(ELODIE)) return { data: { name: "Élodie Renard" } }
    if (path.includes(SARA)) return { data: { name: "Sara Benali" } }
    if (path === "/api/contacts/c-belcour")
      return { id: "c-belcour", name: null, company: "Hôtels Belcour", email: null }
    if (path === "/api/contacts/c-arlon")
      return { id: "c-arlon", name: "Lea Arlon", company: "Maison Arlon", email: null }
    throw new Error("unknown")
  },
  app: {
    createResource,
    decideApproval: async (...args: unknown[]) => {
      decided.push(args)
      return { ok: true }
    },
    mountEntityDiscussion: (_anchor: unknown, descriptor: Record<string, unknown>) => {
      mounted.push(descriptor)
      return { resolved: true, dispose: () => {} }
    },
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      if (tool === "recurring_run_get") {
        if (holdRunRead) await holdRunRead
        return {
          status: "completed",
          run: { id: "run-1", issue_on: "2026-11-30", period: "November 2026", status: "drafted" },
          rows,
        }
      }
      if (tool === "documents_get")
        return { ...draftDoc(String(params.id).replace("doc-", "")), lines: draftDoc("x").lines }
      if (tool in toolAnswers) return toolAnswers[tool]
      if (tool === "recurring_list") return { rows: schedules, nextCursor: null, nextRun: null }
      if (tool === "settings_issuer_profile_list") {
        return {
          items: [
            {
              id: "iss-1",
              legal_name: "Issuer",
              country: "FR",
              is_default: true,
              today: "2026-11-27",
            },
          ],
        }
      }
      return { status: "completed" }
    },
  },
}))

const { MonthEndRunPanel } = await import("./MonthEndRunPanel")
const { Editor } = await import("./Editor")

const item = (id: string, hash: string, total: string) => ({
  item_id: id,
  document_id: `doc-${id}`,
  content_hash: hash,
  total_minor: total,
})
const WRITE = ["invoicing:documents:write", "invoicing:documents:read"]

function renderPanel(
  opts: { items?: ReturnType<typeof item>[]; scopes?: string[]; canDecide?: boolean } = {},
) {
  const items =
    opts.items ?? rows.map((r) => item(String(r.item_id), `h-${r.item_id}`, String(r.total_minor)))
  return render(() => (
    <MonthEndRunPanel
      approvalId="appr-1"
      status="pending"
      payload={{ run_id: "run-1", items }}
      payloadHash="hash-1"
      canDecide={opts.canDecide ?? true}
      viewerScopes={opts.scopes ?? WRITE}
    />
  ))
}

/** The open row's price cell, once the editor has read the issuer (which may restate the lines). */
async function editorReady(): Promise<HTMLElement> {
  await waitFor(() =>
    expect(calls.some((c) => c.tool === "settings_issuer_profile_list")).toBe(true),
  )
  await new Promise((r) => setTimeout(r, 50))
  return screen.getByTestId("editor-line-1-unit-price")
}

const fieldIds = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-testid]")]
    .map((e) => e.getAttribute("data-testid") ?? "")
    .filter(
      (id) =>
        id.startsWith("editor-field-") ||
        /^editor-line-\d+-(description|quantity|unit-price)$/.test(id),
    )

describe("the month-end panel", () => {
  beforeEach(() => {
    calls.length = 0
    decided.length = 0
    mounted.length = 0
    previews.length = 0
    rows = [
      row("a", "Hôtels Belcour", "58800", { account_manager: ELODIE }),
      row("b", "Le Comptoir Sud", "58800"),
    ]
    schedules = []
    toolAnswers = {}
  })
  afterEach(cleanup)

  it("a row opens in place with the editor's own field list and validation", async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const open = await screen.findByTestId("month-end-row-editor-a")
    await waitFor(() => expect(within(open).getByTestId("editor-field-customer-name")).toBeTruthy())
    const compact = fieldIds(open)
    cleanup()
    const full = render(() => <Editor initial={draftDoc("a") as never} documentId="doc-a" />)
    const all = fieldIds(full.container as HTMLElement)
    // No second field set: every field the row shows is the editor's own.
    expect(compact.length).toBeGreaterThan(5)
    for (const id of compact) expect(all).toContain(id)
    for (const id of [
      "editor-field-customer-name",
      "editor-field-due-at",
      "editor-line-1-quantity",
      "editor-line-1-unit-price",
    ]) {
      expect(compact).toContain(id)
    }
    // Issue buttons and the summary stay in the full editor only.
    expect(compact).not.toContain("editor-field-type")
  })

  it("typing recomputes the row, the total and Approve N before saving, and saving sends what was shown", async () => {
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("month-end-approve-count").textContent).toContain(
        "2 invoices to approve",
      ),
    )
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const price = await editorReady()
    fireEvent.input(price, { target: { value: "650" } })
    await waitFor(() =>
      expect(screen.getByTestId("month-end-row-unsaved-a").textContent).toContain("780"),
    )
    expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("780")
    // 780.00 + 588.00, still two rows to approve.
    expect(screen.getByTestId("month-end-approve-count").textContent).toMatch(
      /2 invoices to approve, .*1[,.  ]?368/,
    )
    fireEvent.click(screen.getByTestId("month-end-row-save-month"))
    await waitFor(() => expect(calls.some((c) => c.tool === "drafts_update")).toBe(true))
    const sent = calls.find((c) => c.tool === "drafts_update")?.params as Record<string, unknown>
    expect(sent).toMatchObject({
      draft_id: "doc-a",
      applies: "this_month",
      if_unchanged_since: "2026-11-27T07:00:00.000Z",
    })
    expect(
      (sent.patch as { lines: Array<{ unit_price_minor: string }> }).lines[0]?.unit_price_minor,
    ).toBe("65000")
  })

  it("cancel restores the saved amounts", async () => {
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
    const el = await editorReady()
    fireEvent.input(el, { target: { value: "650" } })

    await waitFor(() =>
      expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("780"),
    )
    fireEvent.click(screen.getByTestId("month-end-row-cancel"))
    await waitFor(() =>
      expect(screen.getByTestId("month-end-row-total-a").textContent).toContain("588"),
    )
  })

  it("a changed run lists what changed, who changed it, the old and new totals, and offers approve on the new hash", async () => {
    const first = [item("a", "h-a", "58800"), item("b", "h-b", "58800")]
    const [items, setItems] = (await import("solid-js")).createSignal(first)
    render(() => (
      <MonthEndRunPanel
        approvalId="appr-1"
        status="pending"
        payload={{ run_id: "run-1", items: items() }}
        payloadHash="hash-2"
        canDecide
        viewerScopes={WRITE}
      />
    ))
    await screen.findByTestId("month-end-row-open-a")
    expect(screen.queryByTestId("month-end-changed")).toBeNull()
    rows = [
      row("a", "Hôtels Belcour", "78000", {
        latest_change: { actor_user_id: SARA, agent_id: "agent-1", fields: [] },
      }),
      row("b", "Le Comptoir Sud", "58800"),
    ]
    setItems([item("a", "h-a2", "78000"), item("b", "h-b", "58800")])
    const box = await screen.findByTestId("month-end-changed")
    await waitFor(() =>
      expect(within(box).getByTestId("month-end-change-a").textContent).toContain(
        "Hôtels Belcour changed",
      ),
    )
    expect(screen.getByTestId("month-end-changed-totals").textContent).toMatch(
      /1[,.  ]?176.*1[,.  ]?368/,
    )
    fireEvent.click(screen.getByTestId("month-end-approve-new"))
    await waitFor(() => expect(decided).toEqual([["appr-1", "approve", "hash-2"]]))
  })

  it("drawn again for the same card, the panel still lists what changed since the person first saw it", async () => {
    const first = [item("a", "h-a", "58800"), item("b", "h-b", "58800")]
    render(() => (
      <MonthEndRunPanel
        approvalId="appr-redraw"
        status="pending"
        payload={{ run_id: "run-1", items: first }}
        payloadHash="hash-1"
        canDecide
        viewerScopes={[]}
      />
    ))
    await screen.findByTestId("month-end-row-open-a")
    cleanup()
    // The host draws the card again with the rewritten payload.
    rows = [
      row("a", "Hôtels Belcour", "78000", { latest_change: { actor_user_id: SARA, fields: [] } }),
      row("b", "Le Comptoir Sud", "58800"),
    ]
    render(() => (
      <MonthEndRunPanel
        approvalId="appr-redraw"
        status="pending"
        payload={{
          run_id: "run-1",
          items: [item("a", "h-a2", "78000"), item("b", "h-b", "58800")],
        }}
        payloadHash="hash-2"
        canDecide
        viewerScopes={[]}
      />
    ))
    const box = await screen.findByTestId("month-end-changed")
    await waitFor(() =>
      expect(within(box).getByTestId("month-end-change-a").textContent).toContain(
        "Changed by Sara Benali",
      ),
    )
    fireEvent.click(screen.getByTestId("month-end-approve-new"))
    await waitFor(() => expect(decided).toEqual([["appr-redraw", "approve", "hash-2"]]))
  })

  it("drawn again while its rows are still being read, the panel shows what changed only once they answer", async () => {
    const first = [item("a", "h-a", "58800"), item("b", "h-b", "58800")]
    render(() => (
      <MonthEndRunPanel
        approvalId="appr-slow"
        status="pending"
        payload={{ run_id: "run-1", items: first }}
        payloadHash="hash-1"
        canDecide
        viewerScopes={[]}
      />
    ))
    await screen.findByTestId("month-end-row-open-a")
    cleanup()
    rows = [
      row("a", "Hôtels Belcour", "78000", { latest_change: { actor_user_id: SARA, fields: [] } }),
      row("b", "Le Comptoir Sud", "58800"),
    ]
    const reads = () => calls.filter((c) => c.tool === "recurring_run_get").length
    const readsBefore = reads()
    let release = () => {}
    holdRunRead = new Promise<void>((r) => {
      release = r
    })
    try {
      render(() => (
        <MonthEndRunPanel
          approvalId="appr-slow"
          status="pending"
          payload={{
            run_id: "run-1",
            items: [item("a", "h-a2", "78000"), item("b", "h-b", "58800")],
          }}
          payloadHash="hash-2"
          canDecide
          viewerScopes={[]}
        />
      ))
      await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore))
      expect(screen.queryByTestId("month-end-changed")).toBeNull()
      release()
      const box = await screen.findByTestId("month-end-changed")
      expect(within(box).getByTestId("month-end-change-a").textContent).toContain(
        "Hôtels Belcour changed",
      )
    } finally {
      holdRunRead = null
      release()
    }
  })

  it("a row shows its account manager when the name is known and no line otherwise, and Ask puts a mention in the box without sending", async () => {
    rows = [...rows, row("c", "Maison Arlon", "58800", { account_manager: "u-gone" })]
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("month-end-row-manager-a").textContent).toContain("Élodie Renard"),
    )
    expect(screen.queryByTestId("month-end-row-manager-b")).toBeNull()
    expect(screen.queryByTestId("month-end-row-manager-c")).toBeNull()
    expect(screen.getByTestId("month-end-rows").textContent).not.toContain("a teammate")
    fireEvent.click(screen.getByTestId("month-end-row-open-a"))
    fireEvent.click(await screen.findByTestId("month-end-row-ask"))
    await waitFor(() => expect(mounted.at(-1)?.prefill).toBe("@Élodie Renard Hôtels Belcour: "))
    expect(calls.some((c) => c.tool.startsWith("threads") || c.tool.includes("reply"))).toBe(false)
  })

  it("a row whose schedule a seed or the system wrote asks the host for no name and shows no manager line", async () => {
    rows = [
      row("a", "Hôtels Belcour", "58800", { account_manager: "seed" }),
      row("b", "Le Comptoir Sud", "58800", { account_manager: ELODIE }),
    ]
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("month-end-row-manager-b").textContent).toContain("Élodie Renard"),
    )
    expect(screen.queryByTestId("month-end-row-manager-a")).toBeNull()
    expect(previews.some((p) => p.includes("/seed/"))).toBe(false)
  })

  it.each([
    { write: true, approve: true, edit: true, decider: false },
    { write: true, approve: false, edit: true, decider: true },
    { write: false, approve: true, edit: false, decider: false },
    { write: false, approve: false, edit: false, decider: true },
  ])(
    "the four combinations of write and approve show the right controls (write $write, approve $approve)",
    async (c) => {
      renderPanel({ scopes: c.write ? WRITE : ["invoicing:documents:read"], canDecide: c.approve })
      fireEvent.click(await screen.findByTestId("month-end-row-open-a"))
      await screen.findByTestId("month-end-row-editor-a")
      expect(screen.queryByTestId("month-end-row-save-month") !== null).toBe(c.edit)
      expect(screen.queryByTestId("month-end-row-take-out") !== null).toBe(c.edit)
      expect(screen.queryByTestId("month-end-who-decides") !== null).toBe(c.decider)
      // Everyone may ask in the discussion.
      expect(screen.getByTestId("month-end-row-ask")).toBeTruthy()
      await waitFor(() => expect(screen.getByTestId("editor-field-customer-name")).toBeTruthy())
      expect((screen.getByTestId("editor-field-customer-name") as HTMLInputElement).disabled).toBe(
        !c.edit,
      )
    },
  )

  it("the first line and a waiting row's sentence show before any row", async () => {
    rows = [
      row("a", "Hôtels Belcour", "58800"),
      row("m", "Hôtel Mirabel", "58800", {
        state: "needs_fix",
        flags: ["Billing address missing"],
      }),
    ]
    renderPanel({ items: [item("a", "h-a", "58800")] })
    const first = await screen.findByTestId("month-end-first-line")
    expect(first.textContent).toContain(
      "Drafts, no legal numbers yet. Everything here can still change: click a row to open it.",
    )
    const waiting = await screen.findByTestId("month-end-waiting")
    expect(waiting.textContent).toContain(
      "it stays a draft, uses no number and comes back to you once fixed",
    )
    const list = screen.getByTestId("month-end-rows")
    // Both read before the rows, and the count leads the panel.
    expect(waiting.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      screen.getByTestId("month-end-approve-count").compareDocumentPosition(first) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(screen.getByTestId("month-end-approve-count").textContent).toContain(
      "1 invoices to approve",
    )
    expect(screen.getByTestId("month-end-row-number-a").textContent).toContain("On 2026-11-30")
    expect(screen.getByTestId("month-end-row-number-m").textContent).toContain("None until fixed")
  })

  it("300 rows fold under same as October, counted in Approve N, with search by name", async () => {
    rows = Array.from({ length: 300 }, (_, i) => row(`r${i}`, `Client ${i}`, "12000"))
    rows[7] = row("r7", "Client 7", "12000", { flags: ["Changed since October"] })
    renderPanel()
    await screen.findByTestId("month-end-folded")
    expect(screen.getByTestId("month-end-folded").textContent).toBe("299 same as October")
    expect(screen.getByTestId("month-end-rows").children.length).toBe(1)
    expect(screen.getByTestId("month-end-approve-count").textContent).toContain(
      "300 invoices to approve",
    )
    fireEvent.input(screen.getByTestId("month-end-search"), { target: { value: "Client 42" } })
    await waitFor(() => expect(screen.getByTestId("month-end-row-r42")).toBeTruthy())
  })
  it("a row's notes sit inside the row, with a space between two notes", async () => {
    rows = [
      row("a", "Hôtels Belcour", "58800", {
        flags: ["Changed since the last period", "the last period is still unpaid"],
      }),
    ]
    renderPanel()
    const open = await screen.findByTestId("month-end-row-open-a")
    const notes = within(open).getByTestId("month-end-row-notes-a")
    expect(notes.textContent).toBe("Changed since the last period the last period is still unpaid")
  })

  it("a row billing far from last month shows its amount check, stands out from the folded rows and stays in Approve N", async () => {
    rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, `Client ${i}`, "12000"))
    rows[3] = row("r3", "Client 3", "1788000", {
      flags: ["Changed since October", "Check the amount: October was 149.00 EUR excl."],
    })
    renderPanel()
    await screen.findByTestId("month-end-folded")
    expect(screen.getByTestId("month-end-rows").children.length).toBe(1)
    expect(screen.getByTestId("month-end-row-amount-check-r3").textContent).toBe(
      "Check the amount: October was 149.00 EUR excl.",
    )
    expect(screen.queryByTestId("month-end-row-amount-check-r4")).toBeNull()
    expect(screen.getByTestId("month-end-approve-count").textContent).toContain(
      "30 invoices to approve",
    )
  })
  it("add an invoice someone forgot offers the schedules missing from the run and adds the one picked as a draft of the run", async () => {
    const line = (description: string, unit: number) => [
      { description, qty: 1, unit_price_minor: unit, vat_bp: 2000 },
    ]
    schedules = [
      {
        id: "s-belcour",
        issuer_profile_id: "iss-1",
        contact_id: "c-belcour",
        status: "active",
        lines: line("Retainer, {period}", 49000),
        version: 1,
      },
      {
        id: "s-arlon",
        issuer_profile_id: "iss-1",
        contact_id: "c-arlon",
        status: "active",
        lines: line("Team plan, {period}", 65000),
        version: 1,
      },
    ]
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-add"))
    const form = await screen.findByTestId("month-end-add-form")
    // Belcour is in the run already: only Arlon is offered.
    await waitFor(() =>
      expect(within(form).getByTestId("month-end-add-schedule-s-arlon").textContent).toContain(
        "Maison Arlon",
      ),
    )
    expect(within(form).queryByTestId("month-end-add-schedule-s-belcour")).toBeNull()
    expect(calls.find((c) => c.tool === "recurring_list")?.params).toMatchObject({
      status: "active",
    })
    fireEvent.click(within(form).getByTestId("month-end-add-schedule-s-arlon"))
    await waitFor(() => expect(calls.some((c) => c.tool === "drafts_create")).toBe(true))
    expect(calls.find((c) => c.tool === "drafts_create")?.params).toEqual({
      type: "invoice",
      run_id: "run-1",
      counterparty_contact_id: "c-arlon",
      counterparty_name: "Maison Arlon",
      items: [
        {
          position: 1,
          description: TEAM_PLAN_NOV,
          quantity: "1",
          unit_price_minor: "65000",
          tax_rate_bp_override: 2000,
        },
      ],
    })
    // The rows are read again, and the form closes.
    await waitFor(() => expect(screen.queryByTestId("month-end-add-form")).toBeNull())
    expect(calls.filter((c) => c.tool === "recurring_run_get").length).toBeGreaterThan(1)
  })

  it("add an invoice someone forgot also takes a customer with no schedule, and says why when the run refuses it", async () => {
    toolAnswers.drafts_create = {
      status: "error",
      error: { code: "already_in_run", message: REFUSED },
    }
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-add"))
    await screen.findByTestId("month-end-add-form")
    const add = screen.getByTestId("month-end-add-customer-save") as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("month-end-add-customer-name"), {
      target: { value: "Maison Lumen" },
    })
    fireEvent.input(screen.getByTestId("month-end-add-customer-line"), {
      target: { value: "Workshop days" },
    })
    fireEvent.input(screen.getByTestId("month-end-add-customer-qty"), { target: { value: "2" } })
    fireEvent.input(screen.getByTestId("month-end-add-customer-price"), {
      target: { value: "650,50" },
    })
    expect(add.disabled).toBe(false)
    fireEvent.click(add)
    await waitFor(() =>
      expect(screen.getByTestId("month-end-error").textContent).toContain(
        "already billed these lines",
      ),
    )
    expect(calls.find((c) => c.tool === "drafts_create")?.params).toEqual({
      type: "invoice",
      run_id: "run-1",
      counterparty_contact_id: null,
      counterparty_name: "Maison Lumen",
      items: [{ position: 1, description: WORKSHOP, quantity: "2", unit_price_minor: "65050" }],
    })
    // A refusal keeps what was typed.
    expect((screen.getByTestId("month-end-add-customer-name") as HTMLInputElement).value).toBe(
      "Maison Lumen",
    )
  })

  it("only someone who may edit sees add an invoice someone forgot", async () => {
    renderPanel({ scopes: ["invoicing:documents:read"] })
    await screen.findByTestId("month-end-row-open-a")
    expect(screen.queryByTestId("month-end-add")).toBeNull()
  })

  it("a row waiting for its address offers the address an agent found, and Use it saves it on that draft for this month", async () => {
    const found = {
      counterparty_address: "12 quai des Chartrons, 33000 Bordeaux",
      found_by_agent: "agent-1",
      at: "2026-11-27",
    }
    rows = [
      row("a", "Hôtels Belcour", "58800"),
      row("m", "Hôtel Mirabel", "58800", {
        state: "needs_fix",
        flags: ["No billing address"],
        fix_suggestion: found,
      }),
    ]
    renderPanel()
    const suggestion = await screen.findByTestId("month-end-row-suggestion-m")
    expect(suggestion.textContent).toContain("12 quai des Chartrons, 33000 Bordeaux")
    expect(screen.queryByTestId("month-end-row-suggestion-a")).toBeNull()
    fireEvent.click(screen.getByTestId("month-end-row-use-suggestion-m"))
    await waitFor(() => expect(calls.some((c) => c.tool === "drafts_update")).toBe(true))
    expect(calls.find((c) => c.tool === "drafts_update")?.params).toEqual({
      draft_id: "doc-m",
      patch: { counterparty_address: "12 quai des Chartrons, 33000 Bordeaux" },
      applies: "this_month",
      if_unchanged_since: "2026-11-27T07:00:00.000Z",
    })
  })

  it("a row waiting for its address takes one typed in place, and a reader sees the suggestion without Use it", async () => {
    rows = [
      row("m", "Hôtel Mirabel", "58800", { state: "needs_fix", flags: ["No billing address"] }),
    ]
    renderPanel()
    fireEvent.click(await screen.findByTestId("month-end-row-fix-m"))
    const save = screen.getByTestId("month-end-row-fix-save-m") as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.input(screen.getByTestId("month-end-row-fix-address-m"), {
      target: { value: "3 rue Sainte, 13001 Marseille" },
    })
    fireEvent.click(save)
    await waitFor(() => expect(calls.some((c) => c.tool === "drafts_update")).toBe(true))
    expect(calls.find((c) => c.tool === "drafts_update")?.params).toMatchObject({
      draft_id: "doc-m",
      patch: { counterparty_address: "3 rue Sainte, 13001 Marseille" },
      applies: "this_month",
    })
    cleanup()
    rows = [
      row("m", "Hôtel Mirabel", "58800", {
        state: "needs_fix",
        fix_suggestion: { counterparty_address: "3 rue Sainte" },
      }),
    ]
    renderPanel({ scopes: ["invoicing:documents:read"] })
    await screen.findByTestId("month-end-row-suggestion-m")
    expect(screen.queryByTestId("month-end-row-use-suggestion-m")).toBeNull()
    expect(screen.queryByTestId("month-end-row-fix-m")).toBeNull()
  })

  it.each([
    { write: false, approve: true, status: "pending", shown: true },
    { write: true, approve: true, status: "pending", shown: true },
    { write: false, approve: false, status: "pending", shown: false },
    { write: false, approve: true, status: "approved", shown: false },
  ])(
    'anyone who approves decides with "Approve N" at the top of the panel (write $write, approve $approve, $status)',
    async (c) => {
      render(() => (
        <MonthEndRunPanel
          approvalId="appr-1"
          status={c.status}
          payload={{
            run_id: "run-1",
            items: rows.map((r) =>
              item(String(r.item_id), `h-${r.item_id}`, String(r.total_minor)),
            ),
          }}
          payloadHash="hash-1"
          canDecide={c.approve}
          viewerScopes={c.write ? WRITE : ["invoicing:documents:read"]}
        />
      ))
      await screen.findByTestId("month-end-row-open-a")
      const button = screen.queryByTestId("month-end-approve")
      expect(button !== null).toBe(c.shown)
      if (!button) return
      expect(button.textContent).toMatch(/Approve 2, .*1[,.\s\u202f]?176/)
      // At the top: before the first line and the rows.
      expect(
        button.compareDocumentPosition(screen.getByTestId("month-end-rows")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      fireEvent.click(button)
      await waitFor(() => expect(decided).toEqual([["appr-1", "approve", "hash-1"]]))
    },
  )
})
