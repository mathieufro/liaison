// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What must be true of a link after an event, one function per class. A cell of the relation
// matrix reads the link through the product's own read path as several readers, before and after
// the event, and hands both readings to its class. A class throws a `ClassViolation` naming what
// broke; it never reads the database itself, so each one is tested against a seeded wrong
// behaviour without a server (classes.test.ts).

/** What one reader sees of the linked item through the product's read path. */
export interface Sight {
  /** The reader has the item at all (a row, a range, an anchor). */
  visible: boolean
  /** The id the link points at, as the read shows it; null when it points at nothing. */
  points?: string | null
  /** A copied name the read shows for the other end, when it shows one. */
  label?: string | null
  /** A visible state the read shows for the link (`cancelled`, `left`, `blocked`...). */
  state?: string | null
  /** Where the item sits for this reader (Home's `mine`, `others`, `standing_in`). */
  placement?: string | null
  /** For whom the reader holds it, when it is passed on. */
  forPerson?: string | null
  /** How many of this item the reader counts (badge, list length). */
  count?: number
}

/** Readers by role (`decider`, `standIn`, `outsider`...). */
export type Reading = Record<string, Sight>

export interface ClassInput {
  before: Reading
  after: Reading
  /** Readers who must still hold the item once a link closes or passes on. */
  whoIsTold: readonly string[]
  /** States that say the link closed, as the read shows them. */
  visibleState: readonly string[]
  /** Readers whose read shows the copied name (empty: none does). */
  copiedNameAt: readonly string[]
  /** What the event did, as the cell's event reports it. */
  facts: EventFacts
}

export interface EventFacts {
  /** The name the event gave the other end (rename). */
  newName?: string
  /** The name the other end had before. */
  oldName?: string
  /** The id the link must now point at (merge survivor, new parent). */
  survivor?: string
  /** The id no read may point at any more. */
  goneId?: string
  /** The reader who lost access (hide), and a reader who never had it (its control). */
  lostAccess?: string
  neverHad?: string
  /** The sentence a refused event answered with. */
  refusal?: string | null
  /** Ids the export carried. */
  exported?: readonly string[]
  /** The id of the link's own row, which the export must carry. */
  linkRowId?: string
  /** Rows of the link left after a demo reset. */
  leftAfterReset?: number
  /** The person the item belongs to, and the next in line who must get it (pass on). */
  person?: string
  nextInLine?: string | null
  /** Readers who may not gain the item (pass on, hide). */
  mustNotGain?: readonly string[]
  /** For a migrated row: the reading of a row written today with the same meaning. */
  asToday?: Reading
  /** Rows of the link after the way back, and before the event. */
  rowsAfter?: number
  rowsBefore?: number
}

export class ClassViolation extends Error {
  constructor(
    readonly cls: string,
    message: string,
  ) {
    super(`${cls}: ${message}`)
    this.name = "ClassViolation"
  }
}

function fail(cls: string, message: string): never {
  throw new ClassViolation(cls, message)
}

function sight(r: Reading, who: string, cls: string): Sight {
  const s = r[who]
  if (!s) fail(cls, `no reading for ${who}`)
  return s
}

function same(a: Sight, b: Sight): boolean {
  return JSON.stringify(normal(a)) === JSON.stringify(normal(b))
}

function normal(s: Sight): Sight {
  const out: Sight = { visible: s.visible }
  if (s.points != null) out.points = s.points
  if (s.label != null) out.label = s.label
  if (s.state != null) out.state = s.state
  if (s.placement != null) out.placement = s.placement
  if (s.forPerson != null) out.forPerson = s.forPerson
  if (s.count != null) out.count = s.count
  return out
}

/** K: the link holds; a copied name shows the new one. */
export function keep(i: ClassInput): void {
  for (const [who, b] of Object.entries(i.before)) {
    const a = sight(i.after, who, "keep")
    if (b.visible && !a.visible) fail("keep", `${who} lost the item`)
    if (b.points !== undefined && a.points !== b.points)
      fail("keep", `${who} sees it pointing at ${a.points}, not ${b.points}`)
  }
  if (i.facts.newName !== undefined) {
    for (const who of i.copiedNameAt) {
      const a = sight(i.after, who, "keep")
      if (a.label !== i.facts.newName)
        fail("keep", `${who} shows "${a.label}", not the new name "${i.facts.newName}"`)
    }
  }
}

/** P: the link moves to the survivor; no read points at the old id. */
export function repoint(i: ClassInput): void {
  const { survivor, goneId } = i.facts
  if (!survivor || !goneId) fail("repoint", "the event named no survivor and no merged-away id")
  for (const [who, a] of Object.entries(i.after)) {
    if (a.points === goneId) fail("repoint", `${who} still sees it pointing at the merged-away id`)
  }
  for (const who of i.whoIsTold) {
    const a = sight(i.after, who, "repoint")
    if (!a.visible) fail("repoint", `${who} lost the item`)
    if (a.points !== survivor)
      fail("repoint", `${who} sees it pointing at ${a.points}, not the survivor`)
  }
}

/** S: a frozen record keeps the old text. */
export function snapshot(i: ClassInput): void {
  if (i.facts.oldName === undefined) fail("snapshot", "the event named no old text")
  let shown = 0
  for (const [who, b] of Object.entries(i.before)) {
    if (!b.visible || b.label == null) continue
    shown++
    const a = sight(i.after, who, "snapshot")
    if (!a.visible) fail("snapshot", `${who} lost the frozen record`)
    if (a.label !== i.facts.oldName)
      fail("snapshot", `${who} shows "${a.label}" on a frozen record, not "${i.facts.oldName}"`)
  }
  if (shown === 0) fail("snapshot", "no reader showed the record's text before the event")
}

