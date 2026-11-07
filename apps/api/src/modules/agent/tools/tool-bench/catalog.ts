// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tool catalog as the search sees it, read from source with no server,
 * database or env: every shipped app's manifest, plus the kernel tools found
 * in source by the reference generator. A test with a database checks that
 * this matches what registration builds (tool-search.corpus.test.ts).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { collectKernelTools, loadManifests } from "../../../../../../../scripts/docs/gen-reference"

export const REPO_ROOT = join(import.meta.dir, "../../../../../../..")

/** Apps no org runs: the template app and the contacts shim. */
export const LEFT_OUT_APPS = new Set(["example", "contacts"])

export interface BenchTool {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: readonly string[]
  /** `deferLoading` as declared, absent when the tool states none. */
  declaredDeferLoading?: boolean
  /** Announced and found by search, rather than loaded on every turn. */
  deferred: boolean
  agentVisible: boolean
  routineOnly: boolean
  /** Characters of the parameter schema (JSON for an app, source for a kernel tool). */
  schemaChars: number
}

export const sdkNameOf = (app: string, tool: string) =>
  `${app}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

interface ManifestTool {
  description?: string
  searchKeywords?: string[]
  agentVisible?: boolean
  deferLoading?: boolean
  contractOnly?: boolean
  routineOnly?: boolean
  params?: unknown
}

interface BulkDecl {
  label?: string
  agentTool?: string
  deferLoading?: boolean
}

/**
 * The agent tools a manifest's `bulk` section derives (bulk-agent-tools.ts):
 * one per `agentTool` name, "Bulk <label>" alone, "Bulk operations on <app>"
 * when several actions share the name.
 */
function bulkTools(appName: string, bulk: Record<string, BulkDecl>): BenchTool[] {
  const groups = new Map<string, BulkDecl[]>()
  for (const decl of Object.values(bulk)) {
    if (!decl.agentTool) continue
    groups.set(decl.agentTool, [...(groups.get(decl.agentTool) ?? []), decl])
  }
  return [...groups].map(([name, decls]) => {
    const single = decls.length === 1 ? decls[0] : undefined
    const deferLoading = single?.deferLoading === true ? true : undefined
    return {
      sdkName: sdkNameOf(appName, name),
      toolName: name,
      appName,
      description: single ? `Bulk ${single.label ?? ""}` : `Bulk operations on ${appName}`,
      ...(deferLoading ? { declaredDeferLoading: true } : {}),
      deferred: deferLoading ?? appName !== "kernel",
      agentVisible: true,
      routineOnly: false,
      schemaChars: 0,
    }
  })
}

/** The kernel's own bulk actions (`KERNEL_BULK` in kernel-bulk.ts), read from source. */
function kernelBulk(root: string): Record<string, BulkDecl> {
  const sf = ts.createSourceFile(
    "kernel-bulk.ts",
    readFileSync(join(root, "apps/api/src/modules/apps/kernel-bulk.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const out: Record<string, BulkDecl> = {}
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "KERNEL_BULK" &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      for (const p of n.initializer.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue
        out[p.name.getText(sf)] = literalProps(p.initializer) as BulkDecl
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

/** The string, boolean and string-array properties of an object literal. */
function literalProps(o: ts.ObjectLiteralExpression): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of o.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue
    const v = p.initializer
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) out[p.name.text] = v.text
    else if (v.kind === ts.SyntaxKind.TrueKeyword) out[p.name.text] = true
    else if (v.kind === ts.SyntaxKind.FalseKeyword) out[p.name.text] = false
    else if (ts.isArrayLiteralExpression(v) && v.elements.every(ts.isStringLiteral))
      out[p.name.text] = v.elements.map((e) => (e as ts.StringLiteral).text)
  }
  return out
}

/**
 * App tools an in-tree app registers in code rather than in its manifest: the
 * API connector's adapter writes (api-connector/authoring-tools.ts), each an
 * object literal with a `name`, spread over a `common` one.
 */
function codeRegisteredAppTools(root: string): BenchTool[] {
  const file = "apps/api/src/apps/api-connector/authoring-tools.ts"
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  )
  const objects: Record<string, unknown>[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) objects.push(literalProps(n))
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const common = objects.find((o) => o.appName === undefined && o.deferLoading !== undefined)
  return objects
    .filter((o) => typeof o.name === "string" && typeof o.description === "string")
    .map((o) => {
      const def = { ...common, ...o }
      const keywords = def.searchKeywords as string[] | undefined
      return {
        sdkName: sdkNameOf("api-connector", def.name as string),
        toolName: def.name as string,
        appName: "api-connector",
        description: def.description as string,
        ...(keywords?.length ? { keywords } : {}),
        ...(typeof def.deferLoading === "boolean"
          ? { declaredDeferLoading: def.deferLoading }
          : {}),
        deferred: def.deferLoading !== false,
        agentVisible: def.agentVisible !== false,
        routineOnly: false,
        schemaChars: 0,
      }
    })
}

/** Every tool of every shipped app and of the kernel, agent-visible or not. */
export function loadBenchCatalog(root: string = REPO_ROOT): BenchTool[] {
  const out: BenchTool[] = []
  for (const m of loadManifests(root)) {
    if (LEFT_OUT_APPS.has(m.name)) continue
    const tools = (m.manifest.tools ?? {}) as Record<string, ManifestTool>
    for (const [name, def] of Object.entries(tools)) {
      if (def.contractOnly) continue
      out.push({
        sdkName: sdkNameOf(m.name, name),
        toolName: name,
        appName: m.name,
        description: def.description ?? "",
        ...(def.searchKeywords?.length ? { keywords: def.searchKeywords } : {}),
        ...(def.deferLoading !== undefined ? { declaredDeferLoading: def.deferLoading } : {}),
        deferred: def.deferLoading ?? true,
        agentVisible: def.agentVisible !== false,
        routineOnly: def.routineOnly === true,
        schemaChars: def.params === undefined ? 0 : JSON.stringify(def.params).length,
      })
    }
    out.push(...bulkTools(m.name, (m.manifest.bulk ?? {}) as Record<string, BulkDecl>))
  }
  out.push(...codeRegisteredAppTools(root), ...bulkTools("kernel", kernelBulk(root)))
  for (const t of collectKernelTools(root).tools) {
    out.push({
      sdkName: sdkNameOf("kernel", t.name),
      toolName: t.name,
      appName: "kernel",
      description: t.fullDescription,
      ...(t.searchKeywords.length ? { keywords: t.searchKeywords } : {}),
      ...(t.deferLoading !== undefined ? { declaredDeferLoading: t.deferLoading } : {}),
      deferred: t.deferLoading ?? false,
      agentVisible: t.agentVisible,
      routineOnly: t.routineOnly,
      schemaChars: t.paramsChars,
    })
  }
  return out.sort((a, b) => a.sdkName.localeCompare(b.sdkName))
}

/** The tools `tool_search` ranks: agent-visible, and deferred or routine-only. */
export function searchableTools(catalog: readonly BenchTool[]): BenchTool[] {
  return catalog.filter((t) => t.agentVisible && (t.deferred || t.routineOnly))
}
