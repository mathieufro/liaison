// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Approval authority — the ONE place that answers, for an approval row:
 *
 *   Q1  "What scope decides this approval?"        → `decidingScope`
 *   Q2  "Who can see it, per surface?"             → `canSeeInFeed` / `canSeeInList`
 *   Q2b "Who may act on it (decide / edit)?"       → `canDecidePure` / `canEditPure`
 *
 * Four prod failures in one week (2026-08-05/06) shared a single root pattern:
 * the same question answered differently in different places — most literally a
 * read site recomputing `<app>:approve` from the tool name instead of reading
 * the row's persisted `approve_scope` (which dimension-constrained approvals,
 * e.g. skills, set to `kernel:skills:approve`). Every surface (attention feed,
 * approvals list, decide, edit, web card/store) must call these functions; the
 * `authority-closure` oracle fails CI on any new out-of-module recompute.
 *
 * Two levels, deliberately:
 *  - PRIMITIVES (decidingScope, isOwnerRouted, isNotified, holdsDecidingScope):
 *    divergence here is the bug class. There is exactly one implementation.
 *  - COMPOSED POLICIES (canSeeInFeed / canSeeInList / …): surfaces legitimately
 *    differ in AUDIENCE — the feed is anti-noise-narrow (notified AND able to
 *    decide; a decider who was never notified does NOT see the row — that is a
 *    routing question, not a rendering one, and widening it would flood every
 *    tickets:approve holder with every ticket reply), while the list is
 *    requester-inclusive and ticket/mail-surface-widened, and the SQL RLS
 *    policy is wider still (find-and-open). Divergence between the composed
 *    policies is design; each is documented where it differs.
 *
 * Invariants this module encodes (and its tests pin):
 *  - Ownership-routed approvals (`resourceOwnerId` set) are private ABSOLUTELY:
 *    invisible even to a `*`-scoped admin. Personal-mailbox drafts must never
 *    surface to the org.
 *  - `kernel:approve` is admin-grade and is never REQUIRED for a domain
 *    approval: a row that persists a custom scope (`kernel:skills:approve`,
 *    `knowledge:approve`, …) is decided by that scope alone.
 *  - A disclosure-only approval (an ungated write parked only because its turn read scoped
 *    data, scope-taint.ts rule 8h) persists a taint scope as `approve_scope`: whoever holds
 *    every scope the turn read decides it, never `<app>:approve`.
 *
 * Pure by construction — no API imports, no database — so the web is a CALLER
 * of the same answerer rather than a mirror of it (a mirror is how the web card
 * rendered a skill approval without Approve/Deny for the actual approvers).
 */

export interface ApprovalAuthorityFacts {
  toolName: string
  /** The row's persisted decision-scope override; null = derive `<app>:approve`. */
  approveScope: string | null
  /** Ownership routing: when set, the approval is private to this user. */
  resourceOwnerId: string | null
  requestedById: string
  notifyUserIds: string[] | null
}

/** Who is asking. `hasScope` is a callback so the API (array-backed) and the
 *  web (auth-store-backed) evaluate scopes with their own hierarchical matcher
 *  without this module importing either. */
export interface AuthorityViewer {
  userId: string
  hasScope: (scope: string) => boolean
}

/**
 * Loud-failure shape guard. Facts are built from SQL rows selected by hand; a
 * SELECT that drops a column yields `undefined`, which `??`/truthiness would
 * silently coerce into the fallback branch — exactly how list.ts answered the
 * scope question wrong for weeks. `undefined` here always means a caller bug
 * (missing column), never a legitimate value: adapters map SQL NULL to `null`.
 */
function assertFacts(f: ApprovalAuthorityFacts): void {
  for (const key of [
    "toolName",
    "approveScope",
    "resourceOwnerId",
    "requestedById",
    "notifyUserIds",
  ] as const) {
    if (f[key] === undefined) {
      throw new Error(
        `approval authority facts missing '${key}' — the caller's SELECT omitted a canonical column (see APPROVAL_AUTHORITY_COLUMNS)`,
      )
    }
  }
}

