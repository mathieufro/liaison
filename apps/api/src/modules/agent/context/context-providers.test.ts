// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CONTEXT PROVIDERS under real row security. The example app declares one on
// its items (`contextProviders`, tool `item_context`), the fixture a real turn
// reads. A second organization carries in-memory fixture providers for what the
// example cannot show: a spy, a slow one, a writer, exact byte sizes.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import * as rls from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { assembleContext } from "~/modules/agent/context/context"
import {
  CONTEXT_PROVIDER_MAX_BYTES,
  type ContextProviderInput,
  loadContextProviderBlocks,
} from "~/modules/agent/context/context-providers"
import * as customerContext from "~/modules/agent/context/customer-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import * as executeTool from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { openEntityDiscussion } from "~/modules/threads/entity-discussion"
import { insertAppRow } from "~/seed/factories/app-tables"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const THREAD_SCOPES = ["kernel:threads:read", "kernel:threads:write", "kernel:contacts:read"]
const SEES_ITEMS = [...THREAD_SCOPES, "example:items:read"]
const FIX = "ctxfix"
const FIX_SCOPE = `${FIX}:read`
const FENCE = /<external-content source="untrusted">\n([\s\S]*?)\n<\/external-content>/g

let orgA: string
let alice: string
let orgB: string
let bob: string
const answers: Record<string, unknown> = {}

const actorIn = (orgId: string, userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId,
  scopes,
  dimensionGrants: { "*": ["*"] },
})

async function item(org: string, text: string): Promise<string> {
  const id = crypto.randomUUID()
  await withPrivilegedDb(org, "test-example-item", (tx) =>
    insertAppRow(tx, "example", "items", { id, org_id: org, text }),
  )
  return id
}

