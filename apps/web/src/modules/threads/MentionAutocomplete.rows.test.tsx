// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Four tasks all called "Email-bounce dashboard for support" were four rows a
// writer could not choose between: every row carries a second line now.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MentionResult } from "~/lib/mention-service"
import { MentionAutocomplete } from "~/modules/threads/MentionAutocomplete"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const results = vi.hoisted(() => ({ value: [] as MentionResult[] }))

vi.mock("~/lib/mention-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/mention-service")>()
  return { ...actual, searchMentions: async () => results.value }
})

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: async () => ({ data: [] }) }),
}))

function renderPicker(
  position: { bottom: number | string; left: number } = { bottom: 0, left: 0 },
) {
  return render(() => (
    <MentionAutocomplete
      query=""
      trigger="@"
      position={position}
      onSelect={() => {}}
      onClose={() => {}}
    />
  ))
}

describe("mention picker rows", () => {
  beforeEach(() => {
    resetThreadStore()
    results.value = []
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  it("takes a CSS length for its bottom, so the composer can open it on its own top edge", async () => {
    results.value = [{ type: "entity", id: "task-a", label: "Launch", secondaryLabel: "Growth" }]
    renderPicker({ bottom: "100%", left: 16 })
    const popup = await screen.findByTestId("mention-autocomplete")
    expect(popup.style.bottom).toBe("100%")
    expect(popup.style.left).toBe("16px")
  })

  it("tells two same titled tasks apart by their project", async () => {
    results.value = [
      {
        type: "entity",
        id: "task-a",
        label: "Email-bounce dashboard for support",
        secondaryLabel: "Support",
      },
      {
        type: "entity",
        id: "task-b",
        label: "Email-bounce dashboard for support",
        secondaryLabel: "Growth",
      },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-secondary")).toHaveLength(2))
    const [first, second] = screen.getAllByTestId("mention-result-secondary")
    expect(first.textContent).toBe("Support")
    expect(second.textContent).toBe("Growth")
    expect(first.textContent).not.toBe(second.textContent)
  })

  it("draws a task with the task glyph, never the channel hash", async () => {
    results.value = [
      {
        type: "task",
        id: "task-a",
        label: "Email-bounce dashboard for support",
        secondaryLabel: "Support",
        app: "projects",
        entityType: "task",
      },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getByTestId("mention-result-secondary")).toBeTruthy())

    const glyph = document.querySelector("[data-entity-type='task']")
    expect(glyph).not.toBeNull()
    // The `#` is what a channel draws. A task drawing it read as a channel.
    expect(glyph?.querySelector(".lucide-hash")).toBeNull()
    expect(glyph?.querySelector(".lucide-list-todo")).not.toBeNull()
    expect(document.querySelectorAll(".lucide-hash")).toHaveLength(0)
  })

  it("stacks a task's qualifier under its title so a long title keeps the width", async () => {
    results.value = [
      {
        type: "task",
        id: "task-a",
        label: "Email-bounce dashboard for support",
        secondaryLabel: "Support",
        app: "projects",
        entityType: "task",
      },
    ]
    renderPicker()
    const secondary = await waitFor(() => screen.getByTestId("mention-result-secondary"))
    const title = screen.getByText("Email-bounce dashboard for support")

    // Same column, title first: side by side, the qualifier took width from a
    // title that then truncated to nothing readable.
    const column = title.parentElement
    expect(column).not.toBeNull()
    expect(column?.className).toContain("flex-col")
    expect(secondary.parentElement).toBe(column)
    expect(title.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(secondary.className).not.toContain("shrink-0")
  })

  it("names a channel by its member count and an agent by its handle", async () => {
    addThread({
      id: "chan-1",
      handle: "growth-experiments",
      title: "Growth experiments",
      isPinned: false,
      participants: [
        { id: "u1", name: "Ada", avatarUrl: null },
        { id: "u2", name: "Bo", avatarUrl: null },
        { id: "u3", name: "Cy", avatarUrl: null },
      ],
    })
    results.value = [
      { type: "thread", id: "chan-1", label: "Growth experiments" },
      { type: "agent", id: "agent-1", label: "shipping", secondaryLabel: "@shipping" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-secondary")).toHaveLength(2))
    // People lead an `@` list, so read each row from its own group rather than
    // from the order the server happened to return.
    const agent = screen
      .getByTestId("mention-group-agent")
      .querySelector("[data-testid='mention-result-secondary']")
    const channel = screen
      .getByTestId("mention-group-thread")
      .querySelector("[data-testid='mention-result-secondary']")
    expect(channel?.textContent).toBe("3 members")
    expect(agent?.textContent).toBe("@shipping")
  })
})

// "What is this 'Email-bounce dashboard for support' that appears tons of
// times?" — one flat list, four same-titled TASKS above the agent the writer
// was reaching for, every row drawn alike.
describe("mention picker grouping", () => {
  beforeEach(() => {
    resetThreadStore()
    results.value = []
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  const task = (n: number): MentionResult => ({
    type: "task",
    id: `task-${n}`,
    label: "Email-bounce dashboard for support",
    secondaryLabel: `Project ${n}`,
    app: "projects",
    entityType: "task",
  })

  it("leads with people, then agents, and gives every group a kind heading", async () => {
    results.value = [
      task(1),
      task(2),
      { type: "user", id: "u1", label: "Sam Support", secondaryLabel: "sam@acme.test" },
      { type: "agent", id: "a1", label: "support", secondaryLabel: "@support" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-group-heading").length).toBe(3))
    const headings = screen.getAllByTestId("mention-group-heading").map((h) => h.textContent)
    expect(headings).toEqual(["People", "Agents", "Tasks"])
  })

  it("caps a kind the trigger is not about at three rows", async () => {
    results.value = [
      { type: "agent", id: "a1", label: "support", secondaryLabel: "@support" },
      task(1),
      task(2),
      task(3),
      task(4),
      task(5),
    ]
    renderPicker()
    await waitFor(() => expect(screen.getByTestId("mention-group-task")).toBeTruthy())
    // Five tasks flooded the eight-row page and buried the agent.
    expect(
      screen.getByTestId("mention-group-task").querySelectorAll("[data-testid^='mention-result-']")
        .length,
    ).toBeGreaterThan(0)
    expect(screen.getAllByTestId("mention-result-task")).toHaveLength(3)
    expect(screen.getAllByTestId("mention-result-agent")).toHaveLength(1)
  })

  it("puts no row outside a kind", async () => {
    results.value = [
      { type: "widget", id: "w1", label: "Some record", app: "acme", entityType: "widget" },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getByTestId("mention-group-widget")).toBeTruthy())
    expect(screen.getByTestId("mention-group-heading").textContent).toBe("Other")
  })
})

// Contacts are entities: `#` offers them, in their own group, with a mark of
// their own. Under `@` they came before the colleagues a writer wanted.
describe("a contact under #", () => {
  beforeEach(() => {
    resetThreadStore()
    results.value = []
  })
  afterEach(() => {
    cleanup()
    resetThreadStore()
  })

  it("is grouped under Contacts after the channels, with the contact card mark", async () => {
    results.value = [
      { type: "contact", id: "c1", label: "Acme buyer", app: "kernel", entityType: "contact" },
      { type: "thread", id: "t1", label: "logistics" },
    ]
    render(() => (
      <MentionAutocomplete
        query=""
        trigger="#"
        position={{ bottom: 0, left: 0 }}
        onSelect={() => {}}
        onClose={() => {}}
      />
    ))
    await waitFor(() => expect(screen.getByTestId("mention-group-contact")).toBeTruthy())
    const headings = screen.getAllByTestId("mention-group-heading").map((h) => h.textContent)
    expect(headings).toEqual(["Channels", "Contacts"])
    const glyph = document.querySelector("[data-entity-type='contact']")
    // A contact is not a colleague: it must not draw the member's person mark.
    expect(glyph?.querySelector(".lucide-contact")).not.toBeNull()
    expect(glyph?.querySelector(".lucide-user")).toBeNull()
  })

  it("a colleague away shows away until a date, and is still listed", async () => {
    results.value = [
      { type: "user", id: "u-2", label: "Élodie Renard", away: { until: "2099-12-20" } },
      { type: "user", id: "u-3", label: "Tom Reyes", away: null },
    ]
    renderPicker()
    await waitFor(() => expect(screen.getAllByTestId("mention-result-user")).toHaveLength(2))
    const away = screen.getAllByTestId("mention-result-away")
    expect(away).toHaveLength(1)
    expect(away[0]?.textContent).toMatch(/away until (20 Dec|Dec 20)/)
  })
})