function appNameOf(toolName: string): string {
  const idx = toolName.indexOf(":")
  return idx === -1 ? toolName : toolName.slice(0, idx)
}

// ---------------------------------------------------------------------------
// Primitives — divergence here is the bug class.
// ---------------------------------------------------------------------------

/**
 * THE answer to "what scope decides this approval?": the row's own persisted
 * `approve_scope`, falling back to the derived `<app>:approve` only when the
 * row carries none. Never recompute from the tool name at a read site — a
 * `kernel:update_skill` row is decided by `kernel:skills:approve`, and asking
 * for `kernel:approve` instead demands an admin-grade scope the actual
 * approvers deliberately do not hold (the 2026-08-06 invisible-skill-approvals
 * bug). The SQL RLS policy mirrors this as
 * `COALESCE(approve_scope, split_part(tool_name,':',1)||':approve')`; the
 * authority-rls-parity test holds the two together.
 */
export function decidingScope(f: ApprovalAuthorityFacts): string {
  assertFacts(f)
  return f.approveScope ?? `${appNameOf(f.toolName)}:approve`
}

/** Registry-level twin of `decidingScope` for TOOL DEFINITIONS (no row exists
 *  yet): what scope will decide an approval this tool raises. Used by the scope
 *  catalog so "which approver scopes exist" and "which scope decides a row"
 *  can never diverge again.
 *
 *  An app tool is decided by `<app>:approve`. A KERNEL tool is decided by its own
 *  required scope: holding `kernel:contacts:write` is the right to update contacts,
 *  so it alone decides a parked contact edit. `kernel:approve` is the admin-grade
 *  scope and decides only the kernel tools that name it as their `approveScope`
 *  (role, user, policy, app-access, configuration, routine and connection
 *  administration), plus a kernel tool whose single deciding scope is ambiguous
 *  (several required scopes and none named). */
export function decidingScopeForToolDef(
  def: { approveScope?: string | null; requiredScopes?: readonly string[] },
  appName: string,
): string {
  if (def.approveScope) return def.approveScope
  if (appName === "kernel" && def.requiredScopes?.length === 1) return def.requiredScopes[0]!
  return `${appName}:approve`
}

export function isOwnerRouted(f: ApprovalAuthorityFacts): boolean {
  assertFacts(f)
  return f.resourceOwnerId != null
}

export function isNotified(f: ApprovalAuthorityFacts, userId: string): boolean {
  assertFacts(f)
  return Array.isArray(f.notifyUserIds) && f.notifyUserIds.includes(userId)
}

export function isRequester(f: ApprovalAuthorityFacts, userId: string): boolean {
  assertFacts(f)
  return f.requestedById === userId
}

/** Whether the viewer holds the scope that decides this row (Q1 applied to a
 *  viewer). This is a CAPABILITY check only — audience membership is separate
 *  (`isNotified`) and the composed policies combine the two. */
export function holdsDecidingScope(f: ApprovalAuthorityFacts, viewer: AuthorityViewer): boolean {
  return viewer.hasScope(decidingScope(f))
}

// ---------------------------------------------------------------------------
// Composed policies — divergence here is design; each difference is stated.
// ---------------------------------------------------------------------------

/**
 * Feed visibility (attention items): the NARROWEST surface, by design.
 *  - Owner-routed rows are visible to the owner alone — even a `*`-scoped
 *    admin is excluded (absolute privacy for personal-resource drafts).
 *  - Otherwise: notified AND able to decide. The notified gate is deliberate
 *    anti-noise (attention.test.ts A2): a decider who was never routed the
 *    request does not get it in their feed, and a notified user who cannot
 *    decide sees nothing actionable (A3). "But the list shows it" is by
 *    design — the list is the requester-inclusive wide surface, the feed is
 *    the decide-queue.
 */
export function canSeeInFeed(f: ApprovalAuthorityFacts, viewer: AuthorityViewer): boolean {
  if (isOwnerRouted(f)) return f.resourceOwnerId === viewer.userId
  return isNotified(f, viewer.userId) && holdsDecidingScope(f, viewer)
}

