// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { resolveRecipients } from "./recipients"

const ORG = "org-1"

describe("resolveRecipients", () => {
  it("kind=field returns single user id wrapped", async () => {
    const r = await resolveRecipients(
      { kind: "field", path: "data.assigneeId" },
      { data: { assigneeId: "u-1" } } as any,
      { orgId: ORG },
    )
    expect(r).toEqual(["u-1"])
  })

  it("kind=field returns [] when missing", async () => {
    const r = await resolveRecipients(
      { kind: "field", path: "data.missing" },
      { data: {} } as any,
      { orgId: ORG },
    )
    expect(r).toEqual([])
  })

  it("kind=participants returns array from path", async () => {
    const r = await resolveRecipients(
      { kind: "participants", path: "data.participantIds" },
      { data: { participantIds: ["u-1", "u-2"] } } as any,
      { orgId: ORG },
    )
    expect(r).toEqual(["u-1", "u-2"])
  })

  it("kind=mentions filters to type=user only and dedupes", async () => {
    const r = await resolveRecipients(
      { kind: "mentions", path: "data.mentions" },
      {
        data: {
          mentions: [
            { type: "user", id: "u-1" },
            { type: "thread", id: "t-1" },
            { type: "user", id: "u-1" },
            { type: "user", id: "u-2" },
          ],
        },
      } as any,
      { orgId: ORG },
    )
    expect(r.sort()).toEqual(["u-1", "u-2"])
  })

  it("kind=mentions scans string for data-mention-ref and @[name](user:uuid) but ignores @handle", async () => {
    const r = await resolveRecipients(
      { kind: "mentions", path: "data.body" },
      {
        data: {
          body:
            'Hi @bob and <span data-mention-ref="user:u-1">@Alice</span> ' +
            "and @[Charlie](user:u-3) — but not @free-handle.",
        },
      } as any,
      { orgId: ORG },
    )
    expect(r.sort()).toEqual(["u-1", "u-3"])
  })

  it("kind=actor returns [actorId] excluding null actors", async () => {
    expect(
      await resolveRecipients({ kind: "actor" }, { actorId: "a-1" } as any, { orgId: ORG }),
    ).toEqual(["a-1"])
    expect(
      await resolveRecipients({ kind: "actor" }, { actorId: null } as any, { orgId: ORG }),
    ).toEqual([])
  })

  it("kind=scope_holders calls loader with org+scope and returns ids", async () => {
    const loader = mock(async (orgId: string, scope: string) => {
      expect(orgId).toBe(ORG)
      expect(scope).toBe("kernel:threads:read")
      return ["u-1", "u-2"]
    })
    const r = await resolveRecipients(
      { kind: "scope_holders", scope: "kernel:threads:read" },
      { actorId: "a-1" } as any,
      { orgId: ORG, loadScopeHolders: loader },
    )
    expect(r.sort()).toEqual(["u-1", "u-2"])
  })

  // Phase 16 Task A2 — subscription narrowing applies after the resolver.
  it("applySubscriptionFilter drops candidates whose rules exclude them", async () => {
    const loader = mock(async () => ["u-A", "u-B"])
    const r = await resolveRecipients(
      { kind: "scope_holders", scope: "shopify:orders:read" },
      { actorId: null, data: {} } as any,
      {
        orgId: ORG,
        loadScopeHolders: loader,
        applySubscriptionFilter: async (id) => id === "u-A",
      },
    )
    expect(r).toEqual(["u-A"])
  })

  it("applySubscriptionFilter cannot widen — only users already in the resolved set survive", async () => {
    const loader = mock(async () => ["u-A"])
    const r = await resolveRecipients(
      { kind: "scope_holders", scope: "shopify:orders:read" },
      { actorId: null, data: {} } as any,
      {
        orgId: ORG,
        loadScopeHolders: loader,
        // permissive — yet u-B is not in the resolved set, so it cannot appear
        applySubscriptionFilter: async () => true,
      },
    )
    expect(r).toEqual(["u-A"])
  })

  it("applySubscriptionFilter is not invoked when the resolved set is empty (back-compat)", async () => {
    const filter = mock(async () => true)
    const r = await resolveRecipients(
      { kind: "field", path: "data.missing" },
      { data: {} } as any,
      { orgId: ORG, applySubscriptionFilter: filter },
    )
    expect(r).toEqual([])
    expect(filter).not.toHaveBeenCalled()
  })

  it("no applySubscriptionFilter is back-compat (no narrowing applied)", async () => {
    const loader = mock(async () => ["u-A", "u-B"])
    const r = await resolveRecipients(
      { kind: "scope_holders", scope: "shopify:orders:read" },
      { actorId: null, data: {} } as any,
      { orgId: ORG, loadScopeHolders: loader },
    )
    expect(r.sort()).toEqual(["u-A", "u-B"])
  })

  describe("kind=account_manager", () => {
    const spec = { kind: "account_manager", path: "data.companyId" } as const
    const event = { data: { companyId: "c-1" } } as any

    it("the company's manager, and nobody else", async () => {
      const loadScopeHolders = mock(async () => ["u-1", "u-2"])
      const r = await resolveRecipients(spec, event, {
        orgId: ORG,
        loadScopeHolders,
        loadAccountManager: async (_org, companyId) => (companyId === "c-1" ? "u-mgr" : null),
      })
      expect(r).toEqual(["u-mgr"])
      expect(loadScopeHolders).not.toHaveBeenCalled()
    })

    it("no manager is nobody, never every scope holder", async () => {
      const loadScopeHolders = mock(async () => ["u-1", "u-2"])
      for (const loadAccountManager of [undefined, async () => null]) {
        const r = await resolveRecipients(spec, event, {
          orgId: ORG,
          loadScopeHolders,
          ...(loadAccountManager ? { loadAccountManager } : {}),
        })
        expect(r).toEqual([])
      }
      expect(loadScopeHolders).not.toHaveBeenCalled()
    })

    it("no manager with a fallback asks only the named fallback", async () => {
      const r = await resolveRecipients(
        { ...spec, fallback: { kind: "field", path: "data.senderId" } },
        { data: { companyId: "c-1", senderId: "u-sender" } } as any,
        { orgId: ORG, loadAccountManager: async () => null },
      )
      expect(r).toEqual(["u-sender"])
    })
  })
})
