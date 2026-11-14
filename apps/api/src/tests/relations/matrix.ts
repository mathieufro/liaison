// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The relation matrix of the links this tree builds (links.yaml): each link against every event
// that can break it. A cell is an expected class (upper case) or a pruned reason (lower case). A
// kept cell either has a test, generated from the link's world, the event and the class, or an
// `open` reason saying what it waits for. A kept cell whose test shows the product does not yet do
// what the class says is listed under `broken` with where, and runs as an expected failure, so it
// turns red the day the product is fixed and the entry must go.

import { readFileSync } from "node:fs"
import path from "node:path"
import { CLASS_WORDS, type ClassCode } from "./classes"

export const EVENTS = [
  "Rn",
  "Mg",
  "Dl",
  "Dx",
  "Pm",
  "Ap",
  "Mv",
  "Rs",
  "Dr",
  "Ex",
  "Mi",
  "Rv",
  "Aw",
] as const
export type EventCode = (typeof EVENTS)[number]

export const PRUNED: Record<string, string> = {
  a: "the event cannot happen to this link",
  c: "the same code path as a named cell",
  e: "demo reset is one check, after the demo reset test",
  b: "frozen by design",
}

export interface LinkDecl {
  name: string
  what: string
  storedIn: string
  /** `<schema>.<table>.<column>` of the columns that hold the link. */
  columns: string[]
  /** Source paths whose change runs this link's cells. */
  paths: string[]
  /** States a read shows once the link closed. */
  visibleState: string[]
  /** Readers who must still hold the item after a close or a pass on. */
  whoIsTold: string[]
  /** Readers whose read shows a copied name of the other end. */
  copiedNameAt: string[]
  cells: Record<EventCode, string>
  open?: Partial<Record<EventCode, string>>
  broken?: Partial<Record<EventCode, string>>
}

export const LINKS_PATH = path.join(import.meta.dir, "links.yaml")

export function loadLinks(text = readFileSync(LINKS_PATH, "utf8")): LinkDecl[] {
  const parsed = Bun.YAML.parse(text) as { links: LinkDecl[] }
  return parsed.links
}

export interface KeptCell {
  link: LinkDecl
  event: EventCode
  cls: ClassCode
}

export function keptCells(links: readonly LinkDecl[]): KeptCell[] {
  const out: KeptCell[] = []
  for (const link of links) {
    for (const event of EVENTS) {
      const v = link.cells[event]
      if (v && v in CLASS_WORDS) out.push({ link, event, cls: v as ClassCode })
    }
  }
  return out
}

/** Problems in links.yaml alone: a cell outside the classes and reasons, an open or broken entry on a pruned cell. */
export function checkLinks(links: readonly LinkDecl[]): string[] {
  const problems: string[] = []
  for (const link of links) {
    for (const e of EVENTS) {
      const v = link.cells?.[e]
      if (!v) problems.push(`${link.name} x ${e}: no cell`)
      else if (!(v in CLASS_WORDS) && !(v in PRUNED))
        problems.push(`${link.name} x ${e}: "${v}" is neither a class nor a reason`)
    }
    for (const kind of ["open", "broken"] as const) {
      for (const e of Object.keys(link[kind] ?? {}) as EventCode[]) {
        const v = link.cells[e]
        if (!v || !(v in CLASS_WORDS))
          problems.push(`${link.name} x ${e}: ${kind} on a cell that is not kept`)
      }
    }
    for (const e of Object.keys(link.open ?? {}) as EventCode[]) {
      if (link.broken?.[e]) problems.push(`${link.name} x ${e}: both open and broken`)
    }
  }
  return problems
}

/** The generated test's title: `<link name>: <event in words>, <expected class in words>`. */
export function cellTitle(link: string, says: string, cls: ClassCode): string {
  return `${link}: ${says}, ${CLASS_WORDS[cls]}`
}

export function noOpTitle(link: string, says: string, cls: ClassCode): string {
  return `${cellTitle(link, says, cls)} (fails with the event replaced by a no-op)`
}
