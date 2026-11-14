// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A35: a channel's handle is its name. Before this, POST /api/threads with the
// title "growth-experiments" answered `thread-15` and the Home sidebar printed
// `#thread-15` for a room everyone calls #growth-experiments.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { PrivilegedDbTestAccess, withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  allocateThreadHandle,
  isDerivedThreadHandle,
  slugifyTitle,
} from "~/modules/threads/thread-handle"

const ORG = "550e8400-e29b-41d4-a716-4466554400a0"
const USER1 = "550e8400-e29b-41d4-a716-4466554400a1"
const USER2 = "550e8400-e29b-41d4-a716-4466554400a2"
const ROLE = "550e8400-e29b-41d4-a716-4466554400a3"

let token: string

async function createThreadVia(body: Record<string, unknown>) {
  const res = await app.request("/api/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ forceCreate: true, participantIds: [USER2], ...body }),
  })
  const json = (await res.json()) as { data?: { id: string; handle: string } }
  return { status: res.status, data: json.data }
}

describe("channel handles are their names", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'HandleOrg', 'handleorg') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'handle1@t.com', 'H1') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'handle2@t.com', 'H2') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description) VALUES (${ROLE}, ${ORG}, 'handle-admin', 'Handle admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${USER1}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    token = await signAccessToken(
      {
        userId: USER1,
        orgId: ORG,
        name: "H1",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("derives the handle from the title on create", async () => {
    const res = await createThreadVia({ title: "growth-experiments" })
    expect(res.status).toBe(200)
    expect(res.data?.handle).toBe("growth-experiments")

    const spaced = await createThreadVia({ title: "Q2 Marketing Plan!" })
    expect(spaced.data?.handle).toBe("q2-marketing-plan")
  })

  it("gives two same titled channels distinct handles", async () => {
    const first = await createThreadVia({ title: "Release Notes" })
    const second = await createThreadVia({ title: "Release Notes" })
    expect(first.data?.handle).toBe("release-notes")
    expect(second.data?.handle).toBe("release-notes-2")
    expect(second.data?.handle).not.toBe(first.data?.handle)
  })

  it("keeps thread-N for an untitled room", async () => {
    const res = await createThreadVia({})
    expect(res.data?.handle).toMatch(/^thread-\d+$/)
  })

  it("moves the handle with the title when nobody hand named it", async () => {
    const created = await createThreadVia({ title: "Ops Sync" })
    expect(created.data?.handle).toBe("ops-sync")
    const patched = await app.request(`/api/threads/${created.data?.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Ops Weekly" }),
    })
    expect(patched.status).toBe(200)
    const body = (await patched.json()) as { data: { handle: string } }
    expect(body.data.handle).toBe("ops-weekly")
  })

  it("reads the taken handles on a privileged caller's own transaction, never a second slot", async () => {
    PrivilegedDbTestAccess.record()
    let handles: string[] = []
    try {
      handles = await withPrivilegedDb(ORG, "handle-caller", async (tx) => [
        await allocateThreadHandle(tx, { orgId: ORG, title: "Slot Check" }),
        await allocateThreadHandle(tx, { orgId: ORG, title: null }),
      ])
    } finally {
      const nested = PrivilegedDbTestAccess.recorded().filter((a) => a.nested)
      expect(nested.map((a) => a.reason)).toEqual([])
    }
    expect(handles[0]).toBe("slot-check")
    expect(handles[1]).toMatch(/^thread-\d+$/)
  })

  it("slugifies to lowercase ascii and recognises its own output", () => {
    expect(slugifyTitle("Réunion  d'équipe !")).toBe("reunion-d-equipe")
    expect(slugifyTitle("???")).toBe("")
    expect(isDerivedThreadHandle("thread-15", null)).toBe(true)
    expect(isDerivedThreadHandle("ops-sync", "Ops Sync")).toBe(true)
    expect(isDerivedThreadHandle("ops-sync-2", "Ops Sync")).toBe(true)
    expect(isDerivedThreadHandle("watercooler", "Ops Sync")).toBe(false)
  })
})
