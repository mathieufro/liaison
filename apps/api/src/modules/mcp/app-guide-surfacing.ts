// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APP GUIDES OVER MCP. An in-app turn carries each app's `agentInstructions`
// (its core, plus the sections about the tools it loaded) in its system prompt
// (context.ts, app-guide.ts). An MCP client has no per-turn prompt of ours and
// the `initialize` instructions are cut at 2048 characters, so the guide rides
// on the first result of a call to that app, exactly as an anchored skill does
// (tool-call.ts): the core once per app, each section once, the first time one
// of its tools is called. Delivered parts are remembered in the connection's
// surfaced set under `app-guide:` keys, beside the skill names.
import {
  type AppGuideInput,
  guideCoversLoaded,
  normalizeAppGuide,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "~/modules/agent/context/app-guide"
import { agentInstructionsRegistry } from "~/modules/apps/app-registries"

export const APP_GUIDE_KEY_PREFIX = "app-guide:"

/** The surfaced-set key of a guide's core (`app`) or one section (`app#i`). */
export function appGuideSurfacedKey(part: string): string {
  return `${APP_GUIDE_KEY_PREFIX}${part}`
}

/**
 * The guide text to push on the result of a call to `canonical` (`app:tool`),
 * and the keys it delivers; null when everything that applies already went out.
 */
export function selectAppGuideToSurface(
  orgId: string,
  canonical: string,
  surfaced: ReadonlySet<string>,
): { keys: string[]; text: string } | null {
  const sep = canonical.indexOf(":")
  if (sep <= 0) return null
  const app = canonical.slice(0, sep)
  const sdkName = `${app}__${canonical.slice(sep + 1)}`
  const keys: string[] = []
  const blocks: string[] = []
  const loaded = new Set([sdkName])

  // The app's own guide, and each kernel guide registered under its own key
  // (`kernel-config`, ...) that covers the tool: the core once, and each
  // section about the called tool once, through the selection the in-app
  // assembler uses.
  const guides: Array<[string, AppGuideInput]> = []
  const own = agentInstructionsRegistry.get([orgId, app])
  if (own !== undefined) guides.push([app, own])
  for (const [key, guide] of agentInstructionsRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId || key[1] === app) continue
    if (guideCoversLoaded(guide, loaded)) guides.push([key[1], guide])
  }
  for (const [key, guide] of guides) {
    const parts = selectAppGuideParts(key, normalizeAppGuide(guide), loaded)
    const coreKey = appGuideSurfacedKey(key)
    const core = surfaced.has(coreKey) ? undefined : parts.core
    const sections = parts.sections.filter((s) => !surfaced.has(appGuideSurfacedKey(s.key)))
    if (!core && sections.length === 0) continue
    if (core) keys.push(coreKey)
    for (const s of sections) keys.push(appGuideSurfacedKey(s.key))
    blocks.push(renderAppGuideBlock(key, { core, sections }))
  }

  if (blocks.length === 0) return null
  return {
    keys,
    text:
      "Liaison's working guide for the app you just called: the same rules Liaison's own " +
      "agents follow when they use it. It is included here because an MCP client has no " +
      `other channel to receive it. Follow it.\n\n${blocks.join("\n\n")}`,
  }
}
