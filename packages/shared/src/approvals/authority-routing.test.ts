// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ApprovalAuthorityFacts,
  type ApprovalRoute,
  type AuthorityViewer,
  type AwayRangeDays,
  awayRunEnd,
  canDecidePure,
  homePlacement,
  isAwayOn,
  isPeerSelfApprovable,
  personLocalDate,
  type RoutingFacts,
  type RoutingWorld,
  routeApproval,
} from "./authority"

const facts = (over: Partial<ApprovalAuthorityFacts> = {}): ApprovalAuthorityFacts => ({
  toolName: "mail:send",
  approveScope: null,
  resourceOwnerId: null,
  requestedById: "agent-owner",
  notifyUserIds: ["agent-owner", "elodie", "elise", "sara", "tom", "ines"],
  ...over,
})

const routing = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  routePersonId: null,
  managerId: null,
  minApprovers: 1,
  stalled: false,
  peer: { requestedById: "agent-owner", originRoutineId: null, requesterCanDecide: false },
  ...over,
})

interface PersonFixture {
  decides?: boolean
  inactive?: boolean
  away?: { until?: string; next?: string | null }
}

const world = (people: Record<string, PersonFixture>): RoutingWorld => {
  let reads = 0
  return {
    canDecide: (id) => people[id]?.decides === true && people[id]?.inactive !== true,
    isActive: (id) => id in people && people[id]?.inactive !== true,
    away: (id) => {
      // A walk that loses its seen set fails here instead of hanging the run.
      if (++reads > 200) throw new Error("the walk did not terminate")
      const away = people[id]?.away
      return away ? { until: away.until ?? "2026-12-20", nextInLineId: away.next ?? null } : null
    },
  }
}

/** A world any read of which fails the test: proves a path decides without consulting it. */
const untouchableWorld: RoutingWorld = {
  canDecide: () => {
    throw new Error("canDecide consulted")
  },
  isActive: () => {
    throw new Error("isActive consulted")
  },
  away: () => {
    throw new Error("away consulted")
  },
}

const viewer = (userId: string, scopes: string[] = ["mail:approve"]): AuthorityViewer => ({
  userId,
  hasScope: (scope) => scopes.includes("*") || scopes.includes(scope),
})

type PersonRoute = Extract<ApprovalRoute, { to: "person" }>

const person = (
  userId: string,
  why: PersonRoute["why"],
  over: Partial<PersonRoute> = {},
): PersonRoute => ({
  to: "person",
  userId,
  why,
  awayUntil: null,
  standIn: null,
  blockedStandIn: null,
  ...over,
})