/**
 * List visibility (`GET /api/approvals` and its MCP/bundled-app wrappers):
 * wider than the feed, per design.
 *  - Owner-routed rows: requester or owner only — in EVERY mode, including the
 *    shared-surface modes (a reply drafted from a personal mailbox must not
 *    surface to the whole team).
 *  - Ticket mode (`ticketId` filter): anyone who can read the ticket can see
 *    its pending drafts (`tickets:tickets:read`) — "if you can read the
 *    surface, you can see its drafts".
 *  - Conversation mode (`conversationId`): same boundary via
 *    `mail:conversations:read`.
 *  - The requester always sees their own request (they must be able to watch
 *    and withdraw it) — a deliberate widening the feed does not have.
 *  - Otherwise: notified AND able to decide, per the shared primitives. (This
 *    predicate is where the list recomputed `<app>:approve` and silently
 *    dropped skill approvals that RLS had already let through.)
 */
export function canSeeInList(
  f: ApprovalAuthorityFacts,
  viewer: AuthorityViewer,
  mode: { ticketId?: string; conversationId?: string } = {},
): boolean {
  if (isOwnerRouted(f)) {
    return isRequester(f, viewer.userId) || f.resourceOwnerId === viewer.userId
  }
  if (mode.ticketId) return viewer.hasScope(TICKET_DRAFT_READ_SCOPE)
  if (mode.conversationId) return viewer.hasScope(MAIL_DRAFT_READ_SCOPE)
  if (isRequester(f, viewer.userId)) return true
  return isNotified(f, viewer.userId) && holdsDecidingScope(f, viewer)
}

/**
 * Approver eligibility, pure part: may this viewer APPROVE the row?
 *  - Owner-routed: the owner alone, with or without any approve scope — it is
 *    their own resource.
 *  - Shared-surface drafts (`sharedSurface`: ticket/mail replies on a shared,
 *    non-owner-routed surface) widen the audience to any holder of the
 *    deciding scope — a support ticket is a shared work item.
 *  - Otherwise: in the notify audience AND holds the deciding scope.
 *
 * Two rules deliberately stay OUTSIDE this predicate, in the API decide flow:
 * the requester-withdrawal rule (a requester may DENY their own request
 * without being an eligible approver) and dimension-constraint coverage
 * (requires the decider's freshly loaded dimension grants — impure). The web
 * omits both by design: withdrawal renders separately, and dimension checks
 * round-trip to the server.
 */
export function canDecidePure(
  f: ApprovalAuthorityFacts,
  viewer: AuthorityViewer,
  opts: { sharedSurface: boolean },
): boolean {
  if (isOwnerRouted(f)) return f.resourceOwnerId === viewer.userId
  if (opts.sharedSurface) return holdsDecidingScope(f, viewer)
  return isNotified(f, viewer.userId) && holdsDecidingScope(f, viewer)
}

/**
 * Payload-edit eligibility, pure part. The requester and the resource owner
 * may always edit their own pending draft; anyone else needs audience
 * membership (notify-set, or the shared-surface widening) plus the deciding
 * scope — the same boundary as decide, because editing shapes what executes.
 */
export function canEditPure(
  f: ApprovalAuthorityFacts,
  viewer: AuthorityViewer,
  opts: { sharedSurface: boolean },
): boolean {
  if (isRequester(f, viewer.userId)) return true
  if (isOwnerRouted(f)) return f.resourceOwnerId === viewer.userId
  const inAudience = opts.sharedSurface || isNotified(f, viewer.userId)
  return inAudience && holdsDecidingScope(f, viewer)
}

/**
 * Tool families whose approvals gate a SHARED ticket/mail surface the whole
 * team works, not a privately-routed action. For these, decide/edit eligibility
 * widens from notify-set membership to "any holder of the deciding scope" —
 * a teammate who can act on the ticket may decide a colleague's drafted reply.
 * One copy here (the API's event-data module and the web both consume it);
 * keep in sync with the ticket/conversation-mode tool_name IN-lists in the
 * API's list.ts SQL.
 */
