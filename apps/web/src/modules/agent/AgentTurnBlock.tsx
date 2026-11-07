// SPDX-License-Identifier: FSL-1.1-ALv2

import { createEffect, createSignal, Index, type JSX, on, onCleanup, Show } from "solid-js"
import {
  type Attr,
  type Default_Renderer_Data,
  default_renderer,
  default_set_attr,
  HREF,
  parser,
  parser_end,
  parser_write,
} from "streaming-markdown"
import { wrapTableElements } from "~/lib/markdown-tables"
import { mentionsToMarkdownLinks, pendingMentionStart } from "~/lib/mention-markdown"
import { isSafeUserUrl } from "~/lib/sanitize"
import { desktopState, isDesktop, localSessionFor } from "~/modules/desktop/desktop-store"
import { toLocalToolCalls } from "~/modules/desktop/local-turn-activity"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import type {
  MessageMetadata,
  ToolCallState,
  TurnTimelineEntry,
} from "~/modules/threads/message-store"
import { TurnEndApprovals } from "~/modules/threads/NodeDispatchApprovalCard"
import { AgentGlyph } from "~/ui/AgentGlyph"
import AgentActivity from "./AgentActivity"
import { SuggestionChips } from "./SuggestionChips"
import { groupToolCalls, SingleToolCallRow, StackedToolCallGroup } from "./ToolCallRow"

/**
 * Wrap the default renderer's set_attr to block dangerous href values.
 * The streaming-markdown default_set_attr calls node.setAttribute directly,
 * which bypasses browser href sanitization for javascript:/data: schemes.
 */
function safe_set_attr(data: Default_Renderer_Data, type: Attr, value: string): void {
  if (type === HREF) {
    const trimmed = value.trimStart()
    // Allowlist safe schemes (https/http/mailto via isSafeUserUrl) plus internal
    // entity refs (thread:uuid, user:uuid, app:type:id). Allowlisting closes
    // scheme-obfuscation bypasses (embedded \t/\n, percent-encoding) that a
    // blocklist cannot enumerate.
    if (!isSafeUserUrl(trimmed) && !isEntityRef(trimmed)) {
      // Strip unsafe URLs from the link by setting an empty href.
      default_set_attr(data, type, "")
      return
    }
    default_set_attr(data, type, value)
    // Add rel="noopener noreferrer" and target="_blank" to external links so
    // they open in a new tab without leaking a referrer or opener reference.
    if (/^https?:\/\//i.test(trimmed)) {
      const node = data.nodes[data.index]
      if (node instanceof HTMLElement) {
        node.setAttribute("rel", "noopener noreferrer")
        node.setAttribute("target", "_blank")
      }
    }
    return
  }
  default_set_attr(data, type, value)
}

function safe_renderer(root: HTMLElement): ReturnType<typeof default_renderer> {
  const renderer = default_renderer(root)
  return { ...renderer, set_attr: safe_set_attr }
}

interface AgentTurnBlockProps {
  mode: "expanded" | "collapsed"
  toolCalls: ToolCallState[]
  content: string
  isStreaming?: boolean
  isInterrupted?: boolean
  isLastMessage?: boolean
  metadata?: MessageMetadata | null
  /** Live reasoning text (streaming tail). Persisted turns read `metadata.reasoning`. */
  reasoning?: string
  /** True while reasoning is still streaming — drives the live "Thinking…" state. */
  reasoningStreaming?: boolean
  /** Live reasoning/tool interleave (streaming). Persisted turns read `metadata.timeline`. */
  timeline?: TurnTimelineEntry[]
  /**
   * The conversation this turn belongs to, so a local session's tool rows go
   * to the conversation that is running them and nowhere else (P6d-FX1).
   * Absent means "not a conversation a local session can hold", which renders
   * no local rows at all.
   */
  threadId?: string
  /**
   * This block IS the local session's turn block, so it draws the shell's tool
   * rows whether or not the turn is still running. Every other block reads the
   * rows only while it streams, which is what keeps one conversation's local
   * rows out of another's.
   */
  localTurnRows?: boolean
  /** The turn this block shows (the message that started it), live; a saved turn reads `metadata.turnId`. */
  turnId?: string | null
  /**
   * The person's message the turn answers, live (the stream's `askId`); a
   * saved turn reads `metadata.askId`. The answer and its tool rows carry
   * `data-turn-id` = the ask, else the turn: after an approval the turn's
   * trigger is the result row, but it still answers the person's question.
   */
  askId?: string | null
  /**
   * Draws answer text. Given, a live turn whose timeline holds its text draws
   * every text run where it was written, between the thinking and the tools,
   * exactly as the saved message will (S28): the answer is not drawn again
   * below the activity.
   */
  renderText?: (text: string) => JSX.Element
}