describe("routeApproval: the order", () => {
  it("owner never consults away", () => {
    const route = routeApproval(
      facts({ resourceOwnerId: "elodie" }),
      routing({ routePersonId: "tom", managerId: "sara" }),
      untouchableWorld,
    )
    expect(route).toEqual({ to: "owner", userId: "elodie" })
  })

  it("stalled is usual", () => {
    const route = routeApproval(
      facts(),
      routing({ stalled: true, routePersonId: "tom", managerId: "sara" }),
      untouchableWorld,
    )
    expect(route).toEqual({ to: "usual" })
  })

  it("minApprovers 2 is usual", () => {
    for (const minApprovers of [2, 3]) {
      const route = routeApproval(
        facts(),
        routing({ minApprovers, routePersonId: "tom", managerId: "sara" }),
        untouchableWorld,
      )
      expect(route).toEqual({ to: "usual" })
    }
  })

  it("an owner-routed row stays with its owner when it is also stalled or two-approver", () => {
    const route = routeApproval(
      facts({ resourceOwnerId: "elodie" }),
      routing({ stalled: true, minApprovers: 2 }),
      untouchableWorld,
    )
    expect(route).toEqual({ to: "owner", userId: "elodie" })
  })

  it("a requester who could approve their own comes first, as asked", () => {
    const route = routeApproval(
      facts({ requestedById: "tom" }),
      routing({
        routePersonId: "ines",
        managerId: "elodie",
        peer: { requestedById: "tom", originRoutineId: null, requesterCanDecide: true },
      }),
      world({ tom: { decides: true }, ines: { decides: true }, elodie: { decides: true } }),
    )
    expect(route).toEqual(person("tom", "asked"))
  })

  it("a routine's request is never asked, so the person on the item comes first", () => {
    const route = routeApproval(
      facts({ requestedById: "tom" }),
      routing({
        routePersonId: "ines",
        peer: { requestedById: "tom", originRoutineId: "routine-1", requesterCanDecide: true },
      }),
      world({ tom: { decides: true }, ines: { decides: true } }),
    )
    expect(route).toEqual(person("ines", "on_item"))
  })

  it("a requester who cannot decide their own is not asked", () => {
    const route = routeApproval(
      facts({ requestedById: "tom" }),
      routing({
        routePersonId: "ines",
        peer: { requestedById: "tom", originRoutineId: null, requesterCanDecide: false },
      }),
      world({ tom: {}, ines: { decides: true } }),
    )
    expect(route).toEqual(person("ines", "on_item"))
  })

  it("a requester the world says cannot decide today is not asked", () => {
    const route = routeApproval(
      facts({ requestedById: "tom" }),
      routing({
        managerId: "elodie",
        peer: { requestedById: "tom", originRoutineId: null, requesterCanDecide: true },
      }),
      world({ tom: {}, elodie: { decides: true } }),
    )
    expect(route).toEqual(person("elodie", "manager"))
  })

  it("the person on the item comes before the manager", () => {
    const route = routeApproval(
      facts(),
      routing({ routePersonId: "ines", managerId: "elodie" }),
      world({ ines: { decides: true }, elodie: { decides: true } }),
    )
    expect(route).toEqual(person("ines", "on_item"))
  })

  it("a person on the item who cannot decide gives way to the manager", () => {
    const route = routeApproval(
      facts(),
      routing({ routePersonId: "ines", managerId: "elodie" }),
      world({ ines: {}, elodie: { decides: true } }),
    )
    expect(route).toEqual(person("elodie", "manager"))
  })

  it("no candidate who can decide is usual", () => {
    const route = routeApproval(
      facts(),
      routing({ routePersonId: "ines", managerId: "elodie" }),
      world({ ines: {}, elodie: { inactive: true, decides: true } }),
    )
    expect(route).toEqual({ to: "usual" })
  })

  it("no candidate at all is usual, as a company with no manager is today", () => {
    expect(routeApproval(facts(), routing(), world({}))).toEqual({ to: "usual" })
  })

  it("a manager who is the requester and cannot decide their own is usual", () => {
    const route = routeApproval(
      facts({ requestedById: "elodie" }),
      routing({
        managerId: "elodie",
        peer: { requestedById: "elodie", originRoutineId: null, requesterCanDecide: false },
      }),
      world({ elodie: { decides: true } }),
    )
    expect(route).toEqual({ to: "usual" })
  })

  it("a candidate who is not away has no stand-in, and no next in line is consulted", () => {
    const route = routeApproval(
      facts(),
      routing({ managerId: "elodie" }),
      world({ elodie: { decides: true } }),
    )
    expect(route).toEqual(person("elodie", "manager"))
  })

  it("a candidate who is away keeps the row and names the next in line who can decide", () => {
    const route = routeApproval(
      facts(),
      routing({ managerId: "elodie" }),
      world({
        elodie: { decides: true, away: { until: "2026-12-20", next: "tom" } },
        tom: { decides: true },
      }),
    )
    expect(route).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20", standIn: "tom" }))
  })

  it("a candidate who is away with nobody next in line has no stand-in", () => {
    const route = routeApproval(
      facts(),
      routing({ managerId: "elodie" }),
      world({ elodie: { decides: true, away: { until: "2026-12-20", next: null } } }),
    )
    expect(route).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })
})

