// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One entry per kept cell that has a test: how its world is built, what the event does, how the
// cell checks the event took effect on its own object, and the facts its class reads. The
// generator (cells.integration.test.ts) turns each into a test, and once more with the event
// replaced by a no-op, which must fail.

import { expect } from "bun:test"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import * as minimal from "~/seed/tiers/minimal"
import {
  ApprovalCase,
  type ApprovalOrg,
  approvalOrg,
  DECIDE_SCOPE,
  projectName,
} from "./approval-world"
import { CalendarCase } from "./calendar-world"
import type { EventFacts, Reading } from "./classes"
import { companyCells } from "./company-cells"
import { MadeCase, type MadeLink, SHARE_SCOPE } from "./dashboard-world"
import type { EventCode } from "./matrix"
import { moneyCells } from "./payments-world"
import { RoutineCase } from "./routine-world"
import { ThreadCase, type ThreadOrg } from "./thread-world"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))

export interface Worlds {
  approvals: ApprovalOrg
  threads: ThreadOrg
  routines: ApprovalOrg
}

/** A built world for one cell: its reading and what the class needs to know. */
export interface CellWorld {
  read(): Promise<Reading>
}

export interface CellImpl<W extends CellWorld = CellWorld> {
  link: string
  event: EventCode
  /** The event in words, as the test title says it. */
  says: string
  build(worlds: Worlds): Promise<W>
  /** Captured before the event, for the effect check. */
  mark?(w: W): Promise<unknown>
  act(w: W): Promise<void>
  /** The event took effect on its own object; throws otherwise. */
  took(w: W, mark: unknown): Promise<void>
  facts(w: W, before: Reading): Promise<EventFacts> | EventFacts
  /** Who must be told, when the person the link names is the one who left; default the link's. */
  whoIsTold?: string[]
  /** Readers who must hold the item before the event (the positive control); default whoIsTold. */
  mustSee?: string[]
  /** A reading other than the default, for migrate's row written today. */
  asToday?(w: W, worlds: Worlds): Promise<Reading>
}

function cell<W extends CellWorld>(c: CellImpl<W>): CellImpl {
  return c
}

const build =
  (o: { assigned?: boolean; away?: boolean } = {}) =>
  async (worlds: Worlds) =>
    new ApprovalCase(worlds.approvals).build(o)

/** A world in an organisation of its own (provisioned beside the others, none truncated): the cell switches an app off. */
const ownOrg =
  (o: { assigned?: boolean; away?: boolean } = {}) =>
  async () =>
    new ApprovalCase(await approvalOrg((await minimal.secondOrg({ name: "Own Org" })).orgId)).build(
      o,
    )

const CAL_SEE = ["usual", "person", "profile"]

async function calendar(worlds: Worlds): Promise<CalendarCase> {
  return new CalendarCase(worlds.approvals).connect()
}

async function deactivated(w: ApprovalCase, who: "person" | "nextInLine" | "requester") {
  expect(await w.userStatus(who)).toBe("deactivated")
}

/** Leave and come back: both bumps of the person's credentials happened. */
async function leftAndBack(
  w: ApprovalCase,
  who: "person" | "nextInLine" | "requester",
  mark: unknown,
) {
  expect(await w.userStatus(who)).toBe("active")
  expect((await w.versions(who)).auth).toBe((mark as { auth: number }).auth + 2)
}

async function lostAndRegained(w: ApprovalCase, who: "person" | "nextInLine", mark: unknown) {
  expect(await w.holds(who, DECIDE_SCOPE)).toBe(true)
  expect((await w.versions(who)).permission).toBeGreaterThanOrEqual(
    (mark as { permission: number }).permission + 2,
  )
}

