// SPDX-License-Identifier: FSL-1.1-ALv2
import { Hourglass, MessageCircle, Sparkles, User } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { entityIcon } from "~/lib/entity-icon"
import { flattenMentionGroups, groupMentionResults, mentionKind } from "~/lib/mention-groups"
import {
  type MentionResult,
  MentionSearchUnavailableError,
  type MentionTrigger,
  searchMentions,
} from "~/lib/mention-service"
import { ambiguousNameKeys, foldName } from "~/lib/name-collision"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { awayLabel } from "~/modules/shell/route-line"
import { personalAgentFor } from "~/modules/threads/agent-directory"
import { getThread } from "~/modules/threads/thread-store"

interface MentionAutocompleteProps {
  query: string
  trigger: MentionTrigger
  /** A number is pixels; a string is any CSS length (e.g. "100%": the
   *  popup's bottom on the host's top edge). */
  position: { bottom: number | string; left: number }
  onSelect: (item: MentionResult) => void
  onClose: () => void
  onKeyDown?: (handler: (e: KeyboardEvent) => boolean) => void
  /** Measure the room around the host and open where the picker fits: above
   *  (on `position.bottom`) when it fits there or above is the larger side,
   *  shortened to the room, else below the host. For a host that can sit
   *  anywhere in a scrolling page, where a fixed upward popup is cut off by
   *  whatever clips the page (fitMentionPopup). */
  fit?: boolean
}

/** The rows' own cap, as the list always had it. */
const LIST_MAX_PX = 240
/** The popup's chrome around the list (border, padding) and a gap kept clear. */
const POPUP_CHROME_PX = 12
const EDGE_GAP_PX = 8
/** Shorter than this, a list is not worth opening on that side. */
const LIST_MIN_PX = 96

export interface MentionPopupFit {
  placement: "above" | "below"
  /** The list's max height on that side. */
  listMax: number
}

/**
 * Where a picker anchored to `host` fits: the viewport, cut down by every
 * ancestor that clips its overflow (a pane's scroll, a rail with
 * `overflow: hidden`), is the room; above wins when the list fits there whole
 * or above is still the larger side.
 */
export function fitMentionPopup(host: HTMLElement, listHeight: number): MentionPopupFit {
  let top = 0
  let bottom = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerHeight
  for (let el = host.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el)
    const clips = [style.overflow, style.overflowX, style.overflowY].some(
      (v) => v !== "" && v !== "visible",
    )
    if (!clips) continue
    const r = el.getBoundingClientRect()
    top = Math.max(top, r.top)
    bottom = Math.min(bottom, r.bottom)
  }
  const h = host.getBoundingClientRect()
  const above = h.top - top - EDGE_GAP_PX - POPUP_CHROME_PX
  const below = bottom - h.bottom - EDGE_GAP_PX - POPUP_CHROME_PX
  const want = Math.min(LIST_MAX_PX, listHeight > 0 ? listHeight : LIST_MAX_PX)
  const placement = above >= want || above >= below || below < LIST_MIN_PX ? "above" : "below"
  const room = placement === "above" ? above : below
  return { placement, listMax: Math.max(LIST_MIN_PX, Math.min(LIST_MAX_PX, Math.floor(room))) }
}

