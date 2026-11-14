// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

import { homeActionItems, homeApprovalItems } from "~/modules/shell/home-action-count"

const approval = (id: string, metadata?: Record<string, unknown>): AttentionItem => ({
  id: `kernel:approval_pending:${id}`,
  app: "kernel",
  entity: "approval_request",
  entityId: id,
  kind: "approval_pending",
  summary: "Refund",
  urgency: 60,
  occurredAt: "2026-11-07T09:00:00.000Z",
  action: { type: "decide_approval", approvalId: id },
  ...(metadata ? { metadata } : {}),
})
const viewer = { userId: "u-1", canGrantAccess: true }

describe("Home's count and rows for someone else", () => {
  it("home-action-count does not count an others row", () => {
    const items = [
      approval("mine", { placement: "mine" }),
      approval("stand", { placement: "standing_in" }),
      approval("other", { placement: "others", peerSelfApprovable: true }),
    ]
    const counted = homeActionItems(items, false, viewer).map((i) => i.entityId)
    expect(counted).toEqual(["mine", "stand"])
    expect(homeApprovalItems(items, false, viewer)).toHaveLength(2)
  })

  it("an old feed with no placement reads mine", () => {
    const items = [approval("legacy", { peerSelfApprovable: true }), approval("bare")]
    expect(
      homeActionItems(items, false, viewer)
        .map((i) => i.entityId)
        .sort(),
    ).toEqual(["bare", "legacy"])
  })
})