/** C: the link ends with a visible state, and whoever needs to know still holds the item. */
export function close(i: ClassInput): void {
  if (i.whoIsTold.length === 0) fail("close", "the link declares nobody to tell")
  let shown = false
  for (const [who, a] of Object.entries(i.after)) {
    const b = i.before[who]
    const saysClosed = Boolean(a.state && i.visibleState.includes(a.state))
    if (i.facts.goneId && a.points === i.facts.goneId && !saysClosed)
      fail("close", `${who} still sees it pointing at what left, with no state saying so`)
    if (a.state && i.visibleState.includes(a.state)) shown = true
    if (b?.visible && a.visible && same(a, b) && i.whoIsTold.includes(who) && !a.state)
      fail("close", `${who} reads it exactly as before: the link did not end`)
  }
  if (!shown) fail("close", `no reader shows a closed state (${i.visibleState.join(", ")})`)
  for (const who of i.whoIsTold) {
    if (!sight(i.after, who, "close").visible)
      fail("close", `${who}, who must be told, lost the item`)
  }
}

/** H: the reader who lost access sees what a reader who never had it sees. */
export function hide(i: ClassInput): void {
  const { lostAccess, neverHad } = i.facts
  if (!lostAccess || !neverHad)
    fail("hide", "the event named no reader who lost access and no control")
  const lost = sight(i.after, lostAccess, "hide")
  const control = sight(i.after, neverHad, "hide")
  if (lost.visible || (lost.count ?? 0) > 0 || lost.label)
    fail("hide", `${lostAccess} still sees the item, its count or its title`)
  if (!same(lost, control))
    fail("hide", `${lostAccess}'s empty differs from a reader who never had it`)
  for (const who of i.whoIsTold) {
    if (!sight(i.after, who, "hide").visible)
      fail("hide", `${who}, who keeps access, lost the item`)
  }
}

/** R: the event was refused with a sentence, and the link is unchanged. */
export function refuse(i: ClassInput): void {
  if (!i.facts.refusal || i.facts.refusal.trim().length < 10)
    fail("refuse", "the event was not refused with a sentence")
  for (const [who, b] of Object.entries(i.before)) {
    if (!same(sight(i.after, who, "refuse"), b))
      fail("refuse", `${who} reads it changed after a refusal`)
  }
}

/** E: the export carries the link's row. */
export function exportsIt(i: ClassInput): void {
  const { exported, linkRowId } = i.facts
  if (!linkRowId) fail("export", "the cell named no row to export")
  if (!exported?.includes(linkRowId)) fail("export", "the export does not carry the link's row")
}

/** M: an old row reads through the same path as a row written today with the same meaning. */
export function migrate(i: ClassInput): void {
  if (!i.facts.asToday) fail("migrate", "the cell gave no reading of today's row")
  for (const [who, t] of Object.entries(i.facts.asToday)) {
    if (!same(sight(i.after, who, "migrate"), t))
      fail("migrate", `${who} reads the old row differently from today's`)
  }
}

/** Z: a demo reset leaves no row of the link. */
export function reset(i: ClassInput): void {
  if (i.facts.leftAfterReset === undefined)
    fail("reset", "the cell counted nothing after the reset")
  if (i.facts.leftAfterReset !== 0)
    fail("reset", `${i.facts.leftAfterReset} rows left after the reset`)
}

/** V: after the way back the link reads as before the event, with no row duplicated. */
export function giveBack(i: ClassInput): void {
  for (const [who, b] of Object.entries(i.before)) {
    if (!same(sight(i.after, who, "return"), b))
      fail(
        "return",
        `${who} reads ${JSON.stringify(normal(sight(i.after, who, "return")))}, not ${JSON.stringify(normal(b))}`,
      )
  }
  if (i.facts.rowsAfter !== undefined && i.facts.rowsAfter !== i.facts.rowsBefore)
    fail("return", `${i.facts.rowsAfter} rows after the way back, ${i.facts.rowsBefore} before`)
}

/** W: with a next in line the item reaches them marked for whom; nobody loses it or gains a right. */
export function passOn(i: ClassInput): void {
  const { person, nextInLine } = i.facts
  if (!person) fail("pass on", "the cell named whose item it is")
  if (!sight(i.after, person, "pass on").visible) fail("pass on", "the person lost their own item")
  if (nextInLine) {
    const n = sight(i.after, nextInLine, "pass on")
    if (!n.visible) fail("pass on", "the next in line did not get the item")
    if (n.forPerson !== person)
      fail("pass on", `the next in line holds it for ${n.forPerson}, not for the person`)
  }
  for (const who of i.whoIsTold) {
    if (!sight(i.after, who, "pass on").visible) fail("pass on", `${who} lost the item`)
  }
  for (const who of i.facts.mustNotGain ?? []) {
    const b = i.before[who]
    const a = sight(i.after, who, "pass on")
    if (a.visible && !b?.visible) fail("pass on", `${who} gained an item they had no right to`)
  }
}

export const CLASSES = {
  K: keep,
  P: repoint,
  S: snapshot,
  C: close,
  H: hide,
  R: refuse,
  E: exportsIt,
  M: migrate,
  Z: reset,
  V: giveBack,
  W: passOn,
} as const satisfies Record<string, (i: ClassInput) => void>

export type ClassCode = keyof typeof CLASSES

export const CLASS_WORDS: Record<ClassCode, string> = {
  K: "the link holds",
  P: "the link moves to the survivor",
  S: "the frozen record keeps its text",
  C: "the link closes with a visible state",
  H: "the reader who lost access sees nothing",
  R: "the event is refused while the link is live",
  E: "the export carries it",
  M: "an old row reads as today's",
  Z: "the reset leaves nothing",
  V: "it reads as before",
  W: "it passes on to the next in line",
}
