// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A46, the same-resource allowance under the scope-taint guard. A3 forbids a tainted turn every
// write outside the three enforcing sinks, which refused the everyday support routine: read
// ticket A, reply to ticket A. The allowance is narrow and measured against the taint's OWN
// origin rows, so a different ticket, a different table, a write with no declared row and an
// undeclared tool all stay refused.
//
// The declarations under test are the REAL ones on the tickets manifest, read through the tool
// registry the runtime builds, and the two lines that record an origin are the two
// executeToolCore runs. A typo in either must fail here.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import {
  checkToolScopeTaint,
  type ToolTaintDeclaration,
  taintOriginOf,
  UNDECLARED_WRITE_TARGET,
} from "~/modules/agent/scopes/scope-taint"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { assertNoScopeTaintedWrite } from "~/services/security/visibility"

const TICKETS = "app_tickets.tickets"
const TICKET_A = "11111111-1111-4111-8111-111111111111"
const TICKET_B = "22222222-2222-4222-8222-222222222222"
const TAINTED = ["tickets:tickets:read"]

const manifestTools = ticketsManifest.tools as Record<
  string,
  {
    readOnly?: boolean
    writesToTable?: string
    readsFromTable?: string
    targetRowParam?: string
    resultRowPath?: string
    params?: { properties?: Record<string, unknown> }
  }
>

/** What `tickets:get` returns for ticket A: the row is wrapped, hence its resultRowPath. */
const GOT_TICKET_A = { ticket: { id: TICKET_A }, messages: { items: [], nextCursor: null } }

/** The turn as the kernel keeps it: what it read, and which rows the read RETURNED (A46b). */
function turnThatRead(toolName: string, args: unknown, result: unknown) {
  const accumulator = createTurnScopeAccumulator()
  accumulator.recordInjected(TAINTED)
  const origin = taintOriginOf(manifestTools[toolName] as ToolTaintDeclaration, args, result)
  if (origin) accumulator.recordOriginRows(origin.table, origin.rowIds)
  return accumulator
}

describe("A46 same-resource allowance: a tainted turn may write back to the row it read", () => {
  it("reads ticket A and replies to ticket A: allowed", () => {
    const turn = turnThatRead("get", { ticketId: TICKET_A }, GOT_TICKET_A)
    expect(turn.originRows()).toEqual({ [TICKETS]: [TICKET_A] })
    expect(
      checkToolScopeTaint(turn.snapshot(), manifestTools.reply as ToolTaintDeclaration, {
        args: { ticketId: TICKET_A, textBody: "here is the answer" },
        originRows: turn.originRows(),
      }),
    ).toBeNull()
  })

  it("reads ticket A and replies to ticket B: refused, and the refusal names the table", () => {
    const turn = turnThatRead("get", { ticketId: TICKET_A }, GOT_TICKET_A)
    const refused = checkToolScopeTaint(
      turn.snapshot(),
      manifestTools.reply as ToolTaintDeclaration,
      { args: { ticketId: TICKET_B, textBody: "wrong ticket" }, originRows: turn.originRows() },
    )
    expect(refused).toMatchObject({
      ok: false,
      code: "E_SCOPE_TAINT_BLOCKED",
      writeTargetTable: TICKETS,
      reason: "scope_taint_blocked",
    })
  })

  it("reads ticket A and writes a contact: refused, the allowance is per table", () => {
    const turn = turnThatRead("get", { ticketId: TICKET_A }, GOT_TICKET_A)
    const refused = checkToolScopeTaint(
      turn.snapshot(),
      { writesToTable: "kernel.contacts", targetRowParam: "contactId" },
      { args: { contactId: TICKET_A }, originRows: turn.originRows() },
    )
    expect(refused?.writeTargetTable).toBe("kernel.contacts")
  })

  it("reads ticket A and writes the same table with no declared row: refused", () => {
    const turn = turnThatRead("get", { ticketId: TICKET_A }, GOT_TICKET_A)
    // merge writes several ticket rows at once, so it declares the table and NO row
    // parameter: the allowance cannot apply and it stays refused.
    expect(manifestTools.merge?.targetRowParam).toBeUndefined()
    const refused = checkToolScopeTaint(
      turn.snapshot(),
      manifestTools.merge as ToolTaintDeclaration,
      {
        args: { targetTicketId: TICKET_A, sourceTicketIds: [TICKET_B] },
        originRows: turn.originRows(),
      },
    )
    expect(refused?.writeTargetTable).toBe(TICKETS)
  })

  it("an undeclared tool is still refused with the undeclared wording", () => {
    const turn = turnThatRead("get", { ticketId: TICKET_A }, GOT_TICKET_A)
    const refused = checkToolScopeTaint(
      turn.snapshot(),
      {},
      { args: { ticketId: TICKET_A }, originRows: turn.originRows() },
    )
    expect(refused?.writeTargetTable).toBe(UNDECLARED_WRITE_TARGET)
    expect(refused?.writeTargetTable).toBe("undeclared")
  })

  it("a read that names no row contributes no origin, so a reply after it is refused", () => {
    // search reads many rows and names none of them in its arguments, so it cannot
    // narrow the allowance, and under A46b a row it merely returned is not an origin
    // either. Recorded here as the KNOWN BOUND of A46, not as a wish.
    const turn = turnThatRead("search", { q: "handshake" }, { items: [{ id: TICKET_A }] })
    expect(turn.originRows()).toEqual({})
    expect(
      checkToolScopeTaint(turn.snapshot(), manifestTools.reply as ToolTaintDeclaration, {
        args: { ticketId: TICKET_A, textBody: "from a search" },
        originRows: turn.originRows(),
      }),
    ).not.toBeNull()
  })

  it("an untainted turn is unaffected", () => {
    expect(
      checkToolScopeTaint([], manifestTools.reply as ToolTaintDeclaration, {
        args: { ticketId: TICKET_B },
        originRows: {},
      }),
    ).toBeNull()
  })
})

