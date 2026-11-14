// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tool-finding bench (tool-bench/) ranks the corpus over a catalog it reads
// from source, with no server: each typed form's result is in its baseline.json.
// This file holds what needs registration itself: the catalog the bench reads
// is the one an org's registration builds (kernel and in-tree apps), and a
// manifest keyword reaches the registered tool.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { env } from "~/lib/env"
import { isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import { hiddenToolAliases, rankDeferredTools } from "~/modules/agent/tools/tool-rank"
import { registerAppBuilderTools } from "~/modules/app-builder/tools"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"
import { loadBenchCatalog, searchableTools } from "./tool-bench/catalog"
import corpus from "./tool-bench/corpus.json"

/** The apps of the catalog that declare an API connection (they connect systems no app covers). */
const CONNECTOR_APPS: ReadonlySet<string> = new Set(["api-connector"])

const BUNDLED_APPS = join(import.meta.dir, "../../../../../../bundled-apps")
const LEFT_OUT_APPS = new Set(["example", "contacts"])
const customApps = env.LIAISON_CUSTOM_APPS
const ACCENT = /[àâäéèêëîïôöùûüçœæ]/i

interface CatalogTool {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: readonly string[]
  aliases?: readonly string[]
}

const sdkNameOf = (app: string, tool: string) => `${app}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

function registeredTools(): CatalogTool[] {
  const out: CatalogTool[] = []
  const aliases = hiddenToolAliases(
    [...toolRegistry.entries()]
      .filter(([key]) => key[0] === ORG_ID)
      .map(([key, def]) => ({
        appName: key[1],
        toolName: key[2],
        agentVisible: def.agentVisible,
        useInstead: def.useInstead,
      })),
  )
  for (const [key, def] of toolRegistry.entries()) {
    if (key[0] !== ORG_ID || LEFT_OUT_APPS.has(key[1]) || key[1].startsWith("test")) continue
    if (def.agentVisible === false) continue
    if (!isDeferredTool(key[1], def) && !def.routineOnly) continue
    const sdkName = sdkNameOf(key[1], key[2])
    const names = aliases.get(sdkName)
    out.push({
      sdkName,
      toolName: key[2],
      appName: key[1],
      description: def.description,
      ...(def.searchKeywords?.length ? { keywords: def.searchKeywords } : {}),
      ...(names ? { aliases: names } : {}),
    })
  }
  return out
}

/** Bundled apps install from a package, so a test org has none: read their manifests. */
function bundledTools(): CatalogTool[] {
  const out: CatalogTool[] = []
  for (const dir of readdirSync(BUNDLED_APPS)) {
    let text: string
    try {
      text = readFileSync(join(BUNDLED_APPS, dir, "app.manifest.json"), "utf8")
    } catch {
      continue
    }
    const manifest = JSON.parse(text) as {
      name: string
      tools?: Record<
        string,
        {
          description?: string
          searchKeywords?: string[]
          agentVisible?: boolean
          deferLoading?: boolean
          contractOnly?: boolean
        }
      >
    }
    if (LEFT_OUT_APPS.has(manifest.name)) continue
    for (const [name, def] of Object.entries(manifest.tools ?? {})) {
      if (def.agentVisible === false || def.deferLoading === false || def.contractOnly) continue
      out.push({
        sdkName: sdkNameOf(manifest.name, name),
        toolName: name,
        appName: manifest.name,
        description: def.description ?? "",
        ...(def.searchKeywords?.length ? { keywords: def.searchKeywords } : {}),
      })
    }
  }
  return out
}

let ORG_ID = ""

describe("a tool is found by what people say", () => {
  let catalog: CatalogTool[] = []
  let appNames = new Set<string>()

  beforeAll(async () => {
    ORG_ID = (await createTestOrg()).id
    await ensureAppsForOrg(ORG_ID)
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)
    // The catalog read from source holds every kernel tool, the app builder's included: the org
    // gets them as an instance offering custom apps does, whatever this process registered first.
    env.LIAISON_CUSTOM_APPS = "on"
    registerAppBuilderTools(ORG_ID)
    catalog = [...registeredTools(), ...bundledTools()]
    appNames = new Set(catalog.map((t) => t.appName))
    appNames.delete("kernel")
  })

  afterAll(() => {
    env.LIAISON_CUSTOM_APPS = customApps
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
  })

  it("a manifest keyword is one word", () => {
    for (const tool of catalog) {
      if (tool.appName === "kernel") continue
      for (const word of tool.keywords ?? []) expect(word, tool.sdkName).toMatch(/^\S+$/)
    }
  })

  it("the catalog read from source is the one registration builds", () => {
    const registered = new Map(
      registeredTools().map((t) => [
        t.sdkName,
        { d: t.description, k: t.keywords ?? [], a: t.aliases ?? [] },
      ]),
    )
    const regApps = new Set([...registered.keys()].map((n) => n.split("__")[0]))
    const fromSource = new Map(
      searchableTools(loadBenchCatalog())
        .filter((t) => regApps.has(t.appName))
        .map((t) => [t.sdkName, { d: t.description, k: t.keywords ?? [], a: t.aliases ?? [] }]),
    )
    expect([...fromSource.keys()].sort()).toEqual([...registered.keys()].sort())
    for (const [name, def] of registered) expect(fromSource.get(name), name).toEqual(def)
  })

  it("a keyword declared in a manifest reaches the registered tool", () => {
    expect(toolRegistry.get([ORG_ID, "tickets", "close"])?.searchKeywords).toContain("fermer")
    expect(toolRegistry.get([ORG_ID, "kernel", "assign_role"])?.searchKeywords).toContain("rôle")
  })

  it("no keyword sits on so many tools that it stops telling them apart", () => {
    const toolsOfWord = new Map<string, string[]>()
    for (const tool of catalog) {
      for (const word of tool.keywords ?? []) {
        toolsOfWord.set(word, [...(toolsOfWord.get(word) ?? []), tool.sdkName])
      }
    }
    const crowded = [...toolsOfWord].filter(([, tools]) => tools.length > 25).map(([w]) => w)
    expect(crowded).toEqual([])
  })

  it("an accent typed or left out finds the same tools", () => {
    const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "")
    const names = (query: string) =>
      rankDeferredTools(catalog, query, {
        cap: 5,
        appNames,
        connectorApps: CONNECTOR_APPS,
      }).ranked.map((s) => s.tool.sdkName)
    for (const line of corpus) {
      for (const form of line.typed) {
        // Words under 3 letters are left as typed, by design ("à" is not "a").
        if (form.split(/\s+/).some((w) => w.length < 3 && ACCENT.test(w))) continue
        if (ACCENT.test(form)) expect(names(fold(form)), form).toEqual(names(form))
      }
    }
  })
})