const MentionAutocomplete: Component<MentionAutocompleteProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [results, setResults] = createSignal<MentionResult[]>([])
  // Grouped by kind, the trigger's own kinds first, every other kind capped.
  const groups = () => groupMentionResults(results(), props.trigger)
  // What the arrow keys walk: the grouped rows in display order. Selecting by
  // index over the RAW list picked a row the writer could not see once the
  // caps started dropping rows.
  const visible = () => flattenMentionGroups(groups())
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [unavailable, setUnavailable] = createSignal(false)
  const [fitted, setFitted] = createSignal<MentionPopupFit | null>(null)
  let popupEl: HTMLDivElement | undefined
  let listEl: HTMLDivElement | undefined
  const refit = (): void => {
    const host = popupEl?.parentElement
    if (!props.fit || !host) return
    setFitted(fitMentionPopup(host, listEl?.scrollHeight ?? 0))
  }
  // Measured once the rows are in, and again when the page moves under it.
  createEffect(
    on([results, unavailable], () => {
      if (props.fit) queueMicrotask(refit)
    }),
  )
  onMount(() => {
    if (!props.fit) return
    window.addEventListener("resize", refit)
    window.addEventListener("scroll", refit, true)
    onCleanup(() => {
      window.removeEventListener("resize", refit)
      window.removeEventListener("scroll", refit, true)
    })
  })
  let searchTimeout: ReturnType<typeof setTimeout> | undefined
  let searchSeq = 0

  // Search when query changes. Empty query is intentional — it fires on
  // the bare `@`/`#` trigger so the popup shows top mentionables before
  // the user types (Linear/Slack pattern). The server's mentionSearch now
  // accepts q="" and returns recent items.
  createEffect(
    on(
      () => props.query,
      (q) => {
        if (searchTimeout) clearTimeout(searchTimeout)
        const seq = ++searchSeq
        searchTimeout = setTimeout(async () => {
          try {
            const data = await searchMentions(api, q, props.trigger, 8)
            if (seq !== searchSeq) return
            setUnavailable(false)
            setResults(data)
            setSelectedIndex(0)
          } catch (err) {
            if (seq !== searchSeq) return
            if (err instanceof MentionSearchUnavailableError) {
              setUnavailable(true)
              setResults([])
            } else {
              setUnavailable(false)
              setResults([])
            }
          }
        }, 150)
      },
    ),
  )

  // Returns true if the event was handled
  function handleKeyDown(e: KeyboardEvent): boolean {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, visible().length - 1))
      return true
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
      return true
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      const selected = visible()[selectedIndex()]
      if (selected) props.onSelect(selected)
      return true
    } else if (e.key === "Escape") {
      props.onClose()
      return true
    }
    return false
  }

  // Expose keyboard handler to parent
  onMount(() => props.onKeyDown?.(handleKeyDown))

  onCleanup(() => {
    if (searchTimeout) clearTimeout(searchTimeout)
    // Clear the keyboard handler reference in the parent so stale handler doesn't eat keystrokes
    props.onKeyDown?.(() => false)
  })

  // Two people rows with the same display name ("Dana Reyes" twice) are only
  // told apart by their email, so a user row's secondary line shows it
  // exactly when another VISIBLE user row shares its name; a uniquely named
  // person stays on one line like before.
  const ambiguousUserNames = () =>
    ambiguousNameKeys(
      results()
        .filter((item) => item.type === "user")
        .map((item) => item.label),
    )

  /**
   * The row's second line. Four tasks with the same title were four rows with
   * nothing to tell them apart, so every row says something of its own: a
   * channel its member count, an agent its handle, a task its project (filled
   * in by the server, which holds the join).
   */
  const secondaryFor = (item: MentionResult): string | undefined => {
    if (item.type === "thread") {
      const thread = getThread(item.id)
      if (thread) {
        const members = thread.participants.length
        return members === 1
          ? i18n.t("kernel.mentions.membersOne", { count: 1 })
          : i18n.t("kernel.mentions.membersMany", { count: members })
      }
    }
    if (item.type === "user") {
      return ambiguousUserNames().has(foldName(item.label)) ? item.secondaryLabel : undefined
    }
    return item.secondaryLabel
  }

  /**
   * The row's glyph. Everything that was not a person, a channel or an
   * approval fell through to the channel hash, so a task row drew the `#` a
   * channel draws and read as a channel. An entity row now takes the SAME
   * glyph the app gives that entity everywhere else (`~/lib/entity-icon`,
   * shared with search results); the hash is reserved for the channel trigger
   * it belongs to.
   */
  const iconFor = (item: MentionResult) => {
    if (item.type === "agent") return <Sparkles size={14} class="text-accent" />
    if (item.type === "user") return <User size={14} />
    if (item.type === "thread") return <MessageCircle size={14} />
    if (item.type === "approval_request") return <Hourglass size={14} />
    // Everything else is an app entity. The server sends the entity type AS
    // the row type (a task arrives as "task", repeated in `entityType`), so
    // every one of them fell through to the channel hash below.
    return <Dynamic component={entityIcon(mentionKind(item))} size={14} />
  }

  return (
    <Show when={results().length > 0 || unavailable()}>
      <div
        ref={popupEl}
        data-testid="mention-autocomplete"
        data-placement={fitted()?.placement}
        class="absolute z-50 w-[320px] max-w-[calc(100vw-32px)] rounded-lg border border-border bg-bg shadow-xl"
        style={
          fitted()?.placement === "below"
            ? { top: "100%", left: `${props.position.left}px` }
            : {
                bottom:
                  typeof props.position.bottom === "number"
                    ? `${props.position.bottom}px`
                    : props.position.bottom,
                left: `${props.position.left}px`,
              }
        }
      >
        <Show
          when={!unavailable()}
          fallback={
            <div
              data-testid="mention-autocomplete-unavailable"
              class="px-3 py-2 text-[12px] text-text-tertiary"
            >
              {i18n.t("kernel.threadsUi.mentionSearchIsStartingUp")}
            </div>
          }
        >
          <div
            ref={listEl}
            data-mention-list
            class="max-h-[240px] overflow-y-auto py-1"
            style={fitted() ? { "max-height": `${fitted()?.listMax}px` } : undefined}
          >
            <For each={groups()}>
              {(group) => (
                <div data-testid={`mention-group-${group.kind}`}>
                  {/* Every group says what it is. A row with no kind is a row
                      the writer cannot place: four identically titled tasks
                      drawn like channels is how this looked without it. */}
                  <div
                    data-testid="mention-group-heading"
                    class="px-3 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary"
                  >
                    {i18n.t(group.labelKey)}
                  </div>
                  <For each={group.items}>
                    {(item) => (
                      <button
                        type="button"
                        data-testid={`mention-result-${item.type}`}
                        // The viewer's own agent: what a guided step points at.
                        data-own-agent={
                          item.type === "agent" &&
                          item.id === personalAgentFor(userFromToken()?.userId)?.id
                            ? "true"
                            : undefined
                        }
                        class={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${
                          visible()[selectedIndex()] === item
                            ? "bg-surface-hover text-text"
                            : "text-text-secondary hover:bg-surface-hover/50"
                        }`}
                        onClick={() => props.onSelect(item)}
                        onMouseEnter={() => setSelectedIndex(visible().indexOf(item))}
                      >
                        <span
                          data-testid={`mention-result-glyph-${item.type}`}
                          data-entity-type={mentionKind(item)}
                          class="mt-0.5 shrink-0 text-text-tertiary"
                        >
                          {iconFor(item)}
                        </span>
                        {/* Stacked, not side by side: the secondary line used
                            to sit on the title's row and take its width from
                            it, so "Email-bounce dashboard for support" was
                            truncated to nothing readable at the picker's
                            width. Title owns the whole line now; the qualifier
                            reads underneath, and it is what tells two rows with
                            the same title apart. */}
                        <span class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate text-[13px] leading-snug">{item.label}</span>
                          <Show when={secondaryFor(item)}>
                            {(secondary) => (
                              <span
                                data-testid="mention-result-secondary"
                                class="truncate text-[11px] leading-snug text-text-tertiary"
                              >
                                {secondary()}
                              </span>
                            )}
                          </Show>
                          <Show when={awayLabel(item.away, i18n.t, i18n.locale())}>
                            {(away) => (
                              <span
                                data-testid="mention-result-away"
                                class="truncate text-[11px] leading-snug text-text-tertiary"
                              >
                                {away()}
                              </span>
                            )}
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}

export type { MentionResult }
export { MentionAutocomplete }
