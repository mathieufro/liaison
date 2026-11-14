// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { TICKET_MERGED_REASON } from "~/modules/approvals/cancel"
import {
  buildApprovalSummary,
  humanizeToolName,
  splitToolName,
} from "~/modules/approvals/event-data"

describe("splitToolName", () => {
  it("splits app and short name on the first colon", () => {
    expect(splitToolName("invoicing:documents_mark_paid")).toEqual({
      appName: "invoicing",
      toolShortName: "documents_mark_paid",
    })
  })

  it("returns the whole string as app name when there is no colon", () => {
    expect(splitToolName("standalone")).toEqual({ appName: "standalone", toolShortName: "" })
  })
})

describe("humanizeToolName", () => {
  // Regression B3: a pending-approval tile once titled itself with the raw tool
  // id "invoicing:documents_mark_paid". The humanizer turns it into a readable
  // action label with no raw ids and no dash punctuation.
  it("turns entity_verb tool ids into an imperative action label", () => {
    expect(humanizeToolName("invoicing:documents_mark_paid")).toBe("Invoicing: mark document paid")
  })

  it("handles create/issue style ids (verb moves to the front)", () => {
    expect(humanizeToolName("invoicing:invoice_create_and_issue")).toBe(
      "Invoicing: create invoice and issue",
    )
    expect(humanizeToolName("shopify:orders_cancel")).toBe("Shopify: cancel order")
  })

  it("keeps a verb-first id in order", () => {
    expect(humanizeToolName("tickets:reply")).toBe("Tickets: reply")
    // An -us noun is already singular: "status" must not become "statu".
    expect(humanizeToolName("projects:status_update")).toBe("Projects: update status")
    expect(humanizeToolName("projects:status_add")).toBe("Projects: status add")
    expect(humanizeToolName("mail:send_message")).toBe("Mail: send message")
  })

  it("title-cases the app name alone when there is no action segment", () => {
    expect(humanizeToolName("invoicing")).toBe("Invoicing")
  })

  it("never emits a raw colon-joined tool id", () => {
    const out = humanizeToolName("boxtal:shipment_create")
    expect(out).not.toContain("boxtal:")
    expect(out).toBe("Boxtal: create shipment")
  })

  it("names the kernel's own actions after the Workspace, never 'Kernel'", () => {
    // A reviewer read "Kernel: update skill" on an approval card (iPhone walk,
    // 2026-10-19): the kernel app's display name is "Workspace".
    expect(humanizeToolName("kernel:update_skill")).toBe("Workspace: update skill")
    expect(humanizeToolName("kernel:contacts_merge")).toBe("Workspace: contacts merge")
    expect(humanizeToolName("kernel")).toBe("Workspace")
  })
})

describe("a cancelled request's reason", () => {
  const row = (reason: string) =>
    buildApprovalSummary({
      raw: {
        id: "00000000-0000-4000-8000-000000000001",
        handle: "APR-1",
        status: "cancelled",
        created_at: "2026-10-01T09:00:00Z",
        expires_at: "2026-10-04T09:00:00Z",
        tool_name: "tickets:reply",
        approve_scope: null,
        summary: { kind: "Reply", title: "Reply to the customer", lines: [] },
        current_payload: {},
        thread_id: "00000000-0000-4000-8000-000000000002",
        originating_thread_id: "00000000-0000-4000-8000-000000000002",
        requested_by: "00000000-0000-4000-8000-000000000003",
        notify_user_ids: [],
        reason,
      },
      requester: { kind: "user", id: "00000000-0000-4000-8000-000000000003", name: "Ada" },
      editableFields: [],
      lastEdit: null,
    })

  it("a row a merge cancelled under the old code reads as the sentence a merge stores today", () => {
    expect(row("ticket_merged").reason).toBe(TICKET_MERGED_REASON)
  })

  it("a sentence stored as the reason reads as stored", () => {
    expect(row(TICKET_MERGED_REASON).reason).toBe(TICKET_MERGED_REASON)
    expect(row("Not this week").reason).toBe("Not this week")
  })
})