describe("routeApproval: the next-in-line walk", () => {
  const route = (people: Record<string, PersonFixture>) =>
    routeApproval(facts(), routing({ managerId: "elodie" }), world(people))

  it("Élodie to Tom to Sara: Sara", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "tom" } },
        tom: { decides: true, away: { next: "sara" } },
        sara: { decides: true },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20", standIn: "sara" }))
  })

  it("cycle terminates, no stand-in", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "tom" } },
        tom: { decides: true, away: { next: "elodie" } },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })

  it("someone naming themselves next in line terminates, no stand-in", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "tom" } },
        tom: { decides: true, away: { next: "tom" } },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })

  it("deactivated next in line: both null", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "lea" } },
        lea: { inactive: true },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })

  it("a deactivated next in line ends the walk even when someone further could decide", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "lea" } },
        lea: { inactive: true, away: { next: "sara" } },
        sara: { decides: true },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })

  it("active who cannot decide: blockedStandIn, ends the chain", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "tom" } },
        tom: {},
        sara: { decides: true },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20", blockedStandIn: "tom" }))
  })

  it("someone away who cannot decide is passed over, not blocking", () => {
    expect(
      route({
        elodie: { decides: true, away: { next: "tom" } },
        tom: { away: { next: "sara" } },
        sara: { decides: true },
      }),
    ).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20", standIn: "sara" }))
  })

  it("chain of 20 terminates", () => {
    const line: Record<string, PersonFixture> = { elodie: { decides: true, away: { next: "p0" } } }
    for (let i = 0; i < 20; i++) line[`p${i}`] = { away: { next: `p${i + 1}` } }
    line.p20 = { decides: true }
    expect(route(line)).toEqual(
      person("elodie", "manager", { awayUntil: "2026-12-20", standIn: "p20" }),
    )

    const ring: Record<string, PersonFixture> = { elodie: { decides: true, away: { next: "p0" } } }
    for (let i = 0; i < 20; i++) ring[`p${i}`] = { away: { next: `p${(i + 1) % 20}` } }
    expect(route(ring)).toEqual(person("elodie", "manager", { awayUntil: "2026-12-20" }))
  })
})

describe("homePlacement", () => {
  const away = person("elodie", "manager", { awayUntil: "2026-12-20" })

  it("not visible in the feed is hidden, whatever the route says", () => {
    const f = facts({ notifyUserIds: ["agent-owner", "elodie"] })
    expect(homePlacement(f, { to: "usual" }, viewer("sara"))).toBe("hidden")
    expect(homePlacement(f, person("sara", "on_item"), viewer("sara"))).toBe("hidden")
    expect(homePlacement(f, { ...away, standIn: "sara" }, viewer("sara"))).toBe("hidden")
    expect(homePlacement(facts(), { ...away, standIn: "tom" }, viewer("tom", []))).toBe("hidden")
  })

  it("an owner route is mine for the owner and hidden from an admin holding everything", () => {
    const f = facts({ resourceOwnerId: "elodie" })
    const route: ApprovalRoute = { to: "owner", userId: "elodie" }
    expect(homePlacement(f, route, viewer("elodie", []))).toBe("mine")
    expect(homePlacement(f, route, viewer("sara", ["*"]))).toBe("hidden")
  })

  it("a usual route is mine for everyone who can see it", () => {
    expect(homePlacement(facts(), { to: "usual" }, viewer("elise"))).toBe("mine")
    expect(homePlacement(facts(), { to: "usual" }, viewer("sara"))).toBe("mine")
  })

  it("the person it is for: mine, also while away", () => {
    expect(homePlacement(facts(), person("elodie", "manager"), viewer("elodie"))).toBe("mine")
    expect(homePlacement(facts(), { ...away, standIn: "tom" }, viewer("elodie"))).toBe("mine")
  })

  it("the stand-in is standing_in, and everyone else stays others", () => {
    const route = { ...away, standIn: "tom" }
    expect(homePlacement(facts(), route, viewer("tom"))).toBe("standing_in")
    expect(homePlacement(facts(), route, viewer("elise"))).toBe("others")
  })

  it("away with no stand-in: mine for the usual deciders", () => {
    expect(homePlacement(facts(), away, viewer("elise"))).toBe("mine")
    expect(homePlacement(facts(), { ...away, blockedStandIn: "tom" }, viewer("elise"))).toBe("mine")
  })

  it("not away: others for everyone but the person it is for", () => {
    expect(homePlacement(facts(), person("elodie", "manager"), viewer("elise"))).toBe("others")
  })

  it("next in line grants nothing: a blocked stand-in without the scope is hidden", () => {
    const route = { ...away, blockedStandIn: "tom" }
    expect(homePlacement(facts(), route, viewer("tom", []))).toBe("hidden")
    expect(canDecidePure(facts(), viewer("tom", []), { sharedSurface: false })).toBe(false)
  })
})