async function moveTask(w: ApprovalCase): Promise<void> {
  const other = await w.tool("projects:createProject", { name: projectName() })
  const projectId =
    (other.data as { projectId?: string; id?: string }).projectId ??
    (other.data as { id?: string }).id
  if (!projectId) throw new Error(`project not created: ${JSON.stringify(other)}`)
  const res = await w.tool("projects:move", { taskId: w.taskId, projectId })
  if (res.blocked || (res as { error?: unknown }).error)
    throw new Error(`move refused: ${JSON.stringify(res)}`)
}

async function moved(w: ApprovalCase): Promise<void> {
  expect(await w.taskProject()).not.toBe(w.projectId)
}

const MADE_LINKS: Record<string, MadeLink> = {
  "dashboard-owner": "dashboardOwner",
  "dashboard-author": "dashboardAuthor",
  "store-document-author": "documentAuthor",
  "app-draft-author": "draftAuthor",
}
const MADE_SEE = ["owner", "admin", "colleague"]

function made(link: MadeLink) {
  return async (worlds: Worlds) => new MadeCase(worlds.approvals, link).build()
}

/** Deactivation, the export, and for the owner a lost permission and the way back. */
function madeCells(): CellImpl[] {
  const out: CellImpl[] = []
  for (const [name, link] of Object.entries(MADE_LINKS)) {
    out.push(
      cell<MadeCase>({
        link: name,
        event: "Dx",
        says: "the person who made it deactivated",
        build: made(link),
        mustSee: MADE_SEE,
        act: (w) => w.deactivateOwner(),
        took: async (w) => expect(await w.ownerStatus()).toBe("deactivated"),
        facts: () => ({}),
      }),
      cell<MadeCase>({
        link: name,
        event: "Ex",
        says: "the person who made it exporting their own data",
        build: made(link),
        mustSee: MADE_SEE,
        act: (w) => w.exportOwner(),
        took: async (w) => expect(w.exportFileId).not.toBeNull(),
        facts: (w) => ({ exported: w.exported, linkRowId: w.rowId }),
      }),
    )
  }
  out.push(
    cell<MadeCase>({
      link: "dashboard-owner",
      event: "Pm",
      says: "its owner losing the scope to share dashboards",
      build: made("dashboardOwner"),
      mustSee: MADE_SEE,
      // Members hold it through their role and the owner also holds it directly: both go.
      act: async (w) => {
        await minimal.revokeScope(w.people.owner, SHARE_SCOPE)
        await minimal.revokeRole(w.people.owner, "member")
      },
      took: async (w) => expect(await w.ownerHolds(SHARE_SCOPE)).toBe(false),
      facts: () => ({}),
    }),
    cell<MadeCase>({
      link: "dashboard-owner",
      event: "Rv",
      says: "its owner deactivated and reactivated",
      build: made("dashboardOwner"),
      mustSee: MADE_SEE,
      mark: (w) => w.ownerAuthVersion(),
      act: async (w) => {
        await w.deactivateOwner()
        await w.reactivateOwner()
      },
      took: async (w, mark) => {
        expect(await w.ownerStatus()).toBe("active")
        // Leaving and coming back each bumped the owner's credentials.
        expect(await w.ownerAuthVersion()).toBe((mark as number) + 2)
      },
      facts: () => ({}),
    }),
  )
  return out
}

