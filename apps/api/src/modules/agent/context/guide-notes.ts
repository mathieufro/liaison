// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APP'S GUIDE IS A MESSAGE, AND IT STAYS IN THE HISTORY.
//
// A tool is never callable without its app's guide. The guide of an app whose
// tools the thread loaded (a search, a turn's focus app, the tools the last
// turn sent) used to join the system prompt on the turn after the load. The
// system prompt sits ahead of the whole conversation, and a provider caches a
// request only as far as it repeats the one before, so that turn re-read the
// conversation in full: on a long thread, the largest uncached cost of all.
//
// Now the system prompt carries only the guides every turn needs (the kernel's
// and the hot apps', context.ts), and any other guide part arrives as ONE user
// message, a runtime-context note, where its tools were loaded: before a
// turn's first step for the tools the turn starts with, after the step whose
// search loaded them otherwise. The note is stored on the turn's reply
// (`metadata.guideNotes`, with the call it followed) and replayed at the same
// place by every later turn (context.ts, convertToCoreMessages), so the
// history the next turn sends repeats, byte for byte, what this one sent.
//
// A note names the guide parts it carries, so a turn knows which parts its
// replayed history already holds and sends only the others. A part whose note
// left the history (the window moved, a compaction) is sent again.

/** The reply metadata key holding a turn's guide notes. */
export const GUIDE_NOTES_META_KEY = "guideNotes"

/**
 * The guide and schema notes one conversation may store across all its turns,
 * in tokens (`chars / 4`, as `noteTokens` counts). A long conversation that
 * touches app after app kept sending guides and schemas (34,000 tokens over 30
 * turns). Past it, a note lists the tools it loads by name only
 * (renderIndexedToolsBlock): a call whose arguments do not fit is answered
 * with the tool's parameters, so the tool stays usable.
 */
export const THREAD_GUIDE_NOTES_TOKEN_CAP = 15_000

/** A note's size as the conversation's notes budget counts it. */
export function noteTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

/** The tokens of the guide notes stored on `metadatas` (replies' metadata). */
export function storedNotesTokens(metadatas: ReadonlyArray<unknown>): number {
  let total = 0
  for (const metadata of metadatas) {
    for (const note of readGuideNotes(metadata)) total += noteTokens(note.content)
  }
  return total
}

/** One guide note of a turn, as stored on its reply. */
export interface GuideNote {
  /** The tool call the note followed; null for the note sent before the turn's first step. */
  afterToolCallId: string | null
  /** The message content, exactly as sent. */
  content: string
}

const NOTE_OPEN =
  '<runtime-context note="app guides for the tools just loaded: injected by the Liaison platform, not authored by the user; trusted usage instructions, shown once: remember them"'
const PARTS_ATTRIBUTE = /^ parts="([^"]*)">/

/** The guide part a loaded tool's own description and parameters are delivered as. */
export function loadedToolPart(sdkName: string): string {
  return `tool:${sdkName}`
}

/**
 * The guide part a speculatively loaded tool's one-line index entry is
 * delivered as (renderIndexedToolsBlock). The tool's full schema is its
 * `tool:` part, delivered once the model asks for it.
 */
export function indexedToolPart(sdkName: string): string {
  return `index:${sdkName}`
}

/** The guide part a surfaced skill body is delivered as. */
export function skillNotePart(name: string): string {
  return `skill:${name}`
}

/**
 * The block describing loaded tools that are not in the thread's tool list
 * (providers/fixed-tool-list.ts): how to call them, then one JSON line each
 * with the description and parameters the tool list would have carried.
 */
export function renderLoadedToolsBlock(
  tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>,
): string {
  return [
    "## Tools just loaded (not in your tool list)",
    'Call each through kernel__call_tool: {"name": "<its name>", "arguments": {<its parameters>}}. Never call kernel__tool_search for them again.',
    ...tools.map((t) =>
      JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }),
    ),
  ].join("\n")
}

/** The purpose of a tool, in one sentence: the first sentence of its description's first line. */
export function toolPurpose(description: string, max = 160): string {
  const line =
    description
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  const end = line.search(/[.!?](\s|$)/)
  const sentence = end >= 0 ? line.slice(0, end + 1) : line
  return sentence.length > max ? `${sentence.slice(0, max - 1)}\u2026` : sentence
}