/**
 * Facts about WHO raised a pending approval, for the feed's peer-noise filter.
 * Separate from {@link ApprovalAuthorityFacts} on purpose: that type is the
 * frozen authority contract every surface builds from a hand-written SELECT,
 * and `assertFacts` rejects a missing column loudly. Peer classification is
 * presentation, not authority — it never widens what anyone may see or decide.
 */
export interface PeerRequestFacts {
  requestedById: string
  /** Set when a routine raised the request rather than a person. */
  originRoutineId: string | null
  /**
   * A scheduled job raised it (`metadata.origin` "system"). The row is filed under a member only
   * because a request needs one, so that member did not ask for it.
   */
  raisedBySystem?: boolean
  /** Whether the REQUESTER holds the scope that decides their OWN request. */
  requesterCanDecide: boolean
}

/**
 * Whether this row is peer noise the feed hides by default.
 *
 * When two people both hold `<app>:approve`, everything each of them asks for
 * lands in the other's feed, even though the requester could have approved it
 * themselves and normally does. Two CEOs filing tasks bury each other's real
 * queue under rows neither was ever meant to act on.
 *
 * Three things are never noise and are always shown:
 *  - your OWN requests: you are watching them, and you may withdraw them;
 *  - ROUTINE-raised requests: no human is waiting behind them, so if you do not
 *    act nobody will;
 *  - requests from someone who CANNOT decide their own: those are exactly the
 *    ones genuinely waiting on you.
 *
 * Only the fourth case — another person who could self-approve — is hidden, and
 * only from the default view. This is a display default, never a permission:
 * the row stays visible with the filter off and decidable either way.
 */
export function isPeerSelfApprovable(f: PeerRequestFacts, viewerUserId: string): boolean {
  if (f.requestedById === viewerUserId) return false
  return requesterApprovesTheirOwn(f)
}

/** A person, not a routine, raised this and can decide it themselves. */
function requesterApprovesTheirOwn(f: PeerRequestFacts): boolean {
  if (f.originRoutineId || f.raisedBySystem) return false
  return f.requesterCanDecide
}

// ---------------------------------------------------------------------------
// Who an approval is for. Routing sorts the audience `canSeeInFeed` already
// answers; it never widens it. Nothing here grants anything, and no decide rule
// reads it, so what someone may see or sign stays with the primitives above.
// ---------------------------------------------------------------------------

/** The row's routing inputs, kept apart from the frozen facts type like {@link PeerRequestFacts}. */
export interface RoutingFacts {
  /** The person on the item when it was proposed, kept current by assignment. */
  routePersonId: string | null
  /** Read now from the row's company, so a hand-over moves pending rows. */
  managerId: string | null
  minApprovers: number
  /** A dead execution, which needs whoever signed it. */
  stalled: boolean
  peer: PeerRequestFacts
}

/** What the caller reads for the row at feed time. Injected, so this module stays pure. */
export interface RoutingWorld {
  /** In the row's notify set, active, and holding its deciding scope today. */
  canDecide(userId: string): boolean
  /** Still an active member. Tells someone who left from someone who cannot decide. */
  isActive(userId: string): boolean
  /** null when not away today in that person's own time zone. `until` is the last day of the current run of away days, also for a recurring row, never null while away. */
  away(userId: string): { until: string | null; nextInLineId: string | null } | null
}

export type ApprovalRoute =
  | { to: "owner"; userId: string }
  | { to: "usual" }
  | {
      to: "person"
      userId: string
      why: "asked" | "on_item" | "manager"
      awayUntil: string | null
      standIn: string | null
      blockedStandIn: string | null
    }

export type HomePlacement = "mine" | "standing_in" | "others" | "hidden"

/**
 * Whose a pending row is, in this order:
 *  1. Owner-routed: the owner. Private, never passes on, and away is not read.
 *  2. Stalled, or needing two approvers: the usual deciders. A second person must
 *     be able to find a two-approver row, so it is never folded under someone.
 *  3. The first candidate who can decide: a requester who could approve their own,
 *     then the person on the item, then the manager. None: the usual deciders.
 *  4. Candidate not away: that person, with no stand-in.
 *  5. Candidate away: that person, plus whoever the next-in-line walk finds.
 */