describe("A46 at the executeToolCore guard: assertNoScopeTaintedWrite", () => {
  it("allows the same row and refuses another one, with the refusal text unchanged", () => {
    expect(() =>
      assertNoScopeTaintedWrite(TICKETS, TAINTED, {
        rowIds: [TICKET_A],
        originRows: { [TICKETS]: [TICKET_A] },
      }),
    ).not.toThrow()
    expect(() =>
      assertNoScopeTaintedWrite(TICKETS, TAINTED, {
        rowIds: [TICKET_B],
        originRows: { [TICKETS]: [TICKET_A] },
      }),
    ).toThrow(
      `E_SCOPE_TAINT_BLOCKED: this turn has read scoped data and may not write to ${TICKETS}`,
    )
  })

  it("the unmarked case keeps its wording, character for character", () => {
    expect(() => assertNoScopeTaintedWrite(UNDECLARED_WRITE_TARGET, TAINTED)).toThrow(
      "E_SCOPE_TAINT_BLOCKED: this turn has read scoped data and may not write to undeclared",
    )
  })
})

// The id-segment and approve-from-home tools touch the org's own settings row
// (kernel.organizations), which an app cannot declare: the runtime drops a kernel
// table named by an app. The two gets are readOnly; the two sets stay undeclared,
// so on a tainted turn they are refused as a write to an undeclared table (fail
// closed), and they are gated anyway.
const KERNEL_SETTINGS_TOOLS = [
  "idSegment.get",
  "idSegment.set",
  "approveFromHome.get",
  "approveFromHome.set",
]

