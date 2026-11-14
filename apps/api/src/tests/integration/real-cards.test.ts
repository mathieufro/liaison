// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cards the first-party apps declare, drawn from what their tools really return. Each tool
// runs on a seeded row through the real handler (executeToolCore), and the template registered
// for it resolves the result it gave. A hand-made shape would pass while the handler's own output
// differed from the card's paths, which is the failure this file exists to catch.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { dictionariesFor } from "@liaison/shared"
import type { UserContext } from "~/db/rls"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { resolveToolCard } from "~/modules/apps/result-card"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedContext } from "~/seed/context"
import { seedProject } from "~/seed/factories/projects/projects"
import { createOneTicket } from "~/seed/factories/support/ticket"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Template = NonNullable<Parameters<typeof resolveToolCard>[0]>

let orgId: string
let userId: string
let actor: UserContext
let ticketId: string

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  actor = a.actor
  await ensureAppsForOrg(orgId)
  const ctx = seedContext({ orgId, now: new Date() })
  const ticket = await createOneTicket(ctx, {
    key: "real-card",
    adminUserId: userId,
    subject: "Where is my order?",
    assignedTo: userId,
  })
  ticketId = ticket.id
  await seedProject(ctx, actor, {
    people: { me: { userId } },
    externalRefOf: (taskKey) => `real-card-${taskKey}`,
    spec: {
      key: "RC",
      name: "Launch plan",
      description: "The launch",
      icon: "rocket",
      owner: "me",
      tasks: [{ key: "t1", title: "Write the outline", status: "todo", assignee: "me" }],
    },
  })
})

afterAll(async () => {
  await shutdownSandboxPool()
  await releaseTestLock()
})

/** Runs the tool as the agent would, returns the template registered for it and its real result. */
async function run(app: string, tool: string, params: Record<string, unknown>) {
  const envelope = await executeToolCore({
    toolName: `${app}:${tool}`,
    orgId,
    actor,
    params,
    origin: "in-app-agent",
  })
  if ("error" in envelope) throw new Error(`${app}:${tool} failed: ${envelope.error.message}`)
  if ("blocked" in envelope) throw new Error(`${app}:${tool} was held for an approval`)
  const template = toolRegistry.get([orgId, app, tool])?.resultCard as Template | undefined
  expect(template, `${app}:${tool} registers a resultCard`).toBeDefined()
  return { template: template as Template, data: envelope.data }
}

describe("real tool results draw the declared cards", () => {
  it("tickets:get, called on a seeded ticket, resolves to an entity card", async () => {
    const { template, data } = await run("tickets", "get", { ticketId })
    const card = resolveToolCard(template, data)
    expect(card).not.toBeNull()
    expect(card?.kind).toBe("entity")
    expect(card?.title).toBe("Where is my order?")
    expect(card?.ref).toMatch(/^ticket-/)
    expect(card?.open).toEqual({ view: "ticket", id: ticketId })
    expect(card?.status?.label.labelKey).toBe("tickets.card.statusOpen")
    const labels = (card?.rows ?? []).map((r) => r.label.labelKey)
    expect(labels).toContain("tickets.card.assignee")
    expect(labels).toContain("tickets.card.messages")
  })

  it("projects:search, called with a task's words, resolves to a list card naming the task", async () => {
    const { template, data } = await run("projects", "search", { query: "outline" })
    const card = resolveToolCard(template, data)
    expect(card).not.toBeNull()
    expect(card?.kind).toBe("list")
    expect(card?.items).toEqual([{ label: "RC-1", meta: "Write the outline" }])
  })

  it("projects:search, called with a project's name, also resolves to a card", async () => {
    const { template, data } = await run("projects", "search", { query: "Launch plan" })
    const card = resolveToolCard(template, data)
    expect(card).not.toBeNull()
    expect(card?.items?.map((i) => i.label)).toContain("RC")
  })

  it("tickets:backlogHealth, called on a desk with one open ticket, resolves to a number card of 1", async () => {
    const { template, data } = await run("tickets", "backlogHealth", {})
    const card = resolveToolCard(template, data)
    expect(card).not.toBeNull()
    expect(card?.kind).toBe("number")
    expect(card?.value).toEqual({ t: "number", n: 1 })
    expect(card?.how?.labelKey).toBe("tickets.card.backlogHow")
    expect(card?.source).toBe("Tickets")
  })

  it("every catalog key those tools name exists in English and in French", () => {
    const keys = new Set<string>()
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (typeof node !== "object" || node === null) return
      for (const [k, v] of Object.entries(node)) {
        if (k === "labelKey" && typeof v === "string") keys.add(v)
        else walk(v)
      }
    }
    for (const [app, tool] of [
      ["tickets", "get"],
      ["tickets", "backlogHealth"],
      ["projects", "search"],
    ] as const) {
      const def = toolRegistry.get([orgId, app, tool])
      walk(def?.resultCard)
      if (def?.runningLabelKey) keys.add(def.runningLabelKey)
    }
    expect(keys.size).toBeGreaterThan(10)
    for (const locale of ["en", "fr"] as const) {
      const dicts = dictionariesFor(locale)
      for (const key of keys) {
        const [ns, ...path] = key.split(".")
        let cur: unknown = dicts[ns as string]
        for (const part of path) cur = (cur as Record<string, unknown> | undefined)?.[part]
        expect(typeof cur, `${locale} has ${key}`).toBe("string")
      }
    }
  })
})
