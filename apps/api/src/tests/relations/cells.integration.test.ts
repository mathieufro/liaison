// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RELATION CELLS: one generated test per kept cell of links.yaml that has a world.
//
// Each test builds its own world through the product's paths, reads the link as its readers do,
// asserts a positive control (the link resolves and the readers who must see the item see it, while
// a reader who never had access does not), runs the event, checks the event took effect on its own
// object, reads again and hands both readings to the cell's class (classes.ts). Each test runs a
// second time with the event replaced by a no-op, which must fail: a cell that stays green without
// its event proves nothing. `migrate` is the one class exempt from that run, since an old row
// reads the same with or without anything happening.
//
// Write names.txt again after adding a cell: RELATIONS_NAMES_WRITE=1. Read why a broken cell
// fails: RELATIONS_SHOW_BROKEN=1 RELATIONS_DEBUG=1.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { approvalOrg } from "./approval-world"
import { CELLS, type CellImpl, type Worlds } from "./cells"
import { CLASSES, type ClassCode, type Reading } from "./classes"
import { cellTitle, checkLinks, keptCells, type LinkDecl, loadLinks, noOpTitle } from "./matrix"

const LINKS = loadLinks()
const KEPT = keptCells(LINKS)
const BY_KEY = new Map(CELLS.map((c) => [`${c.link}:${c.event}`, c]))
const NAMES_PATH = path.join(import.meta.dir, "names.txt")
const CELL_TIMEOUT = 120_000
const NEVER_HAD = "outsider"

interface Runnable {
  impl: CellImpl
  link: LinkDecl
  cls: ClassCode
  broken: boolean
}

const RUNNABLE: Runnable[] = KEPT.flatMap(({ link, event, cls }) => {
  const impl = BY_KEY.get(`${link.name}:${event}`)
  return impl ? [{ impl, link, cls, broken: Boolean(link.broken?.[event]) }] : []
})

export function generatedTitles(): string[] {
  return RUNNABLE.flatMap((r) => {
    const titles = [cellTitle(r.link.name, r.impl.says, r.cls)]
    if (r.cls !== "M" && !r.broken) titles.push(noOpTitle(r.link.name, r.impl.says, r.cls))
    return titles
  })
}

/** Before the event: the readers who must see the item see it, the link resolves, the control sees nothing. */
export function positiveControl(before: Reading, mustSee: readonly string[]): void {
  for (const who of mustSee) {
    const s = before[who]
    if (!s?.visible)
      throw new Error(`positive control: ${who} does not see the item before the event`)
  }
  const resolves = mustSee.some((who) => {
    const s = before[who]
    return Boolean(s?.points || s?.label || s?.placement)
  })
  if (!resolves) throw new Error("positive control: the link resolves for nobody before the event")
  if (before[NEVER_HAD]?.visible)
    throw new Error(`positive control: ${NEVER_HAD}, who never had access, sees the item`)
}

let worlds: Worlds

async function runCell(r: Runnable, noOp: boolean): Promise<void> {
  const { impl, link, cls } = r
  const w = await impl.build(worlds)
  const before = await w.read()
  positiveControl(before, impl.mustSee ?? link.whoIsTold)
  const mark = impl.mark ? await impl.mark(w) : undefined
  if (!noOp) await impl.act(w)
  await impl.took(w, mark)
  const after = await w.read()
  const facts = await impl.facts(w, before)
  if (process.env.RELATIONS_DEBUG === "1" && !noOp)
    console.log(
      JSON.stringify({
        cell: `${link.name}:${impl.event}`,
        before,
        after,
        ticks: (w as { ticks?: string[] }).ticks,
      }),
    )
  if (cls === "M") {
    if (!impl.asToday)
      throw new Error(`${link.name} x ${impl.event}: a migrate cell needs today's reading`)
    facts.asToday = await impl.asToday(w, worlds)
  }
  CLASSES[cls]({
    before,
    after,
    whoIsTold: impl.whoIsTold ?? link.whoIsTold,
    visibleState: link.visibleState,
    copiedNameAt: link.copiedNameAt,
    facts,
  })
}

describe("relation matrix: the links this tree builds", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const org = await approvalOrg((await createTestOrg()).id)
    worlds = { approvals: org, threads: org, routines: org }
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("every kept cell has a generated test or says what it waits for, and nothing else has one", () => {
    expect(checkLinks(LINKS)).toEqual([])
    const missing: string[] = []
    for (const { link, event } of KEPT) {
      const has = BY_KEY.has(`${link.name}:${event}`)
      if (!has && !link.open?.[event])
        missing.push(`${link.name} x ${event}: no test and no open reason`)
      if (has && link.open?.[event])
        missing.push(`${link.name} x ${event}: a test and an open reason`)
      if (!has && link.broken?.[event]) missing.push(`${link.name} x ${event}: broken but no test`)
    }
    for (const c of CELLS) {
      if (!KEPT.some((k) => k.link.name === c.link && k.event === c.event))
        missing.push(`${c.link} x ${c.event}: a test on a cell that is not kept`)
    }
    expect(missing).toEqual([])
  })

  it("names.txt lists every generated title", () => {
    const titles = generatedTitles()
    if (process.env.RELATIONS_NAMES_WRITE === "1")
      writeFileSync(NAMES_PATH, `${titles.join("\n")}\n`)
    expect(readFileSync(NAMES_PATH, "utf8").trim().split("\n")).toEqual(titles)
  })

  for (const r of RUNNABLE) {
    const title = cellTitle(r.link.name, r.impl.says, r.cls)
    // A broken cell runs for real and is expected to fail; once the product is fixed it turns red
    // here and its `broken` entry goes from links.yaml.
    // RELATIONS_SHOW_BROKEN=1 runs them as plain tests, to read why they fail.
    if (r.broken && process.env.RELATIONS_SHOW_BROKEN !== "1")
      it.failing(title, () => runCell(r, false), CELL_TIMEOUT)
    else it(title, () => runCell(r, false), CELL_TIMEOUT)
  }

  for (const r of RUNNABLE) {
    if (r.cls === "M" || r.broken) continue
    it(
      noOpTitle(r.link.name, r.impl.says, r.cls),
      async () => {
        await expect(runCell(r, true)).rejects.toThrow()
      },
      CELL_TIMEOUT,
    )
  }

  it(
    "a reader who never had access fails the positive control",
    async () => {
      for (const name of ["approval-route", "thread-created-from"]) {
        const r = RUNNABLE.find((x) => x.link.name === name && !x.broken)
        if (!r) throw new Error(`no runnable cell of ${name}`)
        const w = await r.impl.build(worlds)
        const before = await w.read()
        const mustSee = r.impl.mustSee ?? r.link.whoIsTold
        expect(() => positiveControl(before, mustSee)).not.toThrow()
        const told = mustSee[0] as string
        const swapped = { ...before, [told]: before[NEVER_HAD] ?? { visible: false } }
        expect(() => positiveControl(swapped, mustSee)).toThrow(/does not see the item/)
      }
    },
    CELL_TIMEOUT,
  )
})
