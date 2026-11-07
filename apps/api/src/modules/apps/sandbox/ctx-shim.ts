// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The handler-facing `ctx` object, built from a flat list of bridge method
 * names. One rule table (SHIM_RULES) drives two outputs:
 *
 *  - `buildCtxShimSource()`: JavaScript source evaluated inside QuickJS by the
 *    sandbox worker subprocess (sandbox-worker.ts). It expects one global
 *    `__bridge_<method>` async function per method and defines `var __ctx`.
 *  - `createCtx()`: the same object built natively, for a V8 isolate where
 *    every bridge call is an async RPC (`dispatch(method, args)`). No eval.
 *
 * The two wrap implementations (`__wrap` / `__wrapStructured` / the JSONL
 * iterator in the source string, `wrapRaw` / `wrapStructured` /
 * `jsonlIterator` below) must stay semantically identical; ctx-shim.test.ts
 * runs the same handlers through both and compares dispatch sequences and
 * returns.
 *
 * Dependency free by contract (bridge-rejection.ts is pure at runtime): the
 * sandbox worker runs on a minimal env and this file is also bundled into
 * isolate code.
 *
 * Wrap semantics:
 *  - RAW shape (mail/tickets pattern): every arg is a primitive. Args and the
 *    return value pass through unchanged.
 *  - SDK shape (`@liaison/app-sdk` pattern): some arg is non-primitive. Each
 *    non-primitive arg is JSON-stringified, and a string return is
 *    best-effort JSON-parsed (falls back to the string, e.g. base64 digests).
 *  - Structured-return groups (`ctx.kernel.*`, `ctx.db.*`, `ctx.bulk.*`):
 *    the nested members always marshal args and always best-effort parse a
 *    string return, whatever the arg shape (their SDK contract is parsed
 *    data). The flat `ctx.<group>_<member>` names keep the plain wrap.
 *  - `approval` is reserved: it is the K6 data field (`ctx.approval`, a literal
 *    baked from the run's sync context), never a method group, so the flat
 *    `approval_record*` methods cannot shadow it with a truthy container.
 *  - `_approvalContext_get` is hidden from the flat surface (the literal is
 *    the contract).
 *  - `log_*` is mirrored as `ctx.logger.*` (the documented accessor).
 *  - `ctx.bulk.iterateJsonl(blobId, opts)` is an async iterator over the paged
 *    `bulk_iterateJsonl_next(blobId, batchSize)` method: it yields each
 *    page's `batch` until a page says `done`, and throws on an error envelope.
 */

import { typedBridgeFailure } from "./bridge-rejection"

export interface ShimIteratorRule {
  group: string
  member: string
  /** The paged bridge method; present in bridgeMethods or the member is omitted. */
  nextMethod: string
}

export interface ShimRules {
  reservedGroups: readonly string[]
  structuredReturnGroups: readonly string[]
  hiddenNames: readonly string[]
  /** [source group, alias]: the alias mirrors the source unless it already exists. */
  groupAliases: ReadonlyArray<readonly [string, string]>
  iterators: readonly ShimIteratorRule[]
}

export const SHIM_RULES: ShimRules = {
  reservedGroups: ["approval"],
  structuredReturnGroups: ["kernel", "db", "bulk"],
  hiddenNames: ["_approvalContext_get"],
  groupAliases: [["log", "logger"]],
  iterators: [{ group: "bulk", member: "iterateJsonl", nextMethod: "bulk_iterateJsonl_next" }],
}

type MemberPlan =
  | { kind: "method"; member: string; method: string; structured: boolean }
  | { kind: "iterator"; member: string; nextMethod: string }

interface ShimPlan {
  flat: string[]
  groups: Array<[string, MemberPlan[]]>
}

/** The ctx layout both outputs build: flat names, then groups, in this order. */
function planShim(bridgeMethods: readonly string[], rules: ShimRules): ShimPlan {
  const reserved = new Set(rules.reservedGroups)
  const structured = new Set(rules.structuredReturnGroups)
  const hidden = new Set(rules.hiddenNames)
  const groups = new Map<string, MemberPlan[]>()
  for (const m of bridgeMethods) {
    const splitAt = m.indexOf("_")
    if (splitAt <= 0 || splitAt >= m.length - 1) continue
    const group = m.slice(0, splitAt)
    if (reserved.has(group)) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push({
      kind: "method",
      member: m.slice(splitAt + 1),
      method: m,
      structured: structured.has(group),
    })
  }
  for (const it of rules.iterators) {
    if (reserved.has(it.group) || !bridgeMethods.includes(it.nextMethod)) continue
    if (!groups.has(it.group)) groups.set(it.group, [])
    groups.get(it.group)!.push({ kind: "iterator", member: it.member, nextMethod: it.nextMethod })
  }
  for (const [source, alias] of rules.groupAliases) {
    if (groups.has(source) && !groups.has(alias)) groups.set(alias, groups.get(source)!.slice())
  }
  return {
    flat: bridgeMethods.filter((m) => !hidden.has(m)),
    groups: Array.from(groups.entries()),
  }
}

// ---------------------------------------------------------------------------
// QuickJS source
// ---------------------------------------------------------------------------

const WRAP_HELPER = `function __wrap(fn) {
  return async function() {
    var args = Array.prototype.slice.call(arguments);
    var sdkShape = false;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a === null || a === undefined) continue;
      var t = typeof a;
      if (t !== "string" && t !== "number" && t !== "boolean") { sdkShape = true; break; }
    }
    if (!sdkShape) {
      return await fn.apply(null, args);
    }
    var marshalled = args.map(function(a) {
      if (a === null || a === undefined) return a;
      var t = typeof a;
      if (t === "string" || t === "number" || t === "boolean") return a;
      return JSON.stringify(a);
    });
    var result = await fn.apply(null, marshalled);
    if (typeof result === "string") {
      try { return JSON.parse(result); } catch (e) { return result; }
    }
    return result;
  };
}
function __wrapStructured(fn) {
  return async function() {
    var args = Array.prototype.slice.call(arguments);
    var marshalled = args.map(function(a) {
      if (a === null || a === undefined) return a;
      var t = typeof a;
      if (t === "string" || t === "number" || t === "boolean") return a;
      return JSON.stringify(a);
    });
    var result = await fn.apply(null, marshalled);
    if (typeof result === "string") {
      try { return JSON.parse(result); } catch (e) { return result; }
    }
    return result;
  };
}
function __jsonlIterator(next) {
  return async function* (blobId, opts) {
    var batchSize = opts !== null && opts !== undefined && typeof opts === "object" ? opts.batchSize : undefined;
    while (true) {
      var page = await next(blobId, batchSize);
      if (page !== null && typeof page === "object" && page.error) {
        var err = new Error(String((page.error && page.error.message) || "bulk iteration failed"));
        if (page.error.code !== undefined) err.code = page.error.code;
        throw err;
      }
      if (page === null || typeof page !== "object" || page.done || !Array.isArray(page.batch)) return;
      yield page.batch;
    }
  };
}`

/**
 * QuickJS source defining `var __ctx`. Requires a global `__bridge_<m>` per
 * method in `bridgeMethods`. `rules` is overridable for tests only.
 */
export function buildCtxShimSource(
  opts: { bridgeMethods: readonly string[]; approval: unknown },
  rules: ShimRules = SHIM_RULES,
): string {
  const plan = planShim(opts.bridgeMethods, rules)
  const memberSource = (p: MemberPlan): string =>
    p.kind === "method"
      ? `${p.member}: ${p.structured ? "__wrapStructured" : "__wrap"}(__bridge_${p.method})`
      : `${p.member}: __jsonlIterator(__wrapStructured(__bridge_${p.nextMethod}))`
  const props = [
    `approval: ${JSON.stringify(opts.approval ?? null)}`,
    ...plan.flat.map((m) => `${m}: __wrap(__bridge_${m})`),
    ...plan.groups.map(
      ([group, members]) => `${group}: { ${members.map(memberSource).join(", ")} }`,
    ),
  ].join(",\n    ")
  return `${WRAP_HELPER}\nvar __ctx = {\n    ${props}\n  };`
}

// ---------------------------------------------------------------------------
// V8 (native) ctx
// ---------------------------------------------------------------------------

/**
 * One bridge call: resolves with the method's data, or rejects with an error
 * whose `message` (and, for a typed refusal, numeric `status` 4xx/5xx and
 * string `code`) is what the host sent (`{error, errorStatus?, errorCode?}`).
 */
export type CtxDispatch = (method: string, args: unknown[]) => Promise<unknown>

type BridgeFn = (...args: unknown[]) => Promise<unknown>

function isPrimitive(a: unknown): boolean {
  const t = typeof a
  return t === "string" || t === "number" || t === "boolean"
}

function marshal(args: unknown[]): unknown[] {
  return args.map((a) => (a === null || a === undefined || isPrimitive(a) ? a : JSON.stringify(a)))
}

function parseLoose(result: unknown): unknown {
  if (typeof result !== "string") return result
  try {
    return JSON.parse(result)
  } catch {
    return result
  }
}

function wrapRaw(fn: BridgeFn): BridgeFn {
  return async (...args) => {
    const sdkShape = args.some((a) => a !== null && a !== undefined && !isPrimitive(a))
    if (!sdkShape) return await fn(...args)
    return parseLoose(await fn(...marshal(args)))
  }
}

function wrapStructured(fn: BridgeFn): BridgeFn {
  return async (...args) => parseLoose(await fn(...marshal(args)))
}

function jsonlIterator(next: BridgeFn) {
  return async function* (blobId: unknown, opts?: unknown): AsyncGenerator<unknown[], void> {
    const batchSize =
      opts !== null && opts !== undefined && typeof opts === "object"
        ? (opts as { batchSize?: unknown }).batchSize
        : undefined
    while (true) {
      const page = (await next(blobId, batchSize)) as
        | { error?: { message?: unknown; code?: unknown }; done?: unknown; batch?: unknown }
        | null
        | undefined
      if (page !== null && typeof page === "object" && page.error) {
        const err = new Error(String(page.error?.message || "bulk iteration failed")) as Error & {
          code?: unknown
        }
        if (page.error.code !== undefined) err.code = page.error.code
        throw err
      }
      if (page === null || typeof page !== "object" || page.done || !Array.isArray(page.batch))
        return
      yield page.batch as unknown[]
    }
  }
}

/**
 * What a failed bridge call rejects with inside the handler, as in the
 * subprocess (bridge-rejection.ts newBridgeRejection): the plain message
 * string for a statusless failure, an Error with `status` (and `code`) for a
 * typed refusal.
 */
function bridgeRejection(err: unknown): unknown {
  const e = err as { message?: unknown } | null | undefined
  const message = String(e !== null && typeof e === "object" && "message" in e ? e.message : err)
  const typed = typedBridgeFailure(err)
  if (!typed) return message
  const out = new Error(message) as Error & { status?: number; code?: string }
  out.status = typed.status
  if (typed.code !== undefined) out.code = typed.code
  return out
}

/**
 * The handler's `ctx` for an isolate, with the subprocess shim's exact
 * semantics. Every method (the "sync" getters included) is an async call to
 * `dispatch`. A method's `undefined` data resolves as `null`, like the
 * subprocess (which round-trips data through JSON). `rules` is overridable
 * for tests only.
 */
export function createCtx(
  bridgeMethods: readonly string[],
  approval: unknown,
  dispatch: CtxDispatch,
  rules: ShimRules = SHIM_RULES,
): Record<string, unknown> {
  const plan = planShim(bridgeMethods, rules)
  const bridge = (method: string): BridgeFn => {
    return async (...args) => {
      let data: unknown
      try {
        data = await dispatch(method, args)
      } catch (err) {
        throw bridgeRejection(err)
      }
      return data === undefined ? null : data
    }
  }
  const ctx: Record<string, unknown> = {
    approval: JSON.parse(JSON.stringify(approval ?? null)),
  }
  for (const m of plan.flat) ctx[m] = wrapRaw(bridge(m))
  for (const [group, members] of plan.groups) {
    const obj: Record<string, unknown> = {}
    for (const p of members) {
      obj[p.member] =
        p.kind === "method"
          ? (p.structured ? wrapStructured : wrapRaw)(bridge(p.method))
          : jsonlIterator(wrapStructured(bridge(p.nextMethod)))
    }
    ctx[group] = obj
  }
  return ctx
}