describe("a row about a company with a manager", () => {
  it("mine with why manager; others; all can decide", () => {
    const f = facts({ notifyUserIds: ["agent-owner", "elodie", "elise", "sara"] })
    const route = routeApproval(
      f,
      routing({
        managerId: "elodie",
        peer: {
          requestedById: "agent-owner",
          originRoutineId: "routine-1",
          requesterCanDecide: false,
        },
      }),
      world({ elodie: { decides: true }, elise: { decides: true }, sara: { decides: true } }),
    )
    expect(route).toEqual(person("elodie", "manager"))
    expect(homePlacement(f, route, viewer("elodie"))).toBe("mine")
    expect(homePlacement(f, route, viewer("elise"))).toBe("others")
    expect(homePlacement(f, route, viewer("sara"))).toBe("others")
    for (const id of ["elodie", "elise", "sara"]) {
      expect(canDecidePure(f, viewer(id), { sharedSurface: false })).toBe(true)
    }
  })
})

describe("a row needing two approvers", () => {
  it("minApprovers 2 mine for every decider, never others", () => {
    const f = facts()
    const route = routeApproval(
      f,
      routing({ minApprovers: 2, managerId: "elodie" }),
      world({ elodie: { decides: true, away: { next: "tom" } }, tom: { decides: true } }),
    )
    for (const id of ["elodie", "elise", "sara", "tom"]) {
      expect(homePlacement(f, route, viewer(id))).toBe("mine")
    }
  })
})

describe("the requester who could self-approve, on a colleague's Home", () => {
  it("is the same answer the feed's noise filter gives for someone else", () => {
    const peer = { requestedById: "tom", originRoutineId: null, requesterCanDecide: true }
    const f = facts({ requestedById: "tom" })
    expect(isPeerSelfApprovable(peer, "elodie")).toBe(true)
    expect(isPeerSelfApprovable(peer, "tom")).toBe(false)
    const route = routeApproval(f, routing({ peer }), world({ tom: { decides: true } }))
    expect(route).toEqual(person("tom", "asked"))
    expect(homePlacement(f, route, viewer("tom"))).toBe("mine")
    expect(homePlacement(f, route, viewer("elodie"))).toBe("others")
  })
})

