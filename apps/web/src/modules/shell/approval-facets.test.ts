// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import {
  ACCESS_REQUESTS_FACET,
  approvalActionFacets,
  approvalActionKey,
  facetsWithSelection,
  filterApprovalsByAction,
  isApprovalItem,
  isOthersItem,
  partitionByAction,
  partitionOthersRows,
  ROUTINE_RUNS_FACET,
  reconcileSelection,
  shouldShowApprovalFacets,
} from "./approval-facets"

function approval(
  toolName: string | null,
  actionLabel?: string,
  id = toolName ?? "x",
): AttentionItem {
  return {
    id: `kernel:approval_pending:${id}`,
    app: "kernel",
    entity: "approval_request",
    entityId: id,
    kind: "approval_pending",
    summary: "Something pends",
    urgency: 60,
    occurredAt: "2026-08-03T10:00:00.000Z",
    action: { type: "decide_approval", approvalId: id },
    metadata: {
      ...(toolName ? { toolName } : {}),
      ...(actionLabel ? { actionLabel } : {}),
    },
  } as unknown as AttentionItem
}

function nonApproval(kind: string, id: string): AttentionItem {
  return {
    id: `x:${id}`,
    app: "tickets",
    entity: "ticket",
    entityId: id,
    kind,
    summary: "Not an approval",
    urgency: 90,
    occurredAt: "2026-08-03T10:00:00.000Z",
    action: { type: "open_entity", entityId: id },
  } as unknown as AttentionItem
}

describe("approvalActionKey / isApprovalItem", () => {
  it("reads the gated tool id off an approval", () => {
    expect(approvalActionKey(approval("tickets:reply"))).toBe("tickets:reply")
    expect(isApprovalItem(approval("tickets:reply"))).toBe(true)
  })

  it("is null for a non-approval row", () => {
    expect(approvalActionKey(nonApproval("sla_risk", "t1"))).toBe(null)
    expect(isApprovalItem(nonApproval("sla_risk", "t1"))).toBe(false)
  })

  it("is null for an approval with no toolName (a stale cached feed)", () => {
    expect(approvalActionKey(approval(null))).toBe(null)
  })
  it("lists access requests and waiting routine runs, each under its kind facet", () => {
    const access = nonApproval("scope_request", "sr1")
    const wait = nonApproval("routine_mailbox_wait", "w1")
    expect(isApprovalItem(access)).toBe(true)
    expect(isApprovalItem(wait)).toBe(true)
    expect(approvalActionKey(access)).toBe(ACCESS_REQUESTS_FACET)
    expect(approvalActionKey(wait)).toBe(ROUTINE_RUNS_FACET)
    const facets = approvalActionFacets([approval("tickets:reply"), access, wait, access])
    expect(facets.find((f) => f.key === ACCESS_REQUESTS_FACET)).toMatchObject({
      count: 2,
      labelKey: "kernel.approvalKinds.accessRequests",
    })
    expect(facets.find((f) => f.key === ROUTINE_RUNS_FACET)?.labelKey).toBe(
      "kernel.approvalKinds.routineRuns",
    )
    // A kept selection's zero-count chip keeps its label too.
    expect(facetsWithSelection([], ROUTINE_RUNS_FACET)[0]?.labelKey).toBe(
      "kernel.approvalKinds.routineRuns",
    )
  })
})

