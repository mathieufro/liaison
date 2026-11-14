// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stand-in's OUTSIDE STATE: what the card-payments account holds beyond the
// org's own mirror rows.
//
// The payments app never trusts an event's payload: it reads every event's
// object again by id, confirms the account, and turns a 404 into "another
// account". So a fact that happens "outside" (a refund the app asked for, a
// cancellation, a renewal or a recovered card the demo world plays, an object
// the QA harness writes before it posts a signed event) must be readable BY ID
// before the app's handler runs, or the mirror never moves.
//
// The objects live in Redis, one hash per demo org, so the api and the worker
// processes of one box both see them and a restart keeps them. No migration:
// the stand-in exists only for demo orgs, and the key carries the org's uuid,
// so the org purge removes it with the org's other keys. A demo reset clears
// it (`forgetDemoPaymentsOutside`). Bounded: at most OUTSIDE_MAX_OBJECTS objects
// of at most OUTSIDE_MAX_BYTES each per org, kept OUTSIDE_TTL_SECONDS after the
// last write. A write past the bound is refused, never silently dropped.
import { redis } from "~/lib/redis"
import { KEY_SHAPED } from "./sentinel"

type Obj = Record<string, unknown>

export const OUTSIDE_MAX_OBJECTS = 5_000
export const OUTSIDE_MAX_BYTES = 64 * 1024
export const OUTSIDE_TTL_SECONDS = 120 * 24 * 3600

/** The object kinds the stand-in models, by their `object` field. */
export const OUTSIDE_KINDS = [
  "customer",
  "subscription",
  "invoice",
  "charge",
  "refund",
  "dispute",
  "event",
] as const
export type OutsideKind = (typeof OUTSIDE_KINDS)[number]

const KIND_SET: ReadonlySet<string> = new Set(OUTSIDE_KINDS)

function objectsKey(orgId: string): string {
  return `demo:payments-standin:${orgId}:objects`
}

function idempotencyKey(orgId: string): string {
  return `demo:payments-standin:${orgId}:idempotency`
}

export class OutsideStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OutsideStateError"
  }
}

/** Why `obj` cannot be stored as an outside object, or null when it can. */
export function outsideObjectProblem(obj: unknown): string | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    return "an outside object is a JSON object"
  const o = obj as Obj
  if (typeof o.id !== "string" || !/^[A-Za-z0-9_]{3,64}$/.test(o.id)) {
    return "an outside object needs an `id` of 3 to 64 letters, digits or underscores"
  }
  if (typeof o.object !== "string" || !KIND_SET.has(o.object)) {
    return `object ${o.id}: \`object\` must be one of ${OUTSIDE_KINDS.join(", ")}`
  }
  const text = JSON.stringify(o)
  if (text.length > OUTSIDE_MAX_BYTES) return `object ${o.id} is over ${OUTSIDE_MAX_BYTES} bytes`
  if (KEY_SHAPED.test(text))
    return `object ${o.id} holds a key-shaped string; a stand-in holds no key`
  return null
}

/** Store (or replace) outside objects for `orgId`. Throws `OutsideStateError` on a bad object or past the bound. */
export async function putOutsideObjects(orgId: string, objects: readonly Obj[]): Promise<void> {
  if (objects.length === 0) return
  const fields: string[] = []
  for (const obj of objects) {
    const problem = outsideObjectProblem(obj)
    if (problem) throw new OutsideStateError(problem)
    fields.push(String(obj.id), JSON.stringify(obj))
  }
  const key = objectsKey(orgId)
  const ids = objects.map((o) => String(o.id))
  const present = ids.length > 0 ? await redis.hmget(key, ...ids) : []
  const added = present.filter((v) => v === null).length
  if (added > 0 && (await redis.hlen(key)) + added > OUTSIDE_MAX_OBJECTS) {
    throw new OutsideStateError(
      `the stand-in already holds ${OUTSIDE_MAX_OBJECTS} outside objects for this org; nothing was written`,
    )
  }
  await redis
    .multi()
    .hset(key, ...fields)
    .expire(key, OUTSIDE_TTL_SECONDS)
    .exec()
}

/** One outside object by id, or null. */
export async function outsideObject(orgId: string, id: string): Promise<Obj | null> {
  const raw = await redis.hget(objectsKey(orgId), id)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Obj
  } catch {
    return null
  }
}

/** Every outside object of one kind (bounded by OUTSIDE_MAX_OBJECTS). */
export async function outsideObjectsOf(orgId: string, kind: OutsideKind): Promise<Obj[]> {
  const all = await redis.hvals(objectsKey(orgId))
  const out: Obj[] = []
  for (const raw of all) {
    try {
      const o = JSON.parse(raw) as Obj
      if (o.object === kind) out.push(o)
    } catch {
      // A value that does not parse is not an object the stand-in holds.
    }
  }
  return out
}

/** The id an earlier write with this idempotency key produced, or null. */
export async function idempotentResult(orgId: string, key: string): Promise<string | null> {
  return redis.hget(idempotencyKey(orgId), key)
}

export async function rememberIdempotentResult(
  orgId: string,
  key: string,
  id: string,
): Promise<void> {
  await redis
    .multi()
    .hset(idempotencyKey(orgId), key, id)
    .expire(idempotencyKey(orgId), OUTSIDE_TTL_SECONDS)
    .exec()
}

/** Forget everything the stand-in holds outside for `orgId` (demo reset, world reset). */
export async function forgetDemoPaymentsOutside(orgId: string): Promise<void> {
  await redis.del(objectsKey(orgId), idempotencyKey(orgId))
}

/** How many outside objects `orgId` holds (tests, the reset check). */
export async function countOutsideObjects(orgId: string): Promise<number> {
  return redis.hlen(objectsKey(orgId))
}