describe("the module's purity", () => {
  it("imports nothing, so the web calls the same answerer", () => {
    const source = readFileSync(join(import.meta.dir, "authority.ts"), "utf8")
    expect(source).not.toMatch(/^\s*import\s/m)
    expect(source).not.toMatch(/\brequire\(/)
  })
})

// Sunday 8 November 2026 and the working week after it.
const WEEK: AwayRangeDays = {
  startsOn: "2026-11-09",
  endsOn: "2026-11-13",
  weekdays: null,
  status: "active",
  endedEarlyOn: null,
}

describe("away dates are the person's", () => {
  const awayAt = (iso: string, zone: string, range: AwayRangeDays = WEEK) =>
    isAwayOn(range, personLocalDate(new Date(iso), zone, null))

  it("20:00 UTC Sunday: Tokyo away for a Monday start, Paris not", () => {
    expect(personLocalDate(new Date("2026-11-08T20:00:00Z"), "Asia/Tokyo", null)).toBe("2026-11-09")
    expect(personLocalDate(new Date("2026-11-08T20:00:00Z"), "Europe/Paris", null)).toBe(
      "2026-11-08",
    )
    expect(awayAt("2026-11-08T20:00:00Z", "Asia/Tokyo")).toBe(true)
    expect(awayAt("2026-11-08T20:00:00Z", "Europe/Paris")).toBe(false)
  })

  it("23:30 UTC Sunday: Tokyo and Paris have reached Monday, New York has not", () => {
    expect(awayAt("2026-11-08T23:30:00Z", "Asia/Tokyo")).toBe(true)
    expect(awayAt("2026-11-08T23:30:00Z", "Europe/Paris")).toBe(true)
    expect(awayAt("2026-11-08T23:30:00Z", "America/New_York")).toBe(false)
  })

  it("the day before the start, the first day, the last day and the day after the end, in both zones", () => {
    const cases = [
      ["Asia/Tokyo", "2026-11-08T12:00:00Z", "2026-11-08", false],
      ["Asia/Tokyo", "2026-11-08T16:00:00Z", "2026-11-09", true],
      ["Asia/Tokyo", "2026-11-13T14:00:00Z", "2026-11-13", true],
      ["Asia/Tokyo", "2026-11-13T16:00:00Z", "2026-11-14", false],
      ["Europe/Paris", "2026-11-08T22:30:00Z", "2026-11-08", false],
      ["Europe/Paris", "2026-11-08T23:30:00Z", "2026-11-09", true],
      ["Europe/Paris", "2026-11-13T22:30:00Z", "2026-11-13", true],
      ["Europe/Paris", "2026-11-13T23:30:00Z", "2026-11-14", false],
    ] as const
    for (const [zone, instant, localDate, away] of cases) {
      expect(personLocalDate(new Date(instant), zone, null)).toBe(localDate)
      expect(awayAt(instant, zone)).toBe(away)
    }
  })

  it("no zone falls to org then UTC", () => {
    const at = new Date("2026-11-08T20:00:00Z")
    expect(personLocalDate(at, "Europe/Paris", "Asia/Tokyo")).toBe("2026-11-08")
    expect(personLocalDate(at, null, "Asia/Tokyo")).toBe("2026-11-09")
    expect(personLocalDate(at, null, null)).toBe("2026-11-08")
    expect(personLocalDate(new Date("2026-11-08T23:30:00Z"), null, null)).toBe("2026-11-08")
  })

  it("an unreadable zone falls to the next one instead of throwing", () => {
    const at = new Date("2026-11-08T20:00:00Z")
    expect(personLocalDate(at, "Mars/Olympus", "Asia/Tokyo")).toBe("2026-11-09")
    expect(personLocalDate(at, "Mars/Olympus", "Mars/Olympus")).toBe("2026-11-08")
  })
})

describe("isAwayOn", () => {
  it("away on the listed weekdays only, with no end", () => {
    const fridays: AwayRangeDays = { ...WEEK, endsOn: null, weekdays: [5] }
    expect(isAwayOn(fridays, "2026-11-12")).toBe(false)
    expect(isAwayOn(fridays, "2026-11-13")).toBe(true)
    expect(isAwayOn(fridays, "2026-11-16")).toBe(false)
    expect(isAwayOn(fridays, "2027-03-05")).toBe(true)
  })

  it("weekdays are ISO, Sunday being 7", () => {
    const sundays: AwayRangeDays = { ...WEEK, startsOn: "2026-11-01", endsOn: null, weekdays: [7] }
    expect(isAwayOn(sundays, "2026-11-08")).toBe(true)
    expect(isAwayOn(sundays, "2026-11-09")).toBe(false)
  })

  it("weekdays stay inside the range's dates", () => {
    const fridays: AwayRangeDays = { ...WEEK, weekdays: [5] }
    expect(isAwayOn(fridays, "2026-11-06")).toBe(false)
    expect(isAwayOn(fridays, "2026-11-13")).toBe(true)
    expect(isAwayOn(fridays, "2026-11-20")).toBe(false)
  })

  it("a range asked about or declined counts for nothing", () => {
    expect(isAwayOn({ ...WEEK, status: "asked" }, "2026-11-10")).toBe(false)
    expect(isAwayOn({ ...WEEK, status: "declined" }, "2026-11-10")).toBe(false)
  })

  it("ending early brings the person back that same day", () => {
    const ended: AwayRangeDays = { ...WEEK, endedEarlyOn: "2026-11-11" }
    expect(isAwayOn(ended, "2026-11-10")).toBe(true)
    expect(isAwayOn(ended, "2026-11-11")).toBe(false)
    expect(isAwayOn(ended, "2026-11-12")).toBe(false)
  })
})

/** A small seeded generator, so a failure names a seed that reproduces it. */
function seeded(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    chance: (p: number) => next() < p,
    int: (n: number) => Math.floor(next() * n),
  }
}

const TODAY = "2026-11-11"

interface GraphPerson {
  id: string
  active: boolean
  holdsScope: boolean
  notified: boolean
  /** Holds everything, like a `*` admin. */
  admin: boolean
  nextInLineId: string | null
  ranges: AwayRangeDays[]
}

const holdsDecidingScope = (p: GraphPerson) => p.active && (p.holdsScope || p.admin)