export function routeApproval(
  f: ApprovalAuthorityFacts,
  r: RoutingFacts,
  w: RoutingWorld,
): ApprovalRoute {
  assertFacts(f)
  if (f.resourceOwnerId != null) return { to: "owner", userId: f.resourceOwnerId }
  if (r.stalled || r.minApprovers >= 2) return { to: "usual" }

  // A requester who cannot decide their own request is no candidate, whatever else they are.
  const decides = (userId: string) =>
    w.canDecide(userId) && (userId !== r.peer.requestedById || r.peer.requesterCanDecide)

  const candidates = [
    { userId: requesterApprovesTheirOwn(r.peer) ? r.peer.requestedById : null, why: "asked" },
    { userId: r.routePersonId, why: "on_item" },
    { userId: r.managerId, why: "manager" },
  ] as const
  for (const { userId, why } of candidates) {
    if (userId === null || !decides(userId)) continue
    const away = w.away(userId)
    if (!away) {
      return { to: "person", userId, why, awayUntil: null, standIn: null, blockedStandIn: null }
    }
    return {
      to: "person",
      userId,
      why,
      awayUntil: away.until,
      ...walkNextInLine(userId, away.nextInLineId, w, decides),
    }
  }
  return { to: "usual" }
}

/**
 * Someone away moves on to their own next in line. The first person not away who
 * can decide stands in. Someone who left ends the walk naming nobody, so no row
 * names them. The first active person not away who cannot decide stops it as
 * blocked. A repeat or a null stops it with nobody, and the usual deciders hold the row.
 */
function walkNextInLine(
  from: string,
  first: string | null,
  w: RoutingWorld,
  decides: (userId: string) => boolean,
): { standIn: string | null; blockedStandIn: string | null } {
  const seen = new Set([from])
  let next = first
  while (next !== null && !seen.has(next)) {
    seen.add(next)
    if (!w.isActive(next)) break
    const away = w.away(next)
    if (!away) {
      return decides(next)
        ? { standIn: next, blockedStandIn: null }
        : { standIn: null, blockedStandIn: next }
    }
    next = away.nextInLineId
  }
  return { standIn: null, blockedStandIn: null }
}

/**
 * Where the row sits on this viewer's Home. Not visible in the feed is hidden,
 * always first, so a route can only sort the people {@link canSeeInFeed} already
 * lets in. The person it is for keeps it while away, since they can still act.
 * Away with no stand-in, it belongs to the usual deciders.
 */
export function homePlacement(
  f: ApprovalAuthorityFacts,
  route: ApprovalRoute,
  viewer: AuthorityViewer,
): HomePlacement {
  if (!canSeeInFeed(f, viewer)) return "hidden"
  if (route.to !== "person") return "mine"
  if (route.userId === viewer.userId) return "mine"
  if (route.standIn !== null) return route.standIn === viewer.userId ? "standing_in" : "others"
  return route.awayUntil !== null ? "mine" : "others"
}

/** The dates of one away range. Dates are `YYYY-MM-DD` in the person's own time zone. */
export interface AwayRangeDays {
  startsOn: string
  /** Inclusive. null only with `weekdays`. */
  endsOn: string | null
  /** ISO days, Monday 1 to Sunday 7. null means every day of the range. */
  weekdays: readonly number[] | null
  status: "active" | "asked" | "declined"
  endedEarlyOn: string | null
}

/**
 * What a reader of away days returns for `(orgId, userIds, from, to)`: each person's
 * away dates in that window, as `YYYY-MM-DD`. Someone with none has no key. It holds
 * dates alone, never where they came from or why.
 */
export type AwayDays = ReadonlyMap<string, readonly string[]>

/** The one predicate for "is this person away on this date of theirs". */
export function isAwayOn(range: AwayRangeDays, localDate: string): boolean {
  if (range.status !== "active") return false
  if (localDate < range.startsOn) return false
  if (range.endsOn !== null && localDate > range.endsOn) return false
  // Ending early brings the person back that same day.
  if (range.endedEarlyOn !== null && localDate >= range.endedEarlyOn) return false
  return range.weekdays === null || range.weekdays.includes(isoWeekday(localDate))
}