export default function AgentTurnBlock(props: AgentTurnBlockProps) {
  return (
    <Show when={props.mode === "expanded"} fallback={<CollapsedTurn {...props} />}>
      <ExpandedTurn {...props} />
    </Show>
  )
}

/** Render grouped tool calls — singles inline, runs of 2+ stacked. */
function ToolCallList(props: {
  toolCalls: ToolCallState[]
  turnId?: string | null
  askId?: string | null
}) {
  const groups = () => groupToolCalls(props.toolCalls)

  return (
    // `<Index>`, not `<For>`: `groupToolCalls` builds FRESH group objects on
    // every recompute, and `<For>` keys by reference, so any update to the turn
    // remounted every row and a stacked group the person had opened snapped shut.
    <Index each={groups()}>
      {(group) => (
        <Show
          when={group().calls.length > 1}
          fallback={
            <SingleToolCallRow
              toolCall={group().calls[0]}
              turnId={props.turnId}
              askId={props.askId}
            />
          }
        >
          <StackedToolCallGroup
            toolCalls={group().calls}
            turnId={props.turnId}
            askId={props.askId}
          />
        </Show>
      )}
    </Index>
  )
}

/**
 * Check if a link href is an internal entity ref: `thread:<id>`, `user:<id>`,
 * or `<app>:<type>:<id>`. This is an ALLOWLIST, not a scheme denylist: every
 * colon-separated segment must be a bare identifier (entity ids are UUIDs /
 * slugs), which structurally excludes any URL scheme carrying a non-identifier
 * payload — e.g. `vbscript:msgbox(1)` (parens), `javascript:alert(1)`,
 * `data:text/html,...` — so an unsafe scheme can never masquerade as an entity
 * ref. 2-segment refs are limited to the `thread`/`user` prefixes the click
 * handler actually opens.
 */
function isEntityRef(href: string): boolean {
  if (!href) return false
  const parts = href.split(":")
  if (!parts.every((p) => /^[\w-]+$/.test(p))) return false
  if (parts.length === 2) return parts[0] === "thread" || parts[0] === "user"
  return parts.length >= 3
}

/** Handle click on an entity link — open the referenced entity in a tab */
function handleEntityLinkClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest?.("a")
  if (!anchor) return
  const href = anchor.getAttribute("href")
  if (!href || !isEntityRef(href)) return

  e.preventDefault()
  e.stopPropagation()

  const label = anchor.textContent ?? ""
  const parts = href.split(":")
  if (parts[0] === "thread" && parts[1]) {
    openTab({ type: "thread", entityId: parts[1], label })
  } else if (parts[0] === "user" && parts[1]) {
    // User — not yet actionable (DM is future work)
    return
  } else if (parts.length >= 3) {
    const [app, entityType, id] = parts
    openTab({ type: `${app}:${entityType}`, entityId: id, label })
  }
}