function randomGraph(seed: number) {
  const rng = seeded(seed)
  const size = 2 + rng.int(11)
  const ids = Array.from({ length: size }, (_, i) => `person-${i}`)
  const anyone = () => ids[rng.int(size)] as string
  const dates = ["2026-11-09", "2026-11-11", "2026-11-13"]
  const people = new Map<string, GraphPerson>()
  for (const id of ids) {
    const ranges: AwayRangeDays[] = []
    if (rng.chance(0.5)) {
      ranges.push({
        startsOn: rng.chance(0.8) ? "2026-11-09" : "2026-11-12",
        endsOn: dates[rng.int(3)] as string,
        weekdays: rng.chance(0.2) ? [3] : null,
        status: rng.chance(0.85) ? "active" : "asked",
        endedEarlyOn: rng.chance(0.1) ? TODAY : null,
      })
    }
    people.set(id, {
      id,
      active: rng.chance(0.85),
      holdsScope: rng.chance(0.65),
      notified: rng.chance(0.8),
      admin: rng.chance(0.1),
      nextInLineId: rng.chance(0.8) ? anyone() : null,
      ranges,
    })
  }
  const requester = anyone()
  const notifyUserIds = [...people.values()].filter((p) => p.notified).map((p) => p.id)
  const f: ApprovalAuthorityFacts = {
    toolName: "mail:send",
    approveScope: null,
    resourceOwnerId: rng.chance(0.1) ? anyone() : null,
    requestedById: requester,
    notifyUserIds,
  }
  const originRoutineId = rng.chance(0.3) ? "routine-1" : null
  const requesterPerson = people.get(requester) as GraphPerson
  const r: RoutingFacts = {
    routePersonId: rng.chance(0.5) ? anyone() : null,
    managerId: rng.chance(0.5) ? anyone() : null,
    minApprovers: rng.chance(0.1) ? 2 : 1,
    stalled: rng.chance(0.05),
    peer: {
      requestedById: requester,
      originRoutineId,
      requesterCanDecide: holdsDecidingScope(requesterPerson),
    },
  }
  return { rng, ids, people, f, r, anyone }
}

type Graph = ReturnType<typeof randomGraph>

function graphWorld(people: Graph["people"]): RoutingWorld & { reads: () => number } {
  let reads = 0
  return {
    reads: () => reads,
    canDecide: (id) => {
      const p = people.get(id)
      return p ? p.notified && holdsDecidingScope(p) : false
    },
    isActive: (id) => people.get(id)?.active === true,
    away: (id) => {
      reads++
      // A walk that loses its seen set fails here instead of hanging the run.
      if (reads > 200) throw new Error("the walk did not terminate")
      const p = people.get(id)
      if (!p?.ranges.some((range) => isAwayOn(range, TODAY))) return null
      return { until: "2026-11-13", nextInLineId: p.nextInLineId }
    },
  }
}

const graphViewer = (p: GraphPerson): AuthorityViewer => ({
  userId: p.id,
  hasScope: (scope) => holdsDecidingScope(p) && scope === "mail:approve",
})

function placementsOf(g: Graph, people: Graph["people"], route: ApprovalRoute) {
  return new Map(
    [...people.values()].map((p) => [p.id, homePlacement(g.f, route, graphViewer(p))] as const),
  )
}

const RUNS = 3000

