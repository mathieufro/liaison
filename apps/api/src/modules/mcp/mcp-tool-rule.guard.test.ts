// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The static half of the rule for tools a person calls from their own coding agent over MCP.
// The behaviour half (a gated call parks, no tool decides an approval, chat and MCP answer the
// same bytes, outside text marks the connection) runs on the real door in mcp-door-rule.test.ts.
//
// - Same answer: a tool that draws a card declares `returns.schema`, so every value the card shows
//   is in the result a terminal reads (checked for every manifest and kernel tool).
// - No client effect: a tool whose only effect is on the Liaison screen is hidden from the gateway.
// - Bounded: a listed read that takes a `limit` caps it at 200 rows.
// - Guide: a listed tool's description, the text a coding agent gets for it, is not empty.
//   (A tool's `instructions` key is carried by the registry but read by nothing, so the
//   description is what an MCP client is given.)
//
// The list holds the tools the current work adds or changes that a person may call from a
// terminal; a later tool joins it when it lands.
import { beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { KernelToolsTestAccess } from "~/modules/agent/tools/kernel-tools"
import { toolRegistry } from "~/modules/apps/app-registries"

const API_APPS = join(import.meta.dir, "..", "..", "apps")
const BUNDLED = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")
const KERNEL_ORG = "00000000-0000-0000-0000-0000000a2e01"
const MAX_PAGE = 200

/** The facts the rule reads off one tool, from a manifest or the kernel registry alike. */
export interface RuleTool {
  name: string
  description?: string
  readOnly?: boolean
  gatewayHidden?: boolean
  resultCard?: unknown
  returns?: { schema?: Record<string, string> }
  /** The JSON schema of the tool's params. */
  params?: { properties?: Record<string, { maximum?: number; type?: unknown }> }
}

export type Rule = "card-returns" | "screen-only" | "bounded" | "guide"

export function ruleProblems(tool: RuleTool, rules: ReadonlyArray<Rule>): string[] {
  const out: string[] = []
  for (const rule of rules) {
    if (rule === "card-returns" && tool.resultCard !== undefined && !tool.returns?.schema) {
      out.push(`${tool.name} draws a card but declares no returns.schema`)
    }
    if (rule === "screen-only" && tool.gatewayHidden !== true) {
      out.push(`${tool.name} acts on the Liaison screen only but is not gatewayHidden`)
    }
    if (rule === "bounded" && tool.readOnly === true) {
      const limit = tool.params?.properties?.limit
      if (
        limit !== undefined &&
        !(typeof limit.maximum === "number" && limit.maximum <= MAX_PAGE)
      ) {
        out.push(`${tool.name} takes a limit without a maximum of at most ${MAX_PAGE}`)
      }
    }
    if (rule === "guide" && (tool.description ?? "").trim().length === 0) {
      out.push(`${tool.name} has no description for a coding agent to read`)
    }
  }
  return out
}

function manifestTools(): RuleTool[] {
  const out: RuleTool[] = []
  for (const dir of [API_APPS, BUNDLED]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let manifest: { name: string; tools?: Record<string, Omit<RuleTool, "name">> }
      try {
        manifest = JSON.parse(readFileSync(join(dir, entry.name, "app.manifest.json"), "utf8"))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
        throw err
      }
      for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
        out.push({ ...tool, name: `${manifest.name}:${name}` })
      }
    }
  }
  return out
}

function kernelTools(): RuleTool[] {
  const out: RuleTool[] = []
  for (const [key, def] of toolRegistry.entriesOf(KERNEL_ORG)) {
    if (key[0] !== KERNEL_ORG) continue
    const params = def.params as unknown
    out.push({
      name: `${key[1]}:${key[2]}`,
      description: def.description,
      readOnly: def.readOnly,
      gatewayHidden: def.gatewayHidden,
      resultCard: def.resultCard,
      returns: def.returns,
      params:
        params instanceof z.ZodType
          ? (z.toJSONSchema(params, { unrepresentable: "any" }) as RuleTool["params"])
          : (params as RuleTool["params"]),
    })
  }
  return out
}

/** The tools of the current work a person may call from a terminal, with the rules each meets. */
const LISTED: Array<[string, Rule[]]> = [
  ["kernel:open_app", ["screen-only", "guide"]],
  ["kernel:suggest_next_steps", ["screen-only", "guide"]],
  ["kernel:set_away", ["guide"]],
  ["kernel:threads_create", ["guide"]],
  ["kernel:create_routine", ["guide"]],
  ["tickets:get", ["card-returns", "bounded", "guide"]],
  ["tickets:backlogHealth", ["card-returns", "bounded", "guide"]],
  ["projects:search", ["card-returns", "bounded", "guide"]],
]

describe("the static rule for tools called over MCP", () => {
  let all: Map<string, RuleTool>

  beforeAll(async () => {
    await KernelToolsTestAccess.buildWithoutTemplate(KERNEL_ORG)
    all = new Map([...manifestTools(), ...kernelTools()].map((t) => [t.name, t]))
  })

  it("every manifest and kernel tool that draws a card declares its returns", () => {
    expect([...all.values()].flatMap((t) => ruleProblems(t, ["card-returns"]))).toEqual([])
  })

  it("every listed tool exists and meets its rules", () => {
    const problems = LISTED.flatMap(([name, rules]) => {
      const tool = all.get(name)
      return tool ? ruleProblems(tool, rules) : [`${name} is listed but not registered`]
    })
    expect(problems).toEqual([])
  })

  it("a card on a tool missing returns fails naming it", () => {
    expect(
      ruleProblems({ name: "acme:show", resultCard: { kind: "entity" } }, ["card-returns"]),
    ).toEqual(["acme:show draws a card but declares no returns.schema"])
    expect(
      ruleProblems(
        {
          name: "acme:show",
          resultCard: { kind: "entity" },
          returns: { schema: { id: "string" } },
        },
        ["card-returns"],
      ),
    ).toEqual([])
  })

  it("a screen-only tool the gateway lists, an unbounded page and an empty description each fail", () => {
    expect(ruleProblems({ name: "acme:open", description: "Open" }, ["screen-only"])).toEqual([
      "acme:open acts on the Liaison screen only but is not gatewayHidden",
    ])
    const page = (maximum?: number): RuleTool => ({
      name: "acme:list",
      readOnly: true,
      params: { properties: { limit: { type: "integer", ...(maximum ? { maximum } : {}) } } },
    })
    expect(ruleProblems(page(), ["bounded"])).toHaveLength(1)
    expect(ruleProblems(page(201), ["bounded"])).toHaveLength(1)
    expect(ruleProblems(page(200), ["bounded"])).toEqual([])
    expect(ruleProblems({ name: "acme:list", description: "  " }, ["guide"])).toEqual([
      "acme:list has no description for a coding agent to read",
    ])
  })
})