describe("approvalActionFacets", () => {
  it("builds one facet per distinct action, biggest pile first", () => {
    const facets = approvalActionFacets([
      approval("tickets:reply", "Tickets: reply", "a1"),
      approval("boxtal:create_shipment", "Boxtal: create shipment", "a2"),
      approval("tickets:reply", "Tickets: reply", "a3"),
      approval("tickets:reply", "Tickets: reply", "a4"),
    ])
    expect(facets).toEqual([
      { key: "tickets:reply", label: "Tickets: reply", count: 3 },
      { key: "boxtal:create_shipment", label: "Boxtal: create shipment", count: 1 },
    ])
  })

  it("is derived from what is pending, never a hardcoded app list", () => {
    // A newly installed app's gated tool must face up with no code change.
    const facets = approvalActionFacets([
      approval("brand_new_app:do_thing", "Brand new app: do thing"),
    ])
    expect(facets).toEqual([
      { key: "brand_new_app:do_thing", label: "Brand new app: do thing", count: 1 },
    ])
  })

  it("keys on the tool id, not the humanized label", () => {
    // Two distinct tools that humanize alike must stay separately selectable.
    const facets = approvalActionFacets([
      approval("a:send", "Send", "a1"),
      approval("b:send", "Send", "a2"),
    ])
    expect(facets.map((f) => f.key).sort()).toEqual(["a:send", "b:send"])
  })

  it("falls back to the raw id when no humanized label was recorded", () => {
    expect(approvalActionFacets([approval("tickets:reply")])[0]!.label).toBe("tickets:reply")
  })

  it("ignores non-approval rows entirely", () => {
    expect(
      approvalActionFacets([nonApproval("sla_risk", "t1"), nonApproval("mention", "t2")]),
    ).toEqual([])
  })

  it("contributes no facet for an approval missing its toolName", () => {
    // No invented "Unknown" bucket -- it stays visible under All, just not
    // selectable.
    expect(approvalActionFacets([approval(null)])).toEqual([])
  })

  it("breaks count ties by label so the order is stable across refreshes", () => {
    const facets = approvalActionFacets([
      approval("z:one", "Zulu: one", "a1"),
      approval("a:one", "Alpha: one", "a2"),
    ])
    expect(facets.map((f) => f.label)).toEqual(["Alpha: one", "Zulu: one"])
  })
})

describe("filterApprovalsByAction", () => {
  const items = [
    approval("tickets:reply", "Tickets: reply", "a1"),
    approval("boxtal:create_shipment", "Boxtal: create shipment", "a2"),
    nonApproval("sla_risk", "t1"),
  ]

  it("returns everything when nothing is selected", () => {
    expect(filterApprovalsByAction(items, null)).toHaveLength(3)
  })

  it("keeps only the selected action's approvals", () => {
    const out = filterApprovalsByAction(items, "tickets:reply")
    expect(out.filter((i) => i.action?.type === "decide_approval").map((i) => i.entityId)).toEqual([
      "a1",
    ])
  })

  it("NEVER hides a non-approval row", () => {
    // The whole point of the scoping: focusing the approval queue must not make
    // an unrelated urgent item silently disappear from the feed.
    const out = filterApprovalsByAction(items, "tickets:reply")
    expect(out.some((i) => i.kind === "sla_risk")).toBe(true)
  })

  it("hides an approval with no toolName when a filter is active", () => {
    const out = filterApprovalsByAction(
      [approval(null, undefined, "a9"), ...items],
      "tickets:reply",
    )
    expect(out.map((i) => i.entityId)).not.toContain("a9")
  })
})

describe("shouldShowApprovalFacets", () => {
  it("needs at least two distinct actions to be worth showing", () => {
    expect(shouldShowApprovalFacets([])).toBe(false)
    expect(shouldShowApprovalFacets([{ key: "a", label: "A", count: 9 }])).toBe(false)
    expect(
      shouldShowApprovalFacets([
        { key: "a", label: "A", count: 1 },
        { key: "b", label: "B", count: 1 },
      ]),
    ).toBe(true)
  })
})

describe("reconcileSelection", () => {
  const facets = [{ key: "tickets:reply", label: "Tickets: reply", count: 2 }]

  it("keeps a selection that still has pending approvals", () => {
    expect(reconcileSelection("tickets:reply", facets)).toBe("tickets:reply")
  })

  it("KEEPS a selection whose last approval was just decided (ticket-10225)", () => {
    // Clearing a pile must not itself widen the view: the operator's cursor is
    // already travelling to the next Approve button, and a list that silently
    // becomes the whole queue turns that click into a mis-approval.
    expect(reconcileSelection("boxtal:create_shipment", facets)).toBe("boxtal:create_shipment")
    expect(reconcileSelection("tickets:reply", [])).toBe("tickets:reply")
  })

  it("passes through no-selection", () => {
    expect(reconcileSelection(null, facets)).toBe(null)
  })
})