describe("placement over random org graphs", () => {
  it("terminates", () => {
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const w = graphWorld(g.people)
      routeApproval(g.f, g.r, w)
      expect(w.reads()).toBeLessThanOrEqual(g.ids.length)
    }
  })

  it("each row placed once per person", () => {
    const allowed = new Set(["mine", "standing_in", "others", "hidden"])
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const route = routeApproval(g.f, g.r, graphWorld(g.people))
      const first = placementsOf(g, g.people, route)
      const second = placementsOf(g, g.people, route)
      expect(second).toEqual(first)
      for (const placement of first.values()) expect(allowed.has(placement)).toBe(true)
      const standing = [...first].filter(([, placement]) => placement === "standing_in")
      expect(standing.length).toBeLessThanOrEqual(1)
      if (route.to === "person") {
        for (const [id] of standing) expect(id).toBe(route.standIn as string)
        expect(first.get(route.userId)).not.toBe("standing_in")
      } else {
        expect(standing).toEqual([])
      }
    }
  })

  it("nobody who cannot decide is offered it", () => {
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const w = graphWorld(g.people)
      const route = routeApproval(g.f, g.r, w)
      if (route.to === "person") {
        expect(w.canDecide(route.userId)).toBe(true)
        if (route.standIn) {
          expect(w.canDecide(route.standIn)).toBe(true)
          expect(w.away(route.standIn)).toBeNull()
          expect(route.blockedStandIn).toBeNull()
        }
        if (route.blockedStandIn) {
          expect(w.canDecide(route.blockedStandIn)).toBe(false)
          expect(w.isActive(route.blockedStandIn)).toBe(true)
          expect(w.away(route.blockedStandIn)).toBeNull()
        }
      }
      if (route.to === "owner") continue
      for (const [id, placement] of placementsOf(g, g.people, route)) {
        expect(placement !== "hidden").toBe(w.canDecide(id))
      }
    }
  })

  it("private never passes", () => {
    let privateRows = 0
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      if (!g.f.resourceOwnerId) continue
      privateRows++
      const route = routeApproval(g.f, g.r, untouchableWorld)
      expect(route).toEqual({ to: "owner", userId: g.f.resourceOwnerId })
      for (const [id, placement] of placementsOf(g, g.people, route)) {
        expect(placement).toBe(id === g.f.resourceOwnerId ? "mine" : "hidden")
      }
    }
    expect(privateRows).toBeGreaterThan(100)
  })

  it("a row someone could decide is never left without a decider", () => {
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const placements = placementsOf(g, g.people, routeApproval(g.f, g.r, graphWorld(g.people)))
      const values = [...placements.values()]
      if (values.some((placement) => placement !== "hidden")) {
        expect(
          values.some((placement) => placement === "mine" || placement === "standing_in"),
        ).toBe(true)
      }
    }
  })

  it("adding a range never removes a person's ability to act", () => {
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const before = placementsOf(g, g.people, routeApproval(g.f, g.r, graphWorld(g.people)))
      const goesAway = g.anyone()
      const after = new Map(g.people)
      const target = g.people.get(goesAway) as GraphPerson
      after.set(goesAway, {
        ...target,
        ranges: [...target.ranges, { ...WEEK, startsOn: TODAY, endsOn: TODAY }],
      })
      const placed = placementsOf(g, after, routeApproval(g.f, g.r, graphWorld(after)))
      for (const id of g.ids) {
        const p = after.get(id) as GraphPerson
        expect(placed.get(id) === "hidden").toBe(before.get(id) === "hidden")
        expect(canDecidePure(g.f, graphViewer(p), { sharedSurface: false })).toBe(
          canDecidePure(g.f, graphViewer(g.people.get(id) as GraphPerson), {
            sharedSurface: false,
          }),
        )
      }
    }
  })

  it("the graphs reach every route and placement", () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < RUNS; seed++) {
      const g = randomGraph(seed)
      const route = routeApproval(g.f, g.r, graphWorld(g.people))
      seen.add(route.to)
      if (route.to === "person") {
        seen.add(route.why)
        if (route.standIn) seen.add("standIn")
        if (route.blockedStandIn) seen.add("blockedStandIn")
        if (route.awayUntil && !route.standIn && !route.blockedStandIn) seen.add("nobody")
      }
      for (const placement of placementsOf(g, g.people, route).values()) seen.add(placement)
    }
    expect([...seen].sort()).toEqual(
      [
        "asked",
        "blockedStandIn",
        "hidden",
        "manager",
        "mine",
        "nobody",
        "on_item",
        "others",
        "owner",
        "person",
        "standIn",
        "standing_in",
        "usual",
      ].sort(),
    )
  })
})

describe("awayRunEnd", () => {
  const range = (over: Partial<AwayRangeDays>): AwayRangeDays => ({
    startsOn: "2026-10-01",
    endsOn: "2026-10-02",
    weekdays: null,
    status: "active",
    endedEarlyOn: null,
    ...over,
  })

  it("is the last day of the run that includes today, and null when not away", () => {
    expect(awayRunEnd([range({})], "2026-10-01")).toBe("2026-10-02")
    expect(awayRunEnd([range({})], "2026-10-03")).toBeNull()
    // Two ranges that touch are one run.
    expect(
      awayRunEnd(
        [range({}), range({ startsOn: "2026-10-03", endsOn: "2026-10-05" })],
        "2026-10-01",
      ),
    ).toBe("2026-10-05")
    // A recurring Friday ends its run on that Friday.
    expect(awayRunEnd([range({ endsOn: null, weekdays: [5] })], "2026-10-02")).toBe("2026-10-02")
  })
})
