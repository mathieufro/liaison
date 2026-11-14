// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of a routine and the person it acts for: a shared weekly routine on its owner's
// personal agent, seeded through the routine factory (the scopes clamped to what the owner holds),
// and its next tick run by the routine worker, which is where an owner's change takes effect.
// Readers read the routine row as the routines page does, under their own row security: `owner`
// owns it, `admin` and `colleague` see it under Shared, and `outsider` is the control.

import { randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { routines } from "~/db/schema/kernel/routines"
import { schemaRef } from "~/db/schema-ref"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { deactivateUser } from "~/modules/users/service"
import { seedContext } from "~/seed/context"
import { seedPersonalAgent } from "~/seed/factories/agent/agents"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"
import { type ApprovalOrg, ctxOf } from "./approval-world"
import type { Reading, Sight } from "./classes"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))

export const ROUTINE_SCOPE = "tickets:tickets:read"
const READERS = ["owner", "admin", "colleague", "outsider"] as const
type Reader = (typeof READERS)[number]

let other: Promise<{ orgId: string; adminUserId: string }> | null = null

/** An admin of another organisation: the reader who never could see the routine. */
function otherOrg() {
  other ??= minimal.secondOrg({ name: "Other Org" })
  return other
}

export class RoutineCase {
  people = {} as Record<Reader, string>
  routineId = ""
  name = ""
  otherOrgId = ""
  /** The way back's first tick paused the routine. */
  pausedBetween = false
  /** What each tick answered, in order. */
  ticks: string[] = []

  constructor(readonly org: ApprovalOrg) {}

  get orgId(): string {
    return this.org.orgId
  }

  async build(): Promise<this> {
    const tag = randomUUID().slice(0, 6)
    this.people.owner = (await minimal.person(this.orgId, { name: `O${tag}owner Rout` })).id
    this.people.colleague = (await minimal.person(this.orgId, { name: `O${tag}colleague Rout` })).id
    const other = await otherOrg()
    this.people.outsider = other.adminUserId
    this.otherOrgId = other.orgId
    this.people.admin = this.org.adminId
    await minimal.grantScope(this.people.owner, ROUTINE_SCOPE)
    for (const who of ["owner", "colleague"] as const)
      await minimal.grantScope(this.people[who], "kernel:routines:read")
    const agent = await seedPersonalAgent(this.orgId, this.people.owner, `owner-${tag}`)
    this.name = `Weekly digest ${tag}`
    const owner = await ctxOf(this.orgId, this.people.owner)
    this.routineId = await seedRoutine(seedContext({ orgId: this.orgId, now: new Date() }), {
      createdByUserId: this.people.owner,
      ownerScopes: owner.scopes,
      enabled: true,
      routine: {
        name: this.name,
        description: "Open tickets every Monday",
        kind: "recurring",
        cron: "0 9 * * 1",
        timezone: "UTC",
        ownerUserId: this.people.owner,
        ownerAgentId: agent.agentId,
        scopes: [ROUTINE_SCOPE],
        prompt: "List the open tickets.",
      },
    })
    return this
  }

  async revoke(): Promise<void> {
    await minimal.revokeScope(this.people.owner, ROUTINE_SCOPE)
  }

  async regain(): Promise<void> {
    await minimal.grantScope(this.people.owner, ROUTINE_SCOPE)
    for (const who of ["owner", "colleague"] as const)
      await minimal.grantScope(this.people[who], "kernel:routines:read")
  }

  async ownerHolds(): Promise<boolean> {
    return (await ctxOf(this.orgId, this.people.owner)).scopes.includes(ROUTINE_SCOPE)
  }

  async deactivateOwner(): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-deactivate-owner", (tx) =>
      deactivateUser(tx, {
        targetId: this.people.owner,
        actorId: this.org.adminId,
        orgId: this.orgId,
        actorScopes: this.org.admin.scopes,
      }),
    )
  }

  async ownerStatus(): Promise<string | null> {
    const [row] =
      (await sql`SELECT status FROM ${K()}.users WHERE id = ${this.people.owner}`) as Array<{
        status: string
      }>
    return row?.status ?? null
  }

  /** The routine's next scheduled tick, as the worker runs it. */
  async tick(): Promise<string> {
    const res = await runRoutineTick({
      orgId: this.orgId,
      routineId: this.routineId,
      scheduledAt: new Date().toISOString(),
    })
    this.ticks.push(res.status)
    return res.status
  }

  async status(): Promise<{ status: string; enabled: boolean }> {
    const row = await withRlsContext(this.org.admin, async (tx) => {
      const [r] = await tx
        .select({ status: routines.status, enabled: routines.enabled })
        .from(routines)
        .where(and(eq(routines.id, this.routineId), eq(routines.orgId, this.orgId)))
      return r
    })
    if (!row) throw new Error("routine row gone")
    return row
  }

  async read(): Promise<Reading> {
    const out: Reading = {}
    for (const r of READERS) out[r] = await this.sightOf(r)
    return out
  }

  private async sightOf(who: Reader): Promise<Sight> {
    const ctx =
      who === "outsider"
        ? await ctxOf(this.otherOrgId, this.people.outsider)
        : await ctxOf(this.orgId, this.people[who])
    const row = await withRlsContext(ctx, async (tx) => {
      const [r] = await tx
        .select({ name: routines.name, status: routines.status, owner: routines.ownerUserId })
        .from(routines)
        .where(eq(routines.id, this.routineId))
      return r
    })
    if (!row) return { visible: false }
    return {
      visible: true,
      label: row.name,
      points: row.owner === this.people.owner ? "owner" : row.owner,
      state: row.status === "active" ? null : row.status,
    }
  }
}
