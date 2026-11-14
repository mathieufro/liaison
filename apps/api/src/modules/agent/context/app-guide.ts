// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APP'S AGENT GUIDE, IN PARTS. `agentInstructions` used to be one string
// and one loaded tool pulled all of it into the cached prefix: the tickets
// guide is 8,400 tokens, shopify 10,400, and a thread that had touched five
// apps carried 35,000 tokens of guides on every step. A guide is now a short
// CORE (the rules that apply to every call of the app) plus SECTIONS keyed by
// the tools they are about. A section is rendered only while one of its tools
// is loaded, and it is delivered mid run the step its first tool is discovered,
// through the same tail message that already carried the whole guide. A plain
// string guide still works: it is a core with no sections.

export interface AppGuideSection {
  /** Tool names within the app (`reply`, not `tickets__reply`). */
  tools: string[]
  text: string
}

export interface AppGuide {
  core: string
  sections: AppGuideSection[]
}

export type AppGuideInput =
  | string
  | {
      core: string
      sections?: AppGuideSection[]
      /**
       * For a guide registered under a key that is not an app (the kernel's
       * `kernel-config`, `kernel-admin`, ...): the tools it is about, as sdk names
       * (`kernel__roles_list`) or prefixes ending in `*` (`kernel__config_*`).
       * Its core renders while one of them is loaded, with the sections of the
       * loaded ones (kernel and app tools alike); otherwise only its summary
       * line rides. An app's own guide follows its app instead.
       */
      coveredTools?: string[]
    }

/** The line that opens a section of a markdown guide: `<!-- tools: kernel__a, kernel__b -->`. */
const SECTION_MARKER = /^<!--\s*tools:\s*(.+?)\s*-->\s*$/

/**
 * A markdown guide (the kernel's `prompts/kernel/*.md`) as a guide input: the
 * text before the first section marker is the core, and each marker opens a
 * section about the tools it names (sdk names), up to the next marker. A
 * guide that names its tools (`coveredTools`, frontmatter `tools:`) also
 * covers its sections' tools, so loading one of them brings that section.
 * A file with neither stays a plain string guide.
 */
export function parseGuideMarkdown(content: string, coveredTools?: string[]): AppGuideInput {
  const coreLines: string[] = []
  const sections: Array<{ tools: string[]; lines: string[] }> = []
  for (const line of content.split("\n")) {
    const marker = line.match(SECTION_MARKER)
    if (marker) {
      const tools = marker[1]!
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      sections.push({ tools, lines: [] })
    } else (sections.at(-1)?.lines ?? coreLines).push(line)
  }
  const parsed = sections
    .map((s) => ({ tools: s.tools, text: s.lines.join("\n").trim() }))
    .filter((s) => s.tools.length > 0 && s.text.length > 0)
  if (!coveredTools?.length && parsed.length === 0) return content
  const core = coreLines.join("\n").trim()
  if (!coveredTools?.length) return { core, sections: parsed }
  const covered = [...new Set([...coveredTools, ...parsed.flatMap((s) => s.tools)])]
  return { core, sections: parsed, coveredTools: covered }
}

/** A string guide is a core with no sections. */
export function normalizeAppGuide(raw: AppGuideInput): AppGuide {
  if (typeof raw === "string") return { core: raw, sections: [] }
  return { core: raw.core, sections: raw.sections ?? [] }
}

/** Whether a guide that declares `coveredTools` has one of them loaded. */
export function guideCoversLoaded(raw: AppGuideInput, loaded: Iterable<string>): boolean {
  if (typeof raw === "string" || !raw.coveredTools?.length) return false
  const patterns = raw.coveredTools
  for (const name of loaded) {
    for (const p of patterns) {
      if (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p) return true
    }
  }
  return false
}

/** The sdk names (`app__tool`) of one section's tools. */
function sectionSdkNames(app: string, section: AppGuideSection): string[] {
  return section.tools.map((t) => (t.includes("__") ? t : `${app}__${t}`))
}

/** The stable key a delivered section is remembered under for one run. */
export function appGuideSectionKey(app: string, index: number): string {
  return `${app}#${index}`
}

/**
 * The parts of an app's guide that apply given the tools currently LOADED for
 * the provider: the core always, a section when one of its tools is loaded.
 * The one selection every door uses (system prompt, mid-run note, sub-agent
 * runs, MCP), for app guides and kernel guides alike, with the full loaded set
 * (kernel and app tools). `"all"` renders every section (tests, and the
 * callers that hand over a whole guide).
 */
export function selectAppGuideParts(
  app: string,
  guide: AppGuide,
  loaded: ReadonlySet<string> | "all",
): { core: string; sections: Array<{ key: string; text: string }> } {
  const sections: Array<{ key: string; text: string }> = []
  guide.sections.forEach((section, index) => {
    const applies =
      loaded === "all" || sectionSdkNames(app, section).some((name) => loaded.has(name))
    if (applies) sections.push({ key: appGuideSectionKey(app, index), text: section.text })
  })
  return { core: guide.core, sections }
}

/** One rendered block: the app heading, the core, then the applying sections. */
export function renderAppGuideBlock(
  app: string,
  parts: { core?: string; sections: Array<{ text: string }> },
): string {
  const body = [parts.core, ...parts.sections.map((s) => s.text)].filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  )
  return `### ${app}\n${body.join("\n\n")}`
}