describe("the tickets manifest declares a table for every one of its 60 tools", () => {
  it("every write tool names the table it writes, every read names the table it reads", () => {
    const undeclared: string[] = []
    for (const [name, def] of Object.entries(manifestTools)) {
      const declared =
        typeof def.writesToTable === "string" || typeof def.readsFromTable === "string"
      if (!declared && !KERNEL_SETTINGS_TOOLS.includes(name)) undeclared.push(name)
      // A tool never claims both halves: it writes, or it reads.
      expect([name, typeof def.writesToTable === "string" && def.readOnly === true]).toEqual([
        name,
        false,
      ])
    }
    expect(undeclared).toEqual([])
    // 59: + categories.tree / categories.reorder, the settings page's categories tree.
    // 60: + approval_route_read, who an approval about a ticket is for.
    expect(Object.keys(manifestTools).length).toBe(60)
    expect(manifestTools["idSegment.get"]?.readOnly).toBe(true)
    expect(manifestTools["idSegment.set"]?.writesToTable).toBeUndefined()
    expect(manifestTools["idSegment.set"]?.readOnly).not.toBe(true)
    expect(manifestTools["approveFromHome.get"]?.readOnly).toBe(true)
    expect(manifestTools["approveFromHome.set"]?.writesToTable).toBeUndefined()
    expect(manifestTools["approveFromHome.set"]?.readOnly).not.toBe(true)
  })

  it("the per-ticket write tools carry ticketId as their target row", () => {
    for (const name of [
      "reply",
      "nudge",
      "close",
      "addNote",
      "assign",
      "setStatus",
      "setPriority",
      "reopen",
      "setFollowup",
      "clearFollowup",
    ]) {
      expect([name, manifestTools[name]?.writesToTable]).toEqual([name, TICKETS])
      expect([name, manifestTools[name]?.targetRowParam]).toEqual([name, "ticketId"])
    }
  })

  it("every write tool taking a ticket id declares the tickets resource, not its physical table", () => {
    // A46 measures a write against the rows the turn READ, and what a turn reads is a
    // TICKET. A per-ticket write that names its own physical side table (markRead's
    // read receipts, csat's survey rows) can therefore never match an origin, so it
    // could never run on a tainted turn at all: the support routine that reads ticket
    // A and marks it read was refused for naming the wrong resource, not the wrong row.
    const wrong: string[] = []
    for (const [name, def] of Object.entries(manifestTools)) {
      if (typeof def.writesToTable !== "string") continue
      const params = Object.keys(
        ((def as { params?: { properties?: Record<string, unknown> } }).params?.properties ??
          {}) as Record<string, unknown>,
      )
      const takesTicketId = params.includes("ticketId") || params.includes("ticketIds")
      if (takesTicketId && def.writesToTable !== TICKETS) wrong.push(`${name}:${def.writesToTable}`)
    }
    expect(wrong).toEqual([])
    expect(manifestTools.markRead?.writesToTable).toBe(TICKETS)
    expect(manifestTools.markRead?.targetRowParam).toBe("ticketId")
  })

  it("tickets:get is the origin producer: it reads app_tickets.tickets by ticketId", () => {
    expect(manifestTools.get?.readOnly).toBe(true)
    expect(manifestTools.get?.readsFromTable).toBe(TICKETS)
    expect(manifestTools.get?.targetRowParam).toBe("ticketId")
    expect(manifestTools.get?.resultRowPath).toBe("ticket.id")
    expect(manifestTools.get?.writesToTable).toBeUndefined()
  })
})

describe("the registry keeps the tickets declarations the runtime is allowed to honour", () => {
  const ORG_ID = "00000000-0000-0000-0000-0000000a4600"

  beforeAll(async () => {
    const { sql: drizzleSql } = await import("drizzle-orm")
    const { __privileged_db__: db } = await import("~/db/connection")
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}::uuid, 'Scope Taint Same Resource', ${`taint-a46-${Date.now()}`})
      ON CONFLICT (id) DO NOTHING
    `)
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    const { sql: drizzleSql } = await import("drizzle-orm")
    const { __privileged_db__: db } = await import("~/db/connection")
    await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}::uuid`)
  })

  it("carries readsFromTable and targetRowParam through registration, and the allowance holds end to end", () => {
    const get = toolRegistry.get([ORG_ID, "tickets", "get"])
    const reply = toolRegistry.get([ORG_ID, "tickets", "reply"])
    expect(get?.readsFromTable).toBe(TICKETS)
    expect(get?.targetRowParam).toBe("ticketId")
    expect(get?.resultRowPath).toBe("ticket.id")
    expect(reply?.writesToTable).toBe(TICKETS)
    expect(reply?.targetRowParam).toBe("ticketId")

    const accumulator = createTurnScopeAccumulator()
    accumulator.recordInjected(TAINTED)
    const origin = taintOriginOf(get as ToolTaintDeclaration, { ticketId: TICKET_A }, GOT_TICKET_A)
    if (origin) accumulator.recordOriginRows(origin.table, origin.rowIds)
    expect(
      checkToolScopeTaint(accumulator.snapshot(), reply as ToolTaintDeclaration, {
        args: { ticketId: TICKET_A },
        originRows: accumulator.originRows(),
      }),
    ).toBeNull()
    expect(
      checkToolScopeTaint(accumulator.snapshot(), reply as ToolTaintDeclaration, {
        args: { ticketId: TICKET_B },
        originRows: accumulator.originRows(),
      }),
    ).not.toBeNull()
  })
})