function ExpandedTurn(props: AgentTurnBlockProps) {
  const i18n = useI18n()

  /**
   * P6d-T11: THE LOCAL SESSION'S TOOLS, IN THIS TURN.
   *
   * A turn running on the user's own machine reports its tool calls through
   * the shell rather than through the message stream, so they are appended
   * here, to the calls this turn already carries, and rendered by the same
   * component. Only in the block the shell's own session owns: a persisted
   * turn shows what it recorded, never what the session is doing now.
   *
   * AND ONLY IN THE CONVERSATION THAT IS RUNNING IT (P6d-FX1, SK-3). The guard
   * was `isDesktop() && isStreaming`, which never asked WHICH conversation the
   * live session belongs to: a session claimed for one DM painted its tool
   * names and argument summaries into any other conversation the user happened
   * to be streaming a cloud turn in. Those summaries are derived from a folder
   * on the user's machine and are outside Liaison's scope model entirely
   * (A20), so that was org data surfacing in a room that never ran it.
   */
  const localToolCalls = () =>
    isDesktop() &&
    // The block a local turn owns keeps its rows after the turn ends: they are
    // the only record of what it did, and the turn being over is said by
    // `isStreaming`, not by taking them away.
    (props.localTurnRows || props.isStreaming) &&
    localSessionFor(props.threadId ?? null, desktopState().agentId)
      ? toLocalToolCalls(desktopState().toolActivity)
      : []
  const toolCalls = () => {
    const local = localToolCalls()
    return local.length === 0 ? props.toolCalls : [...props.toolCalls, ...local]
  }
  let markdownRef: HTMLDivElement | undefined
  let mdParser: ReturnType<typeof parser> | null = null

  /**
   * Streaming-markdown 0.2.15 treats every `_` as an emphasis marker, even when
   * flanked by alphanumerics (CommonMark requires intraword underscores to be
   * literal — `foo_bar_baz` is not emphasis). Identifier-like strings in agent
   * answers (`SCREAMING_SNAKE_CASE`, `event_type`, log lines) get silently
   * stripped to `SCREAMINGSNAKECASE`. Backslash-escape intraword underscores
   * before feeding the parser so the renderer emits literal text.
   *
   * Buffers a trailing `<wordchar>_` pair across delta boundaries so a chunk
   * that ends mid-identifier still gets the escape when the next chunk's first
   * char is alphanumeric.
   */
  let pendingTail = ""
  function escapeIntrawordUnderscores(input: string, flush = false): string {
    const s = pendingTail + input
    // Hold back ONLY when the trailing chars look like a pending intraword
    // pair (`x_` waiting for next chunk's leading word char). A lone trailing
    // wordchar is safe to emit — streaming-markdown does its own one-char
    // buffering for emphasis lookahead, and double-buffering breaks downstream
    // assertions that count on smd's behavior.
    let take = s.length
    if (!flush && s.endsWith("_") && s.length >= 2 && /\w/.test(s[s.length - 2]!)) {
      take = s.length - 2
    }
    // AND an ENTITY MENTION that has not finished arriving. This parser has only
    // the CommonMark link rule, so `@[Label](app:type:id)` reached it as a stray
    // "@" beside a link and `[@[Label](ref)]` as a mangled label with a bracket
    // left over on screen. Complete tokens are rewritten to the plain link they
    // mean (below); a half arrived one is held back rather than committed as the
    // text it is not yet.
    if (!flush) {
      const pending = pendingMentionStart(s.slice(0, take))
      if (pending !== -1) take = pending
    }
    const head = s.slice(0, take)
    pendingTail = s.slice(take)
    return mentionsToMarkdownLinks(head.replace(/(\w)_(?=\w)/g, "$1\\_"))
  }

  // True whenever a turn is in-flight but nothing is visibly progressing: the
  // request was just sent (no tools, no reasoning, no content yet) or all tool
  // calls have settled and the answer hasn't started. A running tool or live
  // reasoning stream is its own indicator, so the dots stay hidden then.
  const isGenerating = () =>
    props.isStreaming &&
    props.content === "" &&
    !props.reasoningStreaming &&
    toolCalls().every((tc) => tc.status === "completed" || tc.status === "error")

  createEffect(() => {
    if (!markdownRef || mdParser) return
    mdParser = parser(safe_renderer(markdownRef))
    if (props.content) {
      const flush = !props.isStreaming
      parser_write(mdParser, escapeIntrawordUnderscores(props.content, flush))
      prevLength = props.content.length
      if (flush) {
        parser_end(mdParser)
        parserEnded = true
      }
      // A table the streaming parser just built is unbounded prose: give it
      // its scroll container before it is ever painted.
      wrapTableElements(markdownRef)
    }
  })

  let prevLength = 0
  let parserEnded = false
  createEffect(
    on(
      () => props.content,
      (content) => {
        if (!mdParser || !content || parserEnded) return
        const delta = content.slice(prevLength)
        if (delta) {
          parser_write(mdParser, escapeIntrawordUnderscores(delta, !props.isStreaming))
          prevLength = content.length
        }
        // Flush buffered content immediately for non-streaming messages
        if (!props.isStreaming && delta) {
          // Drain any held-back trailing chars before ending the parser.
          const tail = escapeIntrawordUnderscores("", true)
          if (tail) parser_write(mdParser, tail)
          parser_end(mdParser)
          parserEnded = true
        }
        if (delta && markdownRef) wrapTableElements(markdownRef)
      },
    ),
  )

  createEffect(
    on(
      () => props.isStreaming,
      (isStreaming, wasStreaming) => {
        if (wasStreaming && !isStreaming && mdParser && !parserEnded) {
          const tail = escapeIntrawordUnderscores("", true)
          if (tail) parser_write(mdParser, tail)
          parser_end(mdParser)
          parserEnded = true
        }
      },
    ),
  )

  onCleanup(() => {
    mdParser = null
    prevLength = 0
    parserEnded = false
  })

  const timeline = () => props.timeline ?? props.metadata?.timeline
  /** The answer is drawn in the activity, where it was written. */
  const inlineText = () =>
    !!props.renderText && (timeline() ?? []).some((entry) => entry.kind === "text")
  const answerTurnId = () =>
    props.askId ?? props.metadata?.askId ?? props.turnId ?? props.metadata?.turnId ?? undefined
  const caret = () =>
    props.content && props.isStreaming && props.isLastMessage ? (
      <span data-testid="agent-stream-caret" class="text-accent">
        ▋
      </span>
    ) : undefined

  return (
    <div class="space-y-1">
      <Show
        when={inlineText()}
        fallback={
          <AgentActivity
            toolCalls={toolCalls()}
            reasoning={props.reasoning ?? props.metadata?.reasoning}
            reasoningStreaming={props.reasoningStreaming}
            reasoningTokens={props.metadata?.usage?.reasoningTokens}
            timeline={timeline()}
            turnId={props.turnId ?? props.metadata?.turnId}
            askId={props.askId ?? props.metadata?.askId}
          />
        }
      >
        {/* The answer's anchor (`agent-answer` + `data-turn-id`) is the whole
            interleave here: its words are drawn between the tools. */}
        <div data-testid="agent-answer" data-turn-id={answerTurnId()} class="space-y-1">
          <AgentActivity
            toolCalls={toolCalls()}
            reasoning={props.reasoning ?? props.metadata?.reasoning}
            reasoningStreaming={props.reasoningStreaming}
            reasoningTokens={props.metadata?.usage?.reasoningTokens}
            timeline={timeline()}
            renderText={props.renderText}
            textTail={caret()}
            turnId={props.turnId ?? props.metadata?.turnId}
            askId={props.askId ?? props.metadata?.askId}
          />
        </div>
      </Show>
      <Show when={isGenerating()}>
        <div class="flex items-center gap-2 px-1 py-0.5 text-[12px] text-text-tertiary">
          <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span>{i18n.t("kernel.generating")}</span>
        </div>
      </Show>
      {/* `agent-answer` + `data-turn-id`: a guided step can point at the answer
          to the very request it sent, never an earlier one. The id is the
          person's message the turn answers (`askId`), else the turn's own
          trigger: after an approval the answer comes from a turn the result
          row started, and still answers that request. */}
      <Show when={!inlineText()}>
        <div
          ref={markdownRef}
          data-testid="agent-answer"
          data-turn-id={answerTurnId()}
          class="prose-agent"
          classList={{ hidden: !props.content }}
          onClick={handleEntityLinkClick}
        />
        {caret()}
      </Show>
      <Show when={props.isInterrupted}>
        <p class="mt-1 text-[12px] italic text-text-tertiary">{i18n.t("kernel.interrupted")}</p>
      </Show>
      <Show when={!props.isStreaming}>
        <SuggestionChips toolCalls={props.toolCalls} />
      </Show>
      {/* Last, below the words still streaming in: a dispatch waiting for approval. */}
      <TurnEndApprovals toolCalls={props.toolCalls} />
    </div>
  )
}