/** At most this many days ahead when finding the last day of a run of away days. */
const AWAY_RUN_HORIZON_DAYS = 400

/**
 * The last day of the run of away days that includes `today`, or null when the person is not
 * away that day. A recurring range ends its run on its last away day in a row, never later.
 */
export function awayRunEnd(ranges: readonly AwayRangeDays[], today: string): string | null {
  const away = (date: string) => ranges.some((r) => isAwayOn(r, date))
  if (!away(today)) return null
  let last = today
  for (let i = 1; i <= AWAY_RUN_HORIZON_DAYS; i++) {
    const next = new Date(`${today}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + i)
    const date = next.toISOString().slice(0, 10)
    if (!away(date)) break
    last = date
  }
  return last
}

function isoWeekday(localDate: string): number {
  // A date alone parses as midnight UTC, so this day is the date's own.
  const day = new Date(localDate).getUTCDay()
  return day === 0 ? 7 : day
}

/** A person's date at an instant: their zone, else the org's, else UTC. A zone that cannot be read counts as none. */
export function personLocalDate(
  at: Date,
  userTimezone: string | null,
  orgTimezone: string | null,
): string {
  for (const zone of [userTimezone, orgTimezone]) {
    if (!zone) continue
    try {
      return dateInZone(at, zone)
    } catch {}
  }
  return dateInZone(at, "UTC")
}

function dateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

/** Who sees a ticket's pending drafts in the list's ticket mode: anyone who reads the ticket. */
export const TICKET_DRAFT_READ_SCOPE = "tickets:tickets:read"
/** Who sees a mail conversation's pending drafts in the list's conversation mode. */
export const MAIL_DRAFT_READ_SCOPE = "mail:conversations:read"

/**
 * The scope under which a shared-surface tool's pending drafts are listed to everyone who reads
 * the surface ({@link canSeeInList}'s ticket and conversation modes), or null for any other
 * tool. The API's scope taint judges a tainted shared-surface draft by the holders of this scope
 * (and of its deciding scope), so "who sees the draft" has this one answer.
 */
export function sharedSurfaceDraftReadScope(toolName: string): string | null {
  if (!SHARED_SURFACE_APPROVAL_TOOLS.has(toolName)) return null
  if (toolName.startsWith("tickets:")) return TICKET_DRAFT_READ_SCOPE
  if (toolName.startsWith("mail:")) return MAIL_DRAFT_READ_SCOPE
  return null
}

export const SHARED_SURFACE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "tickets:reply",
  "tickets:nudge",
  "tickets:close",
  "mail:reply",
  "mail:forward",
])

/** Ownership-aware shared-surface check on authority facts: a shared-surface
 *  tool that targets a PERSONALLY-owned resource (owner-routed) is NOT shared —
 *  the team-wide widening must never apply to it. */
export function isSharedSurfaceFacts(f: ApprovalAuthorityFacts): boolean {
  return !isOwnerRouted(f) && SHARED_SURFACE_APPROVAL_TOOLS.has(f.toolName)
}

/**
 * Facts from the wire DTO (`ApprovalRequestSummary`-shaped), for web callers.
 * `approveScope` may be `undefined` on rows cached from a pre-`approveScope`
 * deploy (WS payloads, stale list responses) — tolerated as `null` (legacy
 * fallback) for one release rather than tripping the shape guard, since a
 * browser cannot re-SELECT the row.
 */
export function factsFromSummary(row: {
  toolName: string
  approveScope?: string | null
  resourceOwnerId?: string | null
  requestedBy: { id: string }
  notifyUserIds: string[]
}): ApprovalAuthorityFacts {
  return {
    toolName: row.toolName,
    approveScope: row.approveScope ?? null,
    resourceOwnerId: row.resourceOwnerId ?? null,
    requestedById: row.requestedBy.id,
    notifyUserIds: row.notifyUserIds ?? null,
  }
}