export const CELLS: CellImpl[] = [
  // ── approval-target ────────────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "approval-target",
    event: "Mg",
    says: "its ticket merged into another while a request on it is pending",
    build: async (worlds) => (await build()(worlds)).onTicket(),
    mustSee: ["requester", "usual"],
    act: (w) => w.mergeTicket(),
    took: async (w) => {
      expect(await w.mergedInto(w.ticketId)).toBe(w.survivorId)
      // Its line leaves the decider's Home.
      expect((await w.sightOf("usual", w.requestId)).placement).toBeNull()
    },
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "approval-target",
    event: "Rn",
    says: "its task renamed while the request is pending",
    build: build(),
    mustSee: ["requester", "person", "usual"],
    act: async (w) => {
      const res = await w.tool("projects:update", {
        taskId: w.taskId,
        title: `${w.taskTitle} renamed`,
      })
      if (res.blocked) throw new Error(`rename refused: ${JSON.stringify(res)}`)
    },
    took: async (w) => {
      const [row] =
        (await sql`SELECT title FROM app_projects.tasks WHERE id = ${w.taskId}::uuid`) as Array<{
          title: string
        }>
      expect(row?.title).toBe(`${w.taskTitle} renamed`)
    },
    facts: (_w, before) => ({ oldName: before.person?.label ?? undefined }),
  }),
  cell<ApprovalCase>({
    link: "approval-target",
    event: "Dl",
    says: "its task deleted from its page while the request is pending",
    build: build(),
    act: (w) => w.binTask(),
    took: async (w) => expect((await w.taskState()).archived).toBe(true),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "approval-target",
    event: "Rv",
    says: "its task deleted and taken back out of the bin",
    build: build(),
    mark: (w) => w.taskState(),
    act: async (w) => {
      await w.binTask()
      await w.unbinTask()
    },
    took: async (w, mark) => {
      const now = await w.taskState()
      expect(now.archived).toBe(false)
      expect(now.updatedAt).not.toBe((mark as { updatedAt: string }).updatedAt)
    },
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: await w.requestRows() }),
  }),

  cell<ApprovalCase>({
    link: "approval-target",
    event: "Ap",
    says: "its app switched off while the request is pending",
    build: ownOrg(),
    act: (w) => w.setApp("projects", false),
    took: async (w) => expect(await w.appStatus("projects")).not.toBe("enabled"),
    facts: () => ({}),
  }),

  // ── approval-requester ─────────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "approval-requester",
    event: "Dl",
    says: "the person who asked deleting their account",
    build: build(),
    mustSee: ["requester", "usual"],
    act: (w) => w.deleteAccount("requester"),
    took: async (w) => expect(await w.userStatus("requester")).not.toBe("active"),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "approval-requester",
    event: "Rv",
    says: "the person who asked deactivated and reactivated",
    build: build(),
    mark: (w) => w.versions("requester"),
    act: async (w) => {
      await w.deactivate("requester")
      await w.reactivate("requester")
    },
    took: (w, mark) => leftAndBack(w, "requester", mark),
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: await w.requestRows() }),
  }),

  // ── approval-route ─────────────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Dx",
    says: "the person it is for deactivated",
    build: build(),
    act: (w) => w.deactivate("person"),
    took: (w) => deactivated(w, "person"),
    facts: () => ({ goneId: "person" }),
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Dl",
    says: "the person it is for deleting their account",
    build: build(),
    act: (w) => w.deleteAccount("person"),
    took: async (w) => expect(await w.userStatus("person")).not.toBe("active"),
    facts: () => ({ goneId: "person" }),
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Pm",
    says: "the person it is for losing the scope to decide",
    build: build(),
    act: (w) => minimal.revokeScope(w.people.person, DECIDE_SCOPE),
    took: async (w) => expect(await w.holds("person", DECIDE_SCOPE)).toBe(false),
    facts: () => ({ goneId: "person" }),
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Mv",
    says: "its task moved to another project",
    build: build(),
    act: moveTask,
    took: moved,
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Mi",
    says: "a request from before routing, with no person on it",
    build: build(),
    act: async (w) => {
      await sql`UPDATE ${K()}.approval_requests SET route_person_id = NULL WHERE id = ${w.requestId}`
    },
    took: async (w) => expect((await w.requestRow()).route_person_id).toBeNull(),
    facts: () => ({}),
    asToday: async (w, worlds) => {
      // Today's row with the same meaning: the same request about a task nobody holds.
      const today = await new ApprovalCase(worlds.approvals).build({
        assigned: false,
        people: w.people,
        title: w.taskTitle,
      })
      return w.read(today.requestId)
    },
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Rv",
    says: "the person it is for deactivated and reactivated",
    build: build(),
    mark: (w) => w.versions("person"),
    act: async (w) => {
      await w.deactivate("person")
      await w.reactivate("person")
    },
    took: (w, mark) => leftAndBack(w, "person", mark),
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: await w.requestRows() }),
  }),
  cell<ApprovalCase>({
    link: "approval-route",
    event: "Aw",
    says: "the person it is for away with a next in line",
    build: build(),
    act: async (w) => {
      w.rangeId = await w.goAway("person", "nextInLine")
    },
    took: async (w) => expect(await w.runningRanges("person")).toBe(1),
    facts: () => ({
      person: "person",
      nextInLine: "nextInLine",
      mustNotGain: ["outsider", "requester"],
    }),
  }),

  // ── routine-owner ──────────────────────────────────────────────────────────
  cell<RoutineCase>({
    link: "routine-owner",
    event: "Pm",
    says: "its owner losing a scope it runs with, at its next tick",
    build: async (worlds) => new RoutineCase(worlds.routines).build(),
    mustSee: ["owner", "admin"],
    act: async (w) => {
      await w.revoke()
      await w.tick()
    },
    took: async (w) => expect(await w.ownerHolds()).toBe(false),
    facts: () => ({}),
  }),
  cell<RoutineCase>({
    link: "routine-owner",
    event: "Dx",
    says: "its owner deactivated, at its next tick",
    build: async (worlds) => new RoutineCase(worlds.routines).build(),
    mustSee: ["owner", "admin"],
    whoIsTold: ["admin"],
    act: async (w) => {
      await w.deactivateOwner()
      await w.tick()
    },
    took: async (w) => expect(await w.ownerStatus()).toBe("deactivated"),
    facts: () => ({}),
  }),
  cell<RoutineCase>({
    link: "routine-owner",
    event: "Rv",
    says: "its owner losing and regaining a scope it runs with, a tick after each",
    build: async (worlds) => new RoutineCase(worlds.routines).build(),
    mustSee: ["owner", "admin"],
    mark: (w) => w.status(),
    act: async (w) => {
      await w.revoke()
      w.pausedBetween = (await w.tick()) === "skipped_scope_mismatch"
      await w.regain()
      await w.tick()
    },
    took: async (w) => {
      expect(await w.ownerHolds()).toBe(true)
      expect(w.pausedBetween).toBe(true)
    },
    facts: () => ({}),
  }),

  // ── calendar-event-away-range ──────────────────────────────────────────────
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Rn",
    says: "its out-of-office event renamed, at the next sync",
    build: calendar,
    mustSee: CAL_SEE,
    act: async (w) => {
      w.title = "Off sick"
      await w.sync()
    },
    took: async (w) => expect(w.title).toBe("Off sick"),
    facts: () => ({}),
  }),
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Dl",
    says: "its out-of-office event cancelled, at the next sync",
    build: calendar,
    mustSee: CAL_SEE,
    act: async (w) => {
      w.cancelled = true
      await w.sync()
    },
    took: async (w) => expect(w.item().status).toBe("cancelled"),
    facts: () => ({}),
  }),
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Mv",
    says: "its out-of-office event moved to next week, at the next sync",
    build: calendar,
    mustSee: CAL_SEE,
    act: async (w) => {
      w.from = 7
      await w.sync()
    },
    took: async (w) => expect(w.from).toBe(7),
    facts: () => ({}),
  }),
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Ap",
    says: "the calendar disconnected",
    build: calendar,
    mustSee: CAL_SEE,
    act: (w) => w.disconnect(),
    took: async (w) => expect(await w.accountDisconnected()).toBe(true),
    facts: () => ({}),
  }),
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Dx",
    says: "the person away deactivated",
    build: calendar,
    mustSee: CAL_SEE,
    act: (w) => w.deactivate("person"),
    took: (w) => deactivated(w, "person"),
    facts: () => ({ goneId: "person" }),
  }),
  cell<CalendarCase>({
    link: "calendar-event-away-range",
    event: "Rv",
    says: "the person away deactivated and reactivated, then the next sync",
    build: calendar,
    mustSee: CAL_SEE,
    mark: (w) => w.versions("person"),
    act: async (w) => {
      await w.deactivate("person")
      await w.reactivate("person")
      await w.sync()
    },
    took: (w, mark) => leftAndBack(w, "person", mark),
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: (await w.calendarRanges()).length }),
  }),

  // ── away-range-person ──────────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "away-range-person",
    event: "Dl",
    says: "the range ended early by its person",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.endAway("person", w.rangeId as string),
    took: async (w) => expect(await w.runningRanges("person")).toBe(0),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "away-range-person",
    event: "Dx",
    says: "the person away deactivated",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.deactivate("person"),
    took: async (w) => {
      await deactivated(w, "person")
      const [row] =
        (await sql`SELECT count(*)::int AS n FROM ${K()}.away_ranges WHERE user_id = ${w.people.person}`) as Array<{
          n: number
        }>
      expect(row?.n).toBe(0)
    },
    facts: () => ({ goneId: "person" }),
  }),

  // ── away-range-next-in-line ────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "away-range-next-in-line",
    event: "Dx",
    says: "the next in line deactivated during the range",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.deactivate("nextInLine"),
    took: (w) => deactivated(w, "nextInLine"),
    facts: () => ({ goneId: "nextInLine" }),
  }),
  cell<ApprovalCase>({
    link: "away-range-next-in-line",
    event: "Pm",
    says: "the next in line losing the scope to decide",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => minimal.revokeScope(w.people.nextInLine, DECIDE_SCOPE),
    took: async (w) => expect(await w.holds("nextInLine", DECIDE_SCOPE)).toBe(false),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "away-range-next-in-line",
    event: "Rv",
    says: "the next in line deactivated and reactivated during the range",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    mark: (w) => w.versions("nextInLine"),
    act: async (w) => {
      await w.deactivate("nextInLine")
      await w.reactivate("nextInLine")
    },
    took: (w, mark) => leftAndBack(w, "nextInLine", mark),
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: await w.requestRows() }),
  }),
  cell<ApprovalCase>({
    link: "away-range-next-in-line",
    event: "Aw",
    says: "the next in line away too, with their own next in line",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: async (w) => {
      await w.goAway("nextInLine", "chain")
    },
    took: async (w) => expect(await w.runningRanges("nextInLine")).toBe(1),
    facts: () => ({
      person: "person",
      nextInLine: "chain",
      mustNotGain: ["outsider", "requester"],
    }),
  }),

  // ── stand-in-row-item ──────────────────────────────────────────────────────
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Dl",
    says: "the item decided by another decider",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.decide("usual", "deny"),
    took: async (w) => expect((await w.requestRow()).status).toBe("denied"),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Dx",
    says: "the stand-in deactivated",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.deactivate("nextInLine"),
    took: (w) => deactivated(w, "nextInLine"),
    facts: () => ({ goneId: "nextInLine" }),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Ap",
    says: "its app switched off while the stand-in holds it",
    build: ownOrg({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => w.setApp("projects", false),
    took: async (w) => {
      expect(await w.appStatus("projects")).not.toBe("enabled")
      // The row leaves the stand-in's Home with the request it stood for.
      expect((await w.sightOf("nextInLine", w.requestId)).placement).toBeNull()
    },
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Pm",
    says: "the stand-in losing the scope to decide",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: (w) => minimal.revokeScope(w.people.nextInLine, DECIDE_SCOPE),
    took: async (w) => expect(await w.holds("nextInLine", DECIDE_SCOPE)).toBe(false),
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Mv",
    says: "its task moved to another project",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: moveTask,
    took: moved,
    facts: () => ({}),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Rv",
    says: "the stand-in losing and regaining the scope to decide",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    mark: (w) => w.versions("nextInLine"),
    act: async (w) => {
      await minimal.revokeScope(w.people.nextInLine, DECIDE_SCOPE)
      await minimal.grantScope(w.people.nextInLine, DECIDE_SCOPE)
    },
    took: (w, mark) => lostAndRegained(w, "nextInLine", mark),
    facts: async (w) => ({ rowsBefore: 1, rowsAfter: await w.requestRows() }),
  }),
  cell<ApprovalCase>({
    link: "stand-in-row-item",
    event: "Aw",
    says: "the stand-in away too, with their own next in line",
    build: build({ away: true }),
    mustSee: ["usual", "person", "nextInLine"],
    act: async (w) => {
      await w.goAway("nextInLine", "chain")
    },
    took: async (w) => expect(await w.runningRanges("nextInLine")).toBe(1),
    facts: () => ({
      person: "person",
      nextInLine: "chain",
      mustNotGain: ["outsider", "requester"],
    }),
  }),

  // ── thread-created-from ────────────────────────────────────────────────────
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Rn",
    says: "its task renamed",
    build: async (worlds) => new ThreadCase(worlds.threads).buildOnTask(),
    act: (w) => w.renameTask(),
    took: async (w) => expect(await w.taskTitleNow()).toBe(w.newTitle),
    facts: (w) => ({ newName: w.newTitle }),
  }),
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Mv",
    says: "its task moved to another project",
    build: async (worlds) => new ThreadCase(worlds.threads).buildOnTask(),
    mark: (w) => w.taskRow(),
    act: (w) => w.moveTask(),
    took: async (w, mark) =>
      expect((await w.taskRow()).projectId).not.toBe((mark as { projectId: string }).projectId),
    facts: () => ({}),
  }),
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Rv",
    says: "its task deleted and taken back out of the bin",
    build: async (worlds) => new ThreadCase(worlds.threads).buildOnTask(),
    mark: (w) => w.taskRow(),
    act: (w) => w.binAndRestoreTask(),
    took: async (w, mark) => {
      const now = await w.taskRow()
      expect(now.archived).toBe(false)
      expect(now.updatedAt).not.toBe((mark as { updatedAt: string }).updatedAt)
    },
    facts: () => ({}),
  }),
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Ap",
    says: "its task's app switched off",
    build: async () =>
      new ThreadCase(
        await approvalOrg((await minimal.secondOrg({ name: "Own Org" })).orgId),
      ).buildOnTask(),
    act: (w) => w.switchProjectsOff(),
    took: async (w) => expect(await w.projectsStatus()).not.toBe("enabled"),
    facts: () => ({}),
  }),
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Pm",
    says: "a member losing read access to its task",
    build: async (worlds) => new ThreadCase(worlds.threads).buildOnTask(),
    mustSee: ["owner", "member"],
    act: (w) => w.revokeMemberRead(),
    took: async (w) => expect(await w.memberCanReadTasks()).toBe(false),
    facts: () => ({ lostAccess: "member", neverHad: "outsider" }),
  }),
  cell<ThreadCase>({
    link: "thread-created-from",
    event: "Mg",
    says: "its ticket merged into another",
    build: async (worlds) => new ThreadCase(worlds.threads).buildOnTicket(),
    act: (w) => w.mergeTicket(),
    took: async (w) => expect(await w.mergedInto(w.ticketId)).toBe(w.survivorId),
    facts: (w) => ({ survivor: w.roleOf(w.survivorId) ?? "", goneId: w.roleOf(w.ticketId) ?? "" }),
  }),

  // ── what a person makes: dashboard-owner, dashboard-author, store-document-author ──
  ...madeCells(),
  ...companyCells(),
  ...moneyCells(),
]