function CollapsedTurn(props: AgentTurnBlockProps) {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const toolCount = () => props.toolCalls.length

  return (
    <div class="rounded-lg border border-border-subtle bg-surface-secondary p-3">
      <div class="flex items-center gap-1.5 text-[13px] font-medium text-accent">
        <span>
          <AgentGlyph />
        </span>
        <span>{i18n.t("kernel.liaison")}</span>
      </div>
      <Show when={toolCount() > 0}>
        <button
          type="button"
          class="mt-1.5 flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
          onClick={() => setExpanded((prev) => !prev)}
        >
          <span>{expanded() ? "▾" : "▸"}</span>
          <span>
            {expanded()
              ? toolCount() === 1
                ? i18n.t("kernel.agentUi.oneTool")
                : i18n.t("kernel.agentUi.toolsCount", { count: toolCount() })
              : toolCount() === 1
                ? i18n.t("kernel.agentUi.usedOneTool")
                : i18n.t("kernel.agentUi.usedTools", { count: toolCount() })}
          </span>
        </button>
        <Show when={expanded()}>
          <div class="ml-2 mt-1">
            <ToolCallList
              toolCalls={props.toolCalls}
              turnId={props.turnId ?? props.metadata?.turnId}
              askId={props.askId ?? props.metadata?.askId}
            />
          </div>
        </Show>
      </Show>
      <Show when={props.content}>
        <div class="mt-2 text-[13px] text-text-primary">{props.content}</div>
      </Show>
      <TurnEndApprovals toolCalls={props.toolCalls} />
    </div>
  )
}