describe("facetsWithSelection", () => {
  const facets = [{ key: "tickets:reply", label: "Tickets: reply", count: 2 }]

  it("leaves the live facets alone when the selection is among them", () => {
    expect(facetsWithSelection(facets, "tickets:reply")).toEqual(facets)
    expect(facetsWithSelection(facets, null)).toEqual(facets)
  })

  it("keeps a cleared selection visible as a zero-count chip", () => {
    // reconcileSelection now keeps the selection, so there must still be a chip
    // showing where the operator is and one click to get back to All.
    const out = facetsWithSelection(facets, "boxtal:create_shipment")
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({
      key: "boxtal:create_shipment",
      label: "boxtal:create_shipment",
      count: 0,
    })
  })
})

describe("partitionByAction (ticket-10195)", () => {
  const items = [
    approval("tickets:reply", "Tickets: reply", "a1"),
    approval("boxtal:create_shipment", "Boxtal: create shipment", "a2"),
    approval(null, undefined, "a9"),
    nonApproval("sla_risk", "t1"),
  ]

  it("puts everything in `matched` when no facet is active", () => {
    const { matched, alsoShown } = partitionByAction(items, null)
    expect(matched).toHaveLength(4)
    expect(alsoShown).toHaveLength(0)
  })

  it("separates the selected approvals from the rows shown anyway", () => {
    // The SLA fire is still on screen — it was never the filter leaking, it was
    // the filter having no way to say why that row is there.
    const { matched, alsoShown } = partitionByAction(items, "tickets:reply")
    expect(matched.map((i) => i.entityId)).toEqual(["a1"])
    expect(alsoShown.map((i) => i.entityId)).toEqual(["t1"])
  })

  it("agrees with filterApprovalsByAction: the two lists together ARE the filtered feed", () => {
    // The partition must not change WHAT is visible, only how it is grouped —
    // otherwise labelling the kept rows would quietly become a behaviour change.
    for (const key of ["tickets:reply", "boxtal:create_shipment", "nope:none"]) {
      const { matched, alsoShown } = partitionByAction(items, key)
      expect([...matched, ...alsoShown].map((i) => i.entityId).sort()).toEqual(
        filterApprovalsByAction(items, key)
          .map((i) => i.entityId)
          .sort(),
      )
    }
  })
})

describe("rows for someone else", () => {
  function placed(id: string, placement: string | undefined, peer?: boolean): AttentionItem {
    const item = approval("projects:create", "Projects: create", id)
    return {
      ...item,
      metadata: {
        ...item.metadata,
        ...(placement === undefined ? {} : { placement }),
        ...(peer === undefined ? {} : { peerSelfApprovable: peer }),
      },
    } as AttentionItem
  }

  it("puts only the rows the server placed for others in the others half", () => {
    const items = [placed("a", "others"), placed("b", "mine"), placed("c", "standing_in")]
    const { mine, others } = partitionOthersRows(items)
    expect(others.map((i) => i.entityId)).toEqual(["a"])
    expect(mine.map((i) => i.entityId)).toEqual(["b", "c"])
  })

  it("an old feed with no placement reads mine, even with the peer flag set", () => {
    const items = [placed("legacy", undefined, true)]
    const { mine, others } = partitionOthersRows(items)
    expect(others).toEqual([])
    expect(mine.map((i) => i.entityId)).toEqual(["legacy"])
    expect(isOthersItem(items[0]!)).toBe(false)
  })

  it("never treats a non-approval attention item as for others", () => {
    const item = nonApproval("mention", "m1")
    const withFlag = { ...item, metadata: { placement: "others" } } as AttentionItem
    expect(isOthersItem(withFlag)).toBe(false)
  })
})
