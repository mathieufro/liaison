// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-admin", name: "Nadia" }),
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn() }),
  useOptionalApi: () => ({ get: vi.fn(), post: vi.fn() }),
}))
const { ensurePersonalAgentDm, sendMessage, openTab } = vi.hoisted(() => ({
  ensurePersonalAgentDm: vi.fn(async () => "thread-personal"),
  sendMessage: vi.fn(async () => undefined),
  openTab: vi.fn(),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({ ensurePersonalAgentDm }))
vi.mock("~/modules/threads/message-store", () => ({ sendMessage }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab }))
const { runTool, markStaleAndReload, resolveLocally } = vi.hoisted(() => ({
  runTool: vi.fn(async () => ({})),
  markStaleAndReload: vi.fn(),
  resolveLocally: vi.fn(),
}))
vi.mock("~/lib/run-tool", () => ({ runTool }))
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: { markStaleAndReload, resolveLocally },
}))

import {
  AskReassignButton,
  BackToFiveDaysButton,
  offersAskDraft,
} from "~/modules/shell/AttentionRowExtras"

const unowned: AttentionItem = {
  id: "ev-unowned",
  app: "kernel",
  entity: "user",
  entityId: "u-lea",
  kind: "kernel:companies.unowned" as AttentionItem["kind"],
  summary: "2 companies have no account manager since Léa Fontaine left",
  urgency: 40,
  occurredAt: "2026-11-08T12:00:00.000Z",
  action: { type: "open_entity", tabType: "kernel:user", entityId: "u-lea" },
  persisted: true,
  metadata: { leftUserId: "u-lea", companyIds: ["c-1", "c-2"], count: 2 },
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Ask agent to reassign", () => {
  it("asks the Personal agent about the row with its companies, then opens that conversation", async () => {
    render(() => <AskReassignButton item={unowned} testId="row" compact={false} />)
    fireEvent.click(screen.getByTestId("row-ask-reassign"))
    await vi.waitFor(() => expect(openTab).toHaveBeenCalled())
    expect(ensurePersonalAgentDm).toHaveBeenCalledTimes(1)
    const [, threadId, text, author, opts] = sendMessage.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      { id: string },
      { currentView: { tabType: string; entityId: string } },
    ]
    expect(threadId).toBe("thread-personal")
    expect(text).toContain("2 companies have no account manager since Léa Fontaine left")
    expect(text).toContain("c-1, c-2")
    expect(author.id).toBe("u-admin")
    expect(opts.currentView).toEqual({ tabType: "kernel:user", entityId: "u-lea" })
    expect(openTab.mock.calls[0]?.[0]).toMatchObject({
      type: "thread",
      entityId: "thread-personal",
    })
  })

  it("is offered only on a row that lists companies, and that row asks for no draft", () => {
    expect(offersAskDraft(unowned)).toBe(false)
    render(() => (
      <AskReassignButton
        item={{ ...unowned, metadata: { leftUserId: "u-lea" } }}
        testId="bare"
        compact={false}
      />
    ))
    expect(screen.queryByTestId("bare-ask-reassign")).toBeNull()
  })
})

describe("Back to 5 days", () => {
  const named = (days: number): AttentionItem => ({
    id: "ev-days",
    app: "kernel",
    entity: "agent_notification",
    entityId: "u-admin",
    kind: "agent_notification" as AttentionItem["kind"],
    summary: `Paul set your days per week to ${days}`,
    urgency: 40,
    occurredAt: "2026-11-08T12:00:00.000Z",
    action: { type: "open_entity", tabType: "settings", entityId: "apps/projects" },
    persisted: true,
    metadata: { capacityNamed: { setBy: "u-paul", daysPerWeek: days } },
  })

  it("sets the person's own days per week back to 5 and clears the line", async () => {
    render(() => <BackToFiveDaysButton item={named(4)} testId="row" compact={false} />)
    fireEvent.click(screen.getByTestId("row-back-to-five"))
    await vi.waitFor(() => expect(markStaleAndReload).toHaveBeenCalled())
    expect(runTool).toHaveBeenCalledWith(
      expect.anything(),
      "projects:time_settings_set",
      { daysPerWeek: 5 },
      expect.anything(),
    )
    expect(resolveLocally).toHaveBeenCalledWith("ev-days")
  })

  it("is offered only on the line that names a changed count", () => {
    render(() => <BackToFiveDaysButton item={unowned} testId="row" compact={false} />)
    expect(screen.queryByTestId("row-back-to-five")).toBeNull()
  })
})
