// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Workers parity fixture (executor-parity.test.ts). No imports: the same
// source is the QuickJS bundle and the Worker module.

type Ctx = any

class ToolError extends Error {
  safe = true
  code: string
  retryable = false
  constructor(message: string, code: string) {
    super(message)
    this.name = "ToolError"
    this.code = code
  }
}

export async function create(p: { title: string }, ctx: Ctx) {
  const row = await ctx.db.insert("items", { title: p.title })
  return { title: row.title, hasId: typeof row.id === "string" }
}

export async function list(_p: unknown, ctx: Ctx) {
  const rows = await ctx.db.findMany("items", {})
  return { titles: rows.map((r: { title: string }) => r.title).sort() }
}

export async function atomicFail(p: { title: string }, ctx: Ctx) {
  await ctx.db.insert("items", { title: p.title })
  throw new Error("atomic tool failed after its write")
}

export async function hop(p: { v: string }, ctx: Ctx) {
  return ctx.executeTool("wparityb:echo", { v: p.v })
}

export async function fetchOutside(_p: unknown, ctx: Ctx) {
  try {
    await ctx.fetch("https://not-allowed.example.net/x", { method: "GET" })
    return { refused: false }
  } catch (e) {
    return { refused: true, message: String((e as Error)?.message ?? e) }
  }
}

export async function fetchAuth(_p: unknown, ctx: Ctx) {
  const res = await ctx.fetch("https://api.carrier.test/echo", {
    method: "GET",
    auth: { connection: "carrier", scheme: "header:X-Api-Key", fields: ["key"] },
  })
  return { status: res.status, body: res.body }
}

export async function stamp(p: { marker: string }, ctx: Ctx) {
  await ctx.logger.info("stamping", { marker: p.marker })
  await ctx.emit({
    entity: "items",
    action: "stamped",
    entityId: p.marker,
    data: { marker: p.marker },
  })
  return { stamped: p.marker }
}

export async function bulk(p: { url: string }, ctx: Ctx) {
  const blob = await ctx.bulk.fetchToBlob(p.url)
  if (!blob?.blobId) return { noBlob: blob ?? null }
  const seen: unknown[] = []
  for await (const batch of ctx.bulk.iterateJsonl(blob.blobId, { batchSize: 2 })) {
    seen.push(...(Array.isArray(batch) ? batch : [batch]))
  }
  await ctx.bulk.deleteBlob(blob.blobId)
  return { sizeBytes: blob.sizeBytes, rows: seen }
}

export async function approvalEcho(_p: unknown, ctx: Ctx) {
  return { approval: ctx.approval ?? null, truthy: !!ctx.approval }
}

export async function fail() {
  const e = new Error("bad input for fail") as Error & { status: number; code: string }
  e.status = 422
  e.code = "bad_input"
  throw e
}

export async function toolFail() {
  throw new ToolError("the carrier refused the parcel", "carrier_refused")
}

export async function slow(p: { ms: number }, ctx: Ctx) {
  const until = Date.now() + p.ms
  let n = 0
  while (Date.now() < until) {
    await ctx.db.count("items", {})
    n++
  }
  return { n }
}

export async function configSecret(p: { value: string }, ctx: Ctx) {
  await ctx.config.setSecret("carrierAppSecret", p.value)
  try {
    return { read: await ctx.config.get("carrierAppSecret") }
  } catch (e) {
    const err = e as { code?: string; status?: number }
    return { refused: true, code: err?.code ?? null, status: err?.status ?? null }
  }
}

export async function slowCreate(p: { ms: number; title: string }, ctx: Ctx) {
  const until = Date.now() + p.ms
  while (Date.now() < until) await ctx.db.count("items", {})
  await ctx.db.insert("items", { title: p.title })
  return { ok: true }
}

export async function onPing(payload: { title: string }, ctx: Ctx) {
  await ctx.db.insert("items", { title: payload.title })
  return { ok: true }
}

export async function verifyPing(req: { body: string }) {
  return { valid: true, replayKey: `ping:${req.body}` }
}
