// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import { toolRegistry } from "~/modules/apps/app-registries"

interface BulkDecl {
  label: string
  underlyingTool: string
  dispatchMode: "perItem" | "aggregate"
  perItemParam?: string
  selectionParam?: string
  sharedFields?: string[]
  agentTool?: string
  minSelection?: number
  /** Defer the derived agent tool from the hot tool core (discoverable via tool_search). */
  deferLoading?: boolean
  /** Words people use for the action, read only by the tool_search ranker. */
  searchKeywords?: string[]
}

/** The search words of a derived agent tool: every word its actions declare, once. */
function bulkSearchKeywords(decls: readonly BulkDecl[]): { searchKeywords?: string[] } {
  const words = [...new Set(decls.flatMap((d) => d.searchKeywords ?? []))]
  return words.length ? { searchKeywords: words } : {}
}

interface ManifestToolDecl {
  requiredScopes: string[]
  /** The underlying tool's declared write target (scope taint), inherited by its bulk tool. */
  writesToTable?: string
  params?: { properties?: Record<string, { type?: string; description?: string }> }
  editableFields?: Array<{ field: string; widget?: string; label?: string }>
}

interface BulkRegistrationOptions {
  orgId: string
  appName: string
  bulk: Record<string, BulkDecl>
  tools: Record<string, ManifestToolDecl>
  /** Kernel code only (kernel-bulk.ts): its underlying tools are kernel tools whose write
   *  targets are kernel tables. An app's bulk tool inherits only a table in its own schema,
   *  the rule runtime.ts applies to the underlying tools themselves. */
  vouched?: boolean
}

export interface BulkToolMeta {
  app: string
  /** Single action when one entry in the group; undefined when grouped. */
  action?: string
  /** Maps `operation` param value to the bulk action name. Present when grouped. */
  operationMap?: Record<string, string>
}

function sharedFieldZodType(underlying: ManifestToolDecl, field: string): z.ZodTypeAny | undefined {
  const param = underlying.params?.properties?.[field]
  if (param) {
    switch (param.type) {
      case "string":
        return z.string()
      case "number":
        return z.number()
      case "boolean":
        return z.boolean()
      case "object":
        return z.record(z.string(), z.unknown())
      case "array":
        return z.array(z.unknown())
      default:
        return z.unknown()
    }
  }
  const editable = (underlying.editableFields ?? []).find((f) => f.field === field)
  if (editable) {
    return z.string()
  }
  return undefined
}

function buildSingleEntryParams(underlying: ManifestToolDecl, decl: BulkDecl): z.ZodTypeAny {
  const fields: Record<string, z.ZodTypeAny> = {
    ids: z.array(z.string()).min(1),
    idempotencyKey: z.string().uuid(),
  }
  for (const f of decl.sharedFields ?? []) {
    const t = sharedFieldZodType(underlying, f)
    if (t) fields[f] = t.optional()
  }
  return z.object(fields)
}

function buildGroupedParams(operations: string[]): z.ZodTypeAny {
  return z.object({
    ids: z.array(z.string()).min(1),
    operation: z.enum(operations as [string, ...string[]]),
    params: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.string().uuid(),
  })
}

function parentScope(toolScope: string): string {
  const parts = toolScope.split(":")
  if (parts.length < 3) return toolScope
  const last = parts[parts.length - 1]
  if (last === "close" || last === "delete") parts[parts.length - 1] = "write"
  return parts.join(":")
}

const noopHandler = async () => ({})

/**
 * The write target a bulk tool inherits (scope taint): a bulk call dispatches its underlying
 * tool once per item, so it writes exactly what that tool writes. Inherited only when every
 * underlying tool declares the SAME table, and only a table the app may declare (its own
 * schema; any table for the kernel's own bulk tools). Otherwise none: the bulk tool stays an undeclared
 * write, refused on a tainted turn.
 */
function inheritedWriteTarget(
  appName: string,
  underlying: (ManifestToolDecl | undefined)[],
  vouched: boolean,
): string | undefined {
  const targets = new Set(underlying.map((t) => t?.writesToTable))
  if (targets.size !== 1) return undefined
  const [target] = targets
  if (typeof target !== "string") return undefined
  return vouched || target.startsWith(`app_${appName.replace(/-/g, "_")}.`) ? target : undefined
}

/**
 * Group bulk action declarations by their `agentTool` name and register one
 * agent-visible kernel tool per group. Each registration carries `bulkMeta`
 * so executeToolCore can recognize and dispatch through runBulkDispatch using
 * the full actor context.
 */
export function registerBulkAgentTools(opts: BulkRegistrationOptions): void {
  const { orgId, appName, bulk, tools } = opts
  if (!bulk) return

  const groups = new Map<string, Array<{ action: string; decl: BulkDecl }>>()
  for (const [action, decl] of Object.entries(bulk)) {
    if (!decl.agentTool) continue
    const list = groups.get(decl.agentTool) ?? []
    list.push({ action, decl })
    groups.set(decl.agentTool, list)
  }

  for (const [agentToolName, entries] of groups) {
    if (entries.length === 1) {
      const { action, decl } = entries[0]
      const underlying = tools[decl.underlyingTool]
      if (!underlying) continue
      const meta: BulkToolMeta = { app: appName, action }
      const writesToTable = inheritedWriteTarget(appName, [underlying], opts.vouched === true)
      toolRegistry.set([orgId, appName, agentToolName], {
        appName,
        name: agentToolName,
        description: `Bulk ${decl.label}`,
        requiredScopes: underlying.requiredScopes,
        gated: false,
        agentVisible: true,
        ...(decl.deferLoading === true ? { deferLoading: true } : {}),
        ...bulkSearchKeywords([decl]),
        handler: noopHandler,
        params: buildSingleEntryParams(underlying, decl),
        bulkMeta: meta,
        ...(writesToTable !== undefined ? { writesToTable } : {}),
      } as any)
    } else {
      const operationMap: Record<string, string> = {}
      let requiredScopes: string[] = []
      for (const { action, decl } of entries) {
        operationMap[action] = action
        const underlying = tools[decl.underlyingTool]
        if (requiredScopes.length === 0 && underlying) {
          requiredScopes = [...new Set(underlying.requiredScopes.map(parentScope))]
        }
      }
      const meta: BulkToolMeta = { app: appName, operationMap }
      const writesToTable = inheritedWriteTarget(
        appName,
        entries.map(({ decl }) => tools[decl.underlyingTool]),
        opts.vouched === true,
      )
      toolRegistry.set([orgId, appName, agentToolName], {
        appName,
        name: agentToolName,
        description: `Bulk operations on ${appName}`,
        requiredScopes,
        gated: false,
        agentVisible: true,
        ...bulkSearchKeywords(entries.map(({ decl }) => decl)),
        handler: noopHandler,
        params: buildGroupedParams(Object.keys(operationMap)),
        bulkMeta: meta,
        ...(writesToTable !== undefined ? { writesToTable } : {}),
      } as any)
    }
  }
}
