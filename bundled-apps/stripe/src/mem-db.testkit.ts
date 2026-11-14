// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An in-memory copy of the app's tables for the tool tests: equality, `null`
// and `{ in }` filters, an order, limit and offset, as the app database answers.
type Row = Record<string, unknown> & { id: string }

export class MemDb {
  tables = new Map<string, Row[]>()
  writes: Array<{ entity: string; id: string; data: Record<string, unknown> }> = []
  private seq = 0
  rows(entity: string): Row[] {
    if (!this.tables.has(entity)) this.tables.set(entity, [])
    return this.tables.get(entity) as Row[]
  }
  seed(entity: string, rows: Array<Record<string, unknown>>): void {
    for (const r of rows) this.rows(entity).push({ id: `row-${++this.seq}`, ...r } as Row)
  }
  private matches(r: Row, where?: Record<string, unknown>): boolean {
    return Object.entries(where ?? {}).every(([k, v]) => {
      if (v === null) return r[k] == null
      if (v && typeof v === "object" && Array.isArray((v as { in?: unknown[] }).in)) {
        return (v as { in: unknown[] }).in.includes(r[k])
      }
      return r[k] === v
    })
  }
  async findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
      offset?: number
      orderBy?: Record<string, "asc" | "desc">
    },
  ): Promise<unknown[]> {
    const out = this.rows(entity).filter((r) => this.matches(r, opts?.where))
    const keys = Object.entries(opts?.orderBy ?? {})
    out.sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = String(a[k] ?? "")
        const y = String(b[k] ?? "")
        if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1)
      }
      return 0
    })
    const from = opts?.offset ?? 0
    return structuredClone(out.slice(from, from + (opts?.limit ?? out.length)))
  }
  async update(entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    this.writes.push({ entity, id, data: structuredClone(data) })
    const r = this.rows(entity).find((x) => x.id === id)
    if (r) Object.assign(r, structuredClone(data))
  }
}