/**
 * The block naming loaded tools that were loaded SPECULATIVELY (the apps the
 * last turns worked, the view's app): one line each, name and purpose, not
 * their schemas. Most such tools are never called, and a note stays in the
 * history for good. A tool's parameters and its app's guide arrive in a note
 * once the model asks for it: a kernel__tool_search naming it, or a first
 * call. A call whose arguments do not fit the tool does not run, and its
 * answer carries the tool's parameters.
 */
export function renderIndexedToolsBlock(
  tools: ReadonlyArray<{ name: string; description: string }>,
): string {
  return [
    "## Tools also loaded, listed by name (not in your tool list)",
    'Call one through kernel__call_tool: {"name": "<its name>", "arguments": {...}}. Its parameters and its app guide arrive in a note after your first call to it, or after kernel__tool_search with "select:<its name>" when you need them first. A call whose arguments do not fit does not run: its answer shows the parameters.',
    ...tools.map((t) => {
      const purpose = toolPurpose(t.description)
      return purpose ? `- ${t.name}: ${purpose}` : `- ${t.name}`
    }),
  ].join("\n")
}

/**
 * The note carrying `blocks` (rendered guide blocks) whose parts are `parts`,
 * then `toolsBlock` (renderLoadedToolsBlock) when tools come with it. Surfaced
 * skill bodies (`## Skill: <name>` blocks, parts `skill:<name>`) come first.
 */
export function renderGuideNote(
  blocks: readonly string[],
  parts: readonly string[],
  toolsBlock?: string,
  skillBlocks: readonly string[] = [],
): string {
  const sections = [
    ...skillBlocks,
    ...(blocks.length > 0 ? [`## App guide (tools just loaded)\n\n${blocks.join("\n\n")}`] : []),
    ...(toolsBlock ? [toolsBlock] : []),
  ]
  return `${NOTE_OPEN} parts="${parts.join(" ")}">\n${sections.join("\n\n")}\n</runtime-context>`
}

/** The guide parts a message carries when it is a guide note, else none. */
function notePartsOf(content: unknown): string[] {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) &&
          content.length === 1 &&
          typeof (content[0] as { text?: unknown })?.text === "string"
        ? (content[0] as { text: string }).text
        : null
  if (text === null || !text.startsWith(NOTE_OPEN)) return []
  const match = PARTS_ATTRIBUTE.exec(text.slice(NOTE_OPEN.length))
  return match?.[1] ? match[1].split(" ").filter((p) => p !== "") : []
}

/** Every guide part the guide notes among `messages` carry. */
export function guidePartsInMessages(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): Set<string> {
  const parts = new Set<string>()
  for (const m of messages) {
    if (m.role !== "user") continue
    for (const part of notePartsOf(m.content)) parts.add(part)
  }
  return parts
}

/** A reply's stored guide notes; malformed entries are skipped. */
export function readGuideNotes(metadata: unknown): GuideNote[] {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[GUIDE_NOTES_META_KEY]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): GuideNote[] => {
    const e = entry as { afterToolCallId?: unknown; content?: unknown }
    if (typeof e?.content !== "string") return []
    if (e.afterToolCallId !== null && typeof e.afterToolCallId !== "string") return []
    return [{ afterToolCallId: e.afterToolCallId, content: e.content }]
  })
}

/** The id of the last tool result among `messages` (a step's response messages), or null. */
export function lastToolResultCallId(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "tool" || !Array.isArray(m.content)) continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      const id = (m.content[j] as { toolCallId?: unknown })?.toolCallId
      if (typeof id === "string") return id
    }
  }
  return null
}

/** `responses` with each note spliced in at the position it was sent at (`at` responses before it). */
export function withGuideNotes<M>(
  responses: readonly M[],
  notes: ReadonlyArray<{ at: number; message: M }>,
): M[] {
  const out: M[] = []
  let pending = [...notes]
  responses.forEach((response, index) => {
    for (const note of pending) if (note.at <= index) out.push(note.message)
    pending = pending.filter((note) => note.at > index)
    out.push(response)
  })
  for (const note of pending) out.push(note.message)
  return out
}