async function itemCount(org: string): Promise<number> {
  const s = drizzleSql.raw(`"${schemaRef("app_example")}"`)
  const [row] = await withPrivilegedDb(org, "test-count-items", async (tx) =>
    extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM ${s}.items WHERE org_id = ${org}::uuid`,
      ),
    ),
  )
  return row?.n ?? 0
}

async function threadTainted(org: string, threadId: string): Promise<boolean> {
  const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)
  const [row] = await withPrivilegedDb(org, "test-thread-taint", async (tx) =>
    extractRows<{ tainted: boolean }>(
      await tx.execute(drizzleSql`SELECT tainted FROM ${ks}.threads WHERE id = ${threadId}::uuid`),
    ),
  )
  return row?.tainted === true
}

/** Dispatches of a fixture tool while `fn` runs (the tool call itself, before any handler). */
async function dispatchesOf<T>(tool: string, fn: () => Promise<T>): Promise<[number, T]> {
  const spy = spyOn(executeTool, "executeToolCore")
  try {
    const out = await fn()
    const n = spy.mock.calls.filter(([opts]) => opts.toolName === `${FIX}:${tool}`).length
    return [n, out]
  } finally {
    spy.mockRestore()
  }
}

/** Every string the assembled context carries (system parts and the runtime tail). */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("\n")
  if (value && typeof value === "object") return Object.values(value).map(textOf).join("\n")
  return ""
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fixture provider tool in org B: answers `answers[name]`, after `delayMs`. */
function fixtureTool(name: string, delayMs = 0) {
  toolRegistry.set([orgB, FIX, name], {
    appName: FIX,
    name,
    description: "Fixture context provider.",
    requiredScopes: [FIX_SCOPE],
    readOnly: true,
    params: z.object({ subject: z.object({}).passthrough() }),
    handler: async () => {
      if (delayMs > 0) await sleep(delayMs)
      return answers[name] ?? { lines: [`${name} line`], source: { label: `${name} source` } }
    },
  })
}

function declareFixtures(tools: string[]) {
  appBridgeManifestRegistry.set([orgB, FIX], {
    name: FIX,
    contextProviders: tools.map((tool) => ({ on: ["example:items"], tool, scope: FIX_SCOPE })),
  })
}

const fenced = (block: string | undefined): string[] =>
  [...(block ?? "").matchAll(FENCE)].map((m) => m[1] ?? "")

const inB = (
  entityId: string,
  over: Partial<ContextProviderInput> = {},
): Promise<Awaited<ReturnType<typeof loadContextProviderBlocks>>> =>
  loadContextProviderBlocks({
    orgId: orgB,
    actor: actorIn(orgB, bob, [...SEES_ITEMS, FIX_SCOPE]),
    grants: [...SEES_ITEMS, FIX_SCOPE],
    currentView: { tabType: "example:items", entityId },
    ...over,
  })

describe("context providers", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgA = (await createTestOrg()).id
    await ensureAppsForOrg(orgA)
    alice = (await minimal.person(orgA, { name: "Alice Context" })).id
    orgB = (await minimal.secondOrg({ name: "Fixture Providers" })).orgId
    await ensureAppsForOrg(orgB)
    bob = (await minimal.person(orgB, { name: "Bob Context" })).id
    // Org B: only the fixtures provide, so their lines and sizes are the whole block.
    const example = appBridgeManifestRegistry.get([orgB, "example"])
    if (example)
      appBridgeManifestRegistry.set([orgB, "example"], { ...example, contextProviders: [] })
  }, 180_000)
  afterAll(async () => {
    await releaseTestLock()
  })

  test("one fenced block, turn tainted, scope recorded", async () => {
    const itemId = await item(orgA, "Gasket batch 7")
    const threadId = await minimal.thread(orgA, alice)
    const acc = createTurnScopeAccumulator({ orgId: orgA })
    const result = await assembleContext({
      threadId,
      orgId: orgA,
      actor: actorIn(orgA, alice, SEES_ITEMS),
      currentView: { tabType: "example:items", entityId: itemId },
      turnScopeAccumulator: acc,
    })
    const text = textOf(result)
    expect(text.split("From Example items (app example)")).toHaveLength(2)
    const body = fenced(text).find((b) => b.includes("Item text:"))
    expect(body).toContain("Item text: Gasket batch 7")
    expect(acc.snapshot()).toContain("example:items:read")
    expect(await threadTainted(orgA, threadId)).toBe(true)
  })

  test("no scope, no call", async () => {
    fixtureTool("spy")
    declareFixtures(["spy"])
    const itemId = await item(orgB, "Spied item")
    const [none, out] = await dispatchesOf("spy", () => inB(itemId, { grants: SEES_ITEMS }))
    expect(out).toBeNull()
    expect(none).toBe(0)
    // The same view with the scope calls it once: the spy is wired.
    const [once, withScope] = await dispatchesOf("spy", () => inB(itemId))
    expect(once).toBe(1)
    expect(fenced(withScope?.block)).toEqual(["spy line"])
  })

  test("agent ceiling lacks it, no call", async () => {
    fixtureTool("spy")
    declareFixtures(["spy"])
    const itemId = await item(orgB, "Ceiling item")
    const threadId = await minimal.thread(orgB, bob)
    // The person holds the scope; the turn's effective scope (the agent's ceiling) does not.
    const [n, result] = await dispatchesOf("spy", () =>
      assembleContext({
        threadId,
        orgId: orgB,
        actor: actorIn(orgB, bob, [...SEES_ITEMS, FIX_SCOPE]),
        currentView: { tabType: "example:items", entityId: itemId },
        effectiveScope: SEES_ITEMS,
      }),
    )
    expect(n).toBe(0)
    expect(textOf(result)).not.toContain("spy line")
  })

  test("entity hidden, no call", async () => {
    fixtureTool("spy")
    declareFixtures(["spy"])
    // Another organization's item: the actor's row security reads nothing.
    const foreign = await item(orgA, "Not org B's")
    const [n, out] = await dispatchesOf("spy", () => inB(foreign))
    expect(out).toBeNull()
    expect(n).toBe(0)
  })

  test("a provider whose tool requires two scopes stamps the turn with both", async () => {
    const second = `${FIX}:notes:read`
    fixtureTool("two_scopes")
    const tool = toolRegistry.get([orgB, FIX, "two_scopes"])
    if (!tool) throw new Error("fixture tool missing")
    toolRegistry.set([orgB, FIX, "two_scopes"], { ...tool, requiredScopes: [FIX_SCOPE, second] })
    declareFixtures(["two_scopes"])
    const itemId = await item(orgB, "Two scope item")
    const grants = [...SEES_ITEMS, FIX_SCOPE, second]
    const out = await inB(itemId, { actor: actorIn(orgB, bob, grants), grants })
    expect(fenced(out?.block)).toEqual(["two_scopes line"])
    expect([...(out?.scopes ?? [])].sort()).toEqual([second, FIX_SCOPE].sort())
  })

  test("a write through its bridge refused, line left out, turn continues", async () => {
    // A tool that claims to be read-only and writes anyway, through the sandbox bridge.
    const create = toolRegistry.get([orgB, "example", "items_create"])
    expect(create).toBeDefined()
    toolRegistry.set([orgB, "example", "item_context_writes"], {
      ...create!,
      name: "item_context_writes",
      requiredScopes: ["example:items:read"],
      readOnly: true,
      writesToTable: undefined,
      params: {
        type: "object",
        properties: {
          subject: { type: "object" },
          text: { type: "string", default: "Written by a provider" },
        },
        required: ["subject"],
      },
    })
    const example = appBridgeManifestRegistry.get([orgB, "example"])!
    appBridgeManifestRegistry.set([orgB, "example"], {
      ...example,
      contextProviders: [
        { on: ["example:items"], tool: "item_context_writes", scope: "example:items:read" },
      ],
    })
    fixtureTool("spy")
    declareFixtures(["spy"])
    try {
      const itemId = await item(orgB, "Writer item")
      const before = await itemCount(orgB)
      const spy = spyOn(executeTool, "executeToolCore")
      let out: Awaited<ReturnType<typeof inB>>
      let refused: unknown
      try {
        // The person may write items; the provider's run may not.
        const writer = [...SEES_ITEMS, FIX_SCOPE, "example:items:write"]
        out = await inB(itemId, { actor: actorIn(orgB, bob, writer), grants: writer })
        const at = spy.mock.calls.findIndex(([o]) => o.toolName === "example:item_context_writes")
        refused = await spy.mock.results[at]?.value
      } finally {
        spy.mockRestore()
      }
      expect(JSON.stringify(refused)).toContain("E_READ_ONLY_RUN_BLOCKED")
      expect(await itemCount(orgB)).toBe(before)
      expect(fenced(out?.block)).toEqual(["spy line"])
      expect(out?.scopes).toEqual([FIX_SCOPE])
    } finally {
      appBridgeManifestRegistry.set([orgB, "example"], { ...example, contextProviders: [] })
    }
  })

  test("three providers, one sleeping 5 s: returns by 1.6 s with the two fast lines", async () => {
    fixtureTool("fast_a")
    fixtureTool("sleepy", 5_000)
    fixtureTool("fast_b", 200)
    declareFixtures(["fast_a", "sleepy", "fast_b"])
    const itemId = await item(orgB, "Deadline item")
    const started = performance.now()
    const out = await inB(itemId)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1_600)
    expect(elapsed).toBeGreaterThanOrEqual(1_490)
    expect(fenced(out?.block)).toEqual(["fast_a line", "fast_b line"])
  }, 15_000)

  test("with an API connector its block runs under the same wall clock", async () => {
    fixtureTool("slowish", 1_300)
    declareFixtures(["slowish"])
    const itemId = await item(orgB, "Concurrent item")
    const threadId = await minimal.thread(orgB, bob)
    const customer = spyOn(customerContext, "loadCustomerContextBlock").mockImplementation(
      async () => {
        await sleep(1_400)
        return "Customer record from Fixture CRM."
      },
    )
    try {
      const started = performance.now()
      const result = await assembleContext({
        threadId,
        orgId: orgB,
        actor: actorIn(orgB, bob, [...SEES_ITEMS, FIX_SCOPE]),
        currentView: { tabType: "example:items", entityId: itemId },
      })
      const elapsed = performance.now() - started
      const text = textOf(result)
      expect(text).toContain("slowish line")
      expect(text).toContain("Customer record from Fixture CRM.")
      // One after the other would take at least 1.4 s + 1.3 s.
      expect(elapsed).toBeLessThan(2_700)
    } finally {
      customer.mockRestore()
    }
  }, 15_000)

  test("2048 bytes exactly, UTF-8 boundary, manifest order", async () => {
    fixtureTool("first")
    fixtureTool("second")
    declareFixtures(["first", "second"])
    const itemId = await item(orgB, "Byte item")
    const bytes = (s: string) => new TextEncoder().encode(s).byteLength
    expect(CONTEXT_PROVIDER_MAX_BYTES).toBe(2048)

    // Exactly 2048 bytes from the first provider: kept whole, nothing left for the second.
    answers.first = { lines: ["é".repeat(1024)], source: { label: "First" } }
    answers.second = { lines: ["second line"], source: { label: "Second" } }
    let parts = fenced((await inB(itemId))?.block)
    expect(parts).toEqual(["é".repeat(1024)])

    // 2047 bytes: kept whole; the one byte left cannot hold the second provider's clip.
    answers.first = { lines: [`a${"é".repeat(1023)}`], source: { label: "First" } }
    parts = fenced((await inB(itemId))?.block)
    expect(parts).toEqual([`a${"é".repeat(1023)}`])

    // 2049 bytes: clipped on a character boundary, within 2048.
    answers.first = { lines: [`a${"é".repeat(1024)}`], source: { label: "First" } }
    parts = fenced((await inB(itemId))?.block)
    expect(parts).toHaveLength(1)
    expect(bytes(parts[0]!)).toBeLessThanOrEqual(2048)
    expect(parts[0]!.endsWith("…")).toBe(true)
    expect(parts[0]!).not.toContain("�")
    expect(parts[0]!.slice(0, -1)).toBe(`a${"é".repeat(1022)}`)

    // Manifest order: the first provider's text first, the second clipped to what is left.
    answers.first = { lines: ["x".repeat(2000)], source: { label: "First" } }
    answers.second = { lines: ["y".repeat(100)], source: { label: "Second" } }
    parts = fenced((await inB(itemId))?.block)
    expect(parts[0]).toBe("x".repeat(2000))
    expect(parts[1]).toBe(`${"y".repeat(45)}…`)
    expect(bytes(parts.join(""))).toBe(2048)
    delete answers.first
    delete answers.second
  })

  test("a 50 KB answer keeps its first 10 lines within 2 KB", async () => {
    fixtureTool("huge")
    declareFixtures(["huge"])
    answers.huge = {
      // 2500 lines of 20 bytes.
      lines: Array.from(
        { length: 2500 },
        (_, i) => `${String(i).padStart(4, "0")}:${"z".repeat(15)}`,
      ),
      source: { label: "Huge" },
    }
    const parts = fenced((await inB(await item(orgB, "Huge item")))?.block)
    expect(parts).toHaveLength(1)
    expect(new TextEncoder().encode(parts[0]!).byteLength).toBeLessThanOrEqual(2048)
    expect(parts[0]!.split("\n")).toHaveLength(10)
    expect(parts[0]!.split("\n")[9]).toBe(`0009:${"z".repeat(15)}`)
    delete answers.huge
  })

  test("thread origin with no view runs on the origin", async () => {
    const itemId = await item(orgA, "Discussed item")
    const actor = actorIn(orgA, alice, SEES_ITEMS)
    const opened = await rls.withRlsContext(actor, (tx) =>
      openEntityDiscussion(tx, {
        orgId: orgA,
        userId: alice,
        ref: { app: "example", entityType: "items", entityId: itemId },
      }),
    )
    const result = await assembleContext({ threadId: opened!.threadId, orgId: orgA, actor })
    const text = textOf(result)
    expect(text).toContain(`about example:items ${itemId}`)
    expect(text).toContain("Item text: Discussed item")
  })

  test("view and origin on one entity runs once", async () => {
    fixtureTool("spy")
    declareFixtures(["spy"])
    const itemId = await item(orgB, "Same item")
    const [n, out] = await dispatchesOf("spy", () =>
      inB(itemId, { createdFrom: { app: "example", entityType: "items", entityId: itemId } }),
    )
    expect(n).toBe(1)
    expect(fenced(out?.block)).toEqual(["spy line"])
  })

  test("an org with no provider runs no extra query", async () => {
    const { orgId } = await minimal.secondOrg({ name: "No Providers" })
    await ensureAppsForOrg(orgId)
    for (const [key, manifest] of appBridgeManifestRegistry.entriesOf(orgId)) {
      if (manifest.contextProviders) {
        appBridgeManifestRegistry.set(key, { ...manifest, contextProviders: undefined })
      }
    }
    const userId = (await minimal.person(orgId, { name: "Nobody Provides" })).id
    const itemId = await item(orgId, "Plain item")
    const rlsReads = spyOn(rls, "withRlsContext")
    const privileged = spyOn(await import("~/db/privileged"), "withPrivilegedDb")
    const dispatch = spyOn(executeTool, "executeToolCore")
    try {
      const out = await loadContextProviderBlocks({
        orgId,
        actor: actorIn(orgId, userId, SEES_ITEMS),
        grants: ["*"],
        currentView: { tabType: "example:items", entityId: itemId },
        createdFrom: { app: "example", entityType: "items", entityId: crypto.randomUUID() },
      })
      expect(out).toBeNull()
      expect(rlsReads).toHaveBeenCalledTimes(0)
      expect(privileged).toHaveBeenCalledTimes(0)
      expect(dispatch).toHaveBeenCalledTimes(0)
    } finally {
      rlsReads.mockRestore()
      privileged.mockRestore()
      dispatch.mockRestore()
    }
  })
})
