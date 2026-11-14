// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the tool ladder costs, measured with no server, database or env: for a world (the apps that are on, the scopes held, the client surface)
// the deferred-tool announcement the real builder writes, the tools listed, the
// summary lines, and each app's schema total through the product's own meter.
// App tools are read from their manifests; the tools the host adds (the
// kernel's, bulk tools, host tools) are the registry entries the host's own
// registrations build, so every tool is measured as the provider is sent it.
// The numbers are TARGETS. A number over its target needs a line in
// `ladder-budget.reasons.json` naming the capability that needs it; nothing here
// forbids a tool, and nothing here edits a description.
//
// The guard test and the wrapper's world runner both call `measureLadder`.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import { isDeferredTool, providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import { loadManifests } from "../../../../../../scripts/docs/gen-reference"
import {
  normalizeAppGuide,
  parseGuideMarkdown,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "./app-guide"
import { estimateTokens } from "./compaction"
import {
  appInstructionSummary,
  buildDeferredToolsAnnouncement,
  composeTurnSystemText,
  estimateToolSchemaTokens,
  renderClientSurfaceLine,
} from "./context"

export const LADDER_REPO_ROOT = join(import.meta.dir, "../../../../../..")

/** Apps no org runs: the template app. */
const LEFT_OUT_APPS = new Set(["example"])

export interface LadderTool {
  app: string
  name: string
  sdkName: string
  description: string
  requiredScopes: string[]
  deferred: boolean
  agentVisible: boolean
  routineOnly: boolean
  /** Name, description and schema as the provider receives them, by `ceil(chars / 4)`. */
  wireTokens: number
  /** The app's one-line agent guide, for the summary line. */
  guide?: string
  /**
   * The app feature the tool belongs to. An org has every feature off until it
   * turns one on, and the turn, tool search and MCP leave such a tool out
   * (`isFeatureOffForTool`), so a world counts it only when it turns it on.
   */
  feature?: string
}

interface ManifestTool {
  description?: string
  agentVisible?: boolean
  deferLoading?: boolean
  contractOnly?: boolean
  routineOnly?: boolean
  requiredScopes?: string[]
  params?: unknown
  feature?: string
}

const sdkNameOf = (app: string, tool: string) => `${app}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

/** The org segment the host's registrations are built under to be measured: not a uuid. */
const MEASURE_ORG = "ladder-budget-measure"

interface RegistryTool {
  description?: string
  params?: unknown
  requiredScopes?: string[]
  deferLoading?: boolean
  agentVisible?: boolean
  routineOnly?: boolean
  feature?: string
}

/** One tool as the provider is sent it, measured by the product's meter. */
function ladderTool(app: string, name: string, def: RegistryTool, guide?: string): LadderTool {
  const sdkName = sdkNameOf(app, name)
  return {
    app,
    name,
    sdkName,
    description: def.description ?? "",
    requiredScopes: def.requiredScopes ?? [],
    deferred: isDeferredTool(app, def),
    agentVisible: def.agentVisible !== false,
    routineOnly: def.routineOnly === true,
    wireTokens: estimateToolSchemaTokens(sdkName, {
      description: def.description,
      inputSchema: providerInputSchemaOf(def.params),
    }),
    ...(guide ? { guide } : {}),
    ...(def.feature ? { feature: def.feature } : {}),
  }
}

/**
 * The tools the host registers beyond the app manifests' own: the kernel's
 * tools and bulk tools, and each app's bulk tools. The host's
 * own registrations run under a measuring org, their entries are read as the
 * registry holds them, then removed again.
 */
async function loadHostRegistryTools(
  manifests: ReturnType<typeof loadManifests>,
  guides: ReadonlyMap<string, string>,
): Promise<LadderTool[]> {
  // Imported here: the kernel's tools read the product's config when loaded, which
  // a caller may only settle (placeholder secrets) after this module is imported.
  const { KernelToolsTestAccess } = await import("~/modules/agent/tools/kernel-tools")
  const { registerKernelBulkApp } = await import("~/modules/apps/kernel-bulk")
  const { registerBulkAgentTools } = await import("~/modules/apps/bulk-agent-tools")
  const { toolRegistry } = await import("~/modules/apps/app-registries")
  const { deleteRegistryEntriesOfOrgs } = await import("~/modules/apps/registries")
  const out: LadderTool[] = []
  try {
    await KernelToolsTestAccess.buildWithoutTemplate(MEASURE_ORG)
    registerKernelBulkApp(MEASURE_ORG)
    for (const m of manifests) {
      const tools = m.manifest.tools as Record<string, RegistryTool> | undefined
      const bulk = m.manifest.bulk as Parameters<typeof registerBulkAgentTools>[0]["bulk"]
      if (bulk && tools)
        registerBulkAgentTools({
          orgId: MEASURE_ORG,
          appName: m.name,
          bulk,
          tools: tools as Parameters<typeof registerBulkAgentTools>[0]["tools"],
        })
    }
    for (const [key, value] of toolRegistry.entriesOf(MEASURE_ORG)) {
      const app = String(key[1])
      const tools = manifests.find((m) => m.name === app)?.manifest.tools as
        | Record<string, unknown>
        | undefined
      // A manifest tool is measured from its manifest, above.
      if (tools && String(key[2]) in tools) continue
      if (app !== "kernel" && !manifests.some((m) => m.name === app)) continue
      out.push(ladderTool(app, String(key[2]), value as RegistryTool, guides.get(app)))
    }
  } finally {
    deleteRegistryEntriesOfOrgs(new Set([MEASURE_ORG]))
  }
  return out
}

/** Every tool of every shipped app and of the kernel, as the registry holds them. */
export async function loadLadderTools(root: string = LADDER_REPO_ROOT): Promise<LadderTool[]> {
  const out: LadderTool[] = []
  const manifests = loadManifests(root).filter((m) => !LEFT_OUT_APPS.has(m.name))
  const guides = new Map<string, string>()
  for (const m of manifests) {
    const instructions = m.manifest.agentInstructions
    const guide = typeof instructions === "string" ? instructions : undefined
    if (guide) guides.set(m.name, guide)
    const tools = (m.manifest.tools ?? {}) as Record<string, ManifestTool>
    for (const [name, def] of Object.entries(tools)) {
      if (def.contractOnly) continue
      out.push(ladderTool(m.name, name, def, guide))
    }
  }
  out.push(...(await loadHostRegistryTools(manifests, guides)))
  return out.sort((a, b) => a.sdkName.localeCompare(b.sdkName))
}

export interface LadderWorld {
  name: string
  /** Apps that are on; absent means every app. */
  apps?: readonly string[]
  /** Scopes the turn holds. */
  scopes: readonly string[]
  surface?: "web" | "mobile" | "desktop"
  /** App features turned on, as `app:feature`; absent means none, as in a new org. */
  features?: readonly string[]
}

export interface LadderMeasure {
  world: string
  /** Tools the agent can see: hot and deferred. */
  visibleTools: number
  /** Tools the announcement lists. */
  announcedTools: number
  announcementTokens: number
  summaryLines: number
  summaryTokens: number
  /** Schema total per app over its visible tools, through the product's meter. */
  appSchemaTokens: Record<string, number>
  /** The client-surface line this world adds to the prompt tail. */
  surfaceLineTokens: number
}

/** The numbers a world is measured against. Targets, not caps. */
export interface LadderTargets {
  visibleTools?: number
  announcementTokens?: number
  /** Per app; an app absent here has no target of its own. */
  appSchemaTokens: Record<string, number>
}

/** Every measure of one world, through the real announcement builder and meter. */
export function measureLadder(tools: readonly LadderTool[], world: LadderWorld): LadderMeasure {
  const on = world.apps ? new Set(world.apps) : null
  const featuresOn = new Set(world.features ?? [])
  const usable = tools.filter(
    (t) =>
      t.agentVisible &&
      (!t.feature || featuresOn.has(`${t.app}:${t.feature}`)) &&
      (!on || on.has(t.app) || t.app === "kernel") &&
      checkToolScopes({ requiredScopes: t.requiredScopes }, [...world.scopes]).authorized,
  )
  const announced = usable.filter((t) => t.deferred || t.routineOnly)
  const announcement = buildDeferredToolsAnnouncement(
    announced.map((t) => ({ appName: t.app, toolName: t.name })),
  )
  const apps = [...new Set(usable.map((t) => t.app))].filter((a) => a !== "kernel")
  const summaries = apps.map((app) => {
    const guide = usable.find((t) => t.app === app)?.guide
    return `- **${app}**: ${guide ? appInstructionSummary(guide) : ""}`
  })
  const appSchemaTokens: Record<string, number> = {}
  for (const t of usable) appSchemaTokens[t.app] = (appSchemaTokens[t.app] ?? 0) + t.wireTokens
  return {
    world: world.name,
    visibleTools: usable.length,
    announcedTools: announced.length,
    announcementTokens: estimateTokens(announcement),
    summaryLines: summaries.length,
    summaryTokens: estimateTokens(summaries.join("\n")),
    appSchemaTokens,
    surfaceLineTokens: estimateTokens(renderClientSurfaceLine(world.surface)),
  }
}

export interface LadderReason {
  /** `<world>` or `<world>:<measure>` or `<world>:<app>`, as `overTarget` names it. */
  key: string
  /** The capability that needs the number to be over. */
  capability: string
}

export interface LadderOver {
  key: string
  measured: number
  target: number
}

/** Every number over its target, named so a reason line can clear it. */
export function overTarget(measure: LadderMeasure, targets: LadderTargets): LadderOver[] {
  const over: LadderOver[] = []
  const check = (key: string, measured: number, target: number | undefined) => {
    if (target !== undefined && measured > target)
      over.push({ key: `${measure.world}:${key}`, measured, target })
  }
  check("visibleTools", measure.visibleTools, targets.visibleTools)
  check("announcementTokens", measure.announcementTokens, targets.announcementTokens)
  for (const [app, tokens] of Object.entries(measure.appSchemaTokens)) {
    check(app, tokens, targets.appSchemaTokens[app])
  }
  return over
}

/** The numbers over target with no reason naming a capability. */
export function unexplained(
  over: readonly LadderOver[],
  reasons: readonly LadderReason[],
): LadderOver[] {
  const explained = new Set(reasons.filter((r) => r.capability.trim().length > 0).map((r) => r.key))
  return over.filter((o) => !explained.has(o.key))
}

export function readLadderReasons(file: string): LadderReason[] {
  return JSON.parse(readFileSync(file, "utf8")) as LadderReason[]
}

export interface StaticFixedPrompt {
  total: number
  /** Tokens per part, so a difference from the composed prompt can be traced. */
  parts: Record<string, number>
}

const PROMPTS_DIR = join(import.meta.dir, "../prompts")

/** A prompt file without its front matter. */
function promptBody(file: string): string {
  return readFileSync(join(PROMPTS_DIR, file), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "")
}

/**
 * The kernel guide as the prompt carries it: its core, and the sections about the kernel tools
 * that are loaded every turn (the hot ones); a section about a deferred tool arrives with it.
 */
function kernelGuideText(tools: readonly LadderTool[]): string {
  const hot = new Set(tools.filter((t) => t.app === "kernel" && !t.deferred).map((t) => t.sdkName))
  const guide = normalizeAppGuide(parseGuideMarkdown(promptBody("kernel/overview.md")))
  return renderAppGuideBlock("kernel", selectAppGuideParts("kernel", guide, hot))
}

/**
 * The fixed parts of the system prompt with every app on: the base
 * text, the charter and roster templates, the kernel guide, the summary lines
 * and the announcement. The integration case in `context.token-cap.test.ts`
 * composes the real prompt and holds this within 1,000 tokens of it.
 */
export async function staticFixedPromptTokens(
  tools?: readonly LadderTool[],
): Promise<StaticFixedPrompt> {
  tools ??= await loadLadderTools()
  const everyApp = measureLadder(tools, { name: "every app", scopes: ["*"] })
  const parts: Record<string, number> = {
    base: estimateTokens(composeTurnSystemText(promptBody("system.md"), "Organisation")),
    charter: estimateTokens(promptBody("agent-charter.md")),
    roster: estimateTokens(promptBody("agent-roster.md")),
    kernelGuide: estimateTokens(kernelGuideText(tools)),
    summaries: everyApp.summaryTokens,
    announcement: everyApp.announcementTokens,
  }
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts }
}

export interface LadderReport {
  /** Every number of every world, and every reason that clears one over target. */
  lines: string[]
  /** One message per number over target with no reason, naming it. */
  failures: string[]
}

/**
 * The report of a set of worlds against their targets. A number over its target
 * is a failure only until a reason line names the capability that needs it; the
 * lines print every number either way. No outcome here removes or hides a tool.
 */
export function ladderReport(
  measures: readonly LadderMeasure[],
  targets: Readonly<Record<string, LadderTargets>>,
  reasons: readonly LadderReason[],
): LadderReport {
  const lines: string[] = []
  const failures: string[] = []
  for (const m of measures) {
    lines.push(
      `${m.world}: ${m.visibleTools} visible tools, ${m.announcedTools} announced in ${m.announcementTokens} tokens, ` +
        `${m.summaryLines} summary lines in ${m.summaryTokens} tokens, surface line ${m.surfaceLineTokens} tokens`,
    )
    for (const [app, tokens] of Object.entries(m.appSchemaTokens).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const target = targets[m.world]?.appSchemaTokens[app]
      lines.push(
        `  ${app}: ${tokens} schema tokens${target === undefined ? "" : ` (target ${target})`}`,
      )
    }
    const target = targets[m.world]
    if (!target) continue
    for (const o of overTarget(m, target)) {
      const reason = reasons.find((r) => r.key === o.key && r.capability.trim().length > 0)
      if (reason)
        lines.push(
          `  OVER ${o.key}: ${o.measured} against ${o.target}; reason: ${reason.capability}`,
        )
      else {
        lines.push(`  OVER ${o.key}: ${o.measured} against ${o.target}; NO REASON`)
        failures.push(
          `${o.key} is ${o.measured} against a target of ${o.target}: add a line to ladder-budget.reasons.json naming the capability that needs it`,
        )
      }
    }
  }
  return { lines, failures }
}
