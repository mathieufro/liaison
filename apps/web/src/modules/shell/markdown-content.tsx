// SPDX-License-Identifier: FSL-1.1-ALv2
// Mention-aware markdown for every surface that shows user/agent prose —
// thread messages, task descriptions, task comments. Extracted from
// MessageList so the projects app renders the SAME markdown (and the same
// `@[Label](app:entityType:id)` entity mentions, with live previews) instead
// of its own plain-text fallback. Everything is funnelled through sanitizeHtml.

import { editorMarkdown, relabelAgentMentions } from "@liaison/shared"
import type { RendererExtension, TokenizerExtension, Tokens } from "marked"
import { Marked } from "marked"
import { type Component, createMemo, type JSX, Show, untrack } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ApiClient } from "~/lib/api-client"
import { localPathFromHref } from "~/lib/local-paths"
import { wrapMarkdownTables } from "~/lib/markdown-tables"
import { sanitizeHtml } from "~/lib/sanitize"
import { canOpenLocalPaths } from "~/modules/desktop/desktop-store"
import {
  handleLocalPathClick,
  type LocalPathMarks,
  linkifyLocalPaths,
  markLocalPathLink,
  newLocalPathMarks,
} from "~/modules/desktop/local-path-links"
import { tNow } from "~/modules/i18n/i18n-context"
import { openEntity } from "~/modules/shell/entity-opener"
import EntityPreview from "~/modules/shell/entity-preview/EntityPreview"
import { getEntityPreviewRenderer } from "~/modules/shell/entity-preview/registry"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { currentAgentHandle, openAgentPage } from "~/modules/threads/agent-directory"

export function isActionableMention(ref: string): boolean {
  const parts = ref.split(":")
  if (parts[0] === "thread" && parts[1]) return true
  // P4c-T39: an `@agent` chip names an agent, and an agent has a page. It is
  // as actionable as a thread chip and lands on the SAME page every other
  // surface that names that agent opens.
  if (parts[0] === "agent" && parts[1]) return true
  return parts.length >= 3
}

export function getMentionPrefix(ref: string): "@" | "#" {
  if (ref.startsWith("user:") || ref.startsWith("agent:")) return "@"
  if (ref.startsWith("kernel:user:")) return "@"
  if (ref.startsWith("kernel:approval_request:")) return "@"
  return "#"
}

/**
 * The chip's text: the prefix plus the label, unless the label already carries
 * it. A ticket's handle is written "#ticket-6507", and an agent that mentions
 * it as `@[#ticket-6507](tickets:ticket:...)` used to render as "##ticket-6507".
 */
function chipText(prefix: "@" | "#", label: string): string {
  if (label.startsWith(prefix)) return escapeHtml(label)
  // A link written `[@Project](projects:project:...)` carries the mention marker in its text:
  // the chip's own prefix replaces it, so it never reads "#@Project".
  const bare = prefix === "#" && label.startsWith("@") ? label.slice(1) : label
  return `${prefix}${escapeHtml(bare)}`
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

interface MentionToken extends Tokens.Generic {
  type: "mention"
  raw: string
  label: string
  ref: string
}

/**
 * The label inside `@[...]`. A bare `]` closes it, an escaped one does not, and
 * a BALANCED pair of square brackets is part of the name: mail subjects carry
 * them ("Re: [urgent] order") and an agent writing one unescaped used to lose
 * the match here, at which point marked's own link tokenizer balanced the
 * brackets, won, and left a bare "@" stranded in front of the chip.
 */
const MENTION_LABEL = String.raw`(?:[^[\]\\]|\\.|\[[^\]]*\])+`

/** `@[Label](ref)` as an agent writes it. */
const MENTION_RE = new RegExp(String.raw`^@\[(${MENTION_LABEL})\]\(([^)]+)\)`)

/**
 * The SAME token with a pair of literal square brackets around it, which is
 * how a Discuss reply came back: "[@[Client Feedback](mail:conversation:id)]".
 * Marked finds no link there (the closing bracket is not followed by a paren),
 * so it emitted both brackets as text and matched the mention between them; the
 * reader got a correct chip wearing the raw syntax as punctuation. Absorbed
 * here so the whole token becomes the chip and nothing is left over.
 */
const WRAPPED_MENTION_RE = new RegExp(String.raw`^\[@\[(${MENTION_LABEL})\]\(([^)]+)\)\]`)

/**
 * The SAME token as a markdown link's own text:
 * "[@[title](tickets:ticket:<id>)](tickets:ticket:<id>)". This is the form the
 * model actually produces, and the bracket-pair rule above matches its first
 * half exactly: the chip was drawn and the link's reference was left hanging
 * after it as raw text, which is how a ticket mention reached the reader as
 * "[@[title](tickets:ticket:<id>)](...)". Tried FIRST, for that reason.
 */
const LINK_WRAPPED_MENTION_RE = new RegExp(
  String.raw`^\[@\[(${MENTION_LABEL})\]\(([^)]+)\)\]\(([^)]+)\)`,
)

/** The mention token at the start of `src`, in any of the forms above. */
export function matchMention(src: string): { raw: string; label: string; ref: string } | undefined {
  const match =
    LINK_WRAPPED_MENTION_RE.exec(src) ?? WRAPPED_MENTION_RE.exec(src) ?? MENTION_RE.exec(src)
  if (!match) return undefined
  return { raw: match[0], label: match[1]!.replace(/\\([[\]\\])/g, "$1"), ref: match[2]! }
}

const mentionExtension: TokenizerExtension & RendererExtension = {
  name: "mention",
  level: "inline",
  start(src: string) {
    const bare = src.indexOf("@[")
    const wrapped = src.indexOf("[@[")
    if (bare === -1) return wrapped
    if (wrapped === -1) return bare
    return Math.min(bare, wrapped)
  },
  tokenizer(src: string): MentionToken | undefined {
    const match = matchMention(src)
    return match ? { type: "mention", ...match } : undefined
  },
  renderer(token) {
    const t = token as MentionToken
    // A ref that names no entity (an id copied from an upstream system into
    // mention syntax) opens nothing: its label reads as plain text.
    if (!isEntityRefHref(t.ref)) return escapeHtml(t.label)
    const prefix = getMentionPrefix(t.ref)
    const actionable = isActionableMention(t.ref)
    const cls = actionable ? "mention-pill mention-actionable" : "mention-pill"
    return `<span class="${cls}" data-mention-ref="${escapeAttr(t.ref)}">${chipText(prefix, t.label)}</span>`
  },
}

/**
 * An `app:entityType:id` reference, the scheme every entity mention already
 * uses (`mail:conversation:<uuid>`, `tickets:ticket:<id>`). Deliberately not a
 * URL scheme test: `http:`/`https:`/`mailto:` links are ordinary links and
 * must stay that way, and so must anything with a slash in it.
 */
const ENTITY_REF_HREF = /^(?!https?:|mailto:)[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*:[^\s/]+$/i

/**
 * The kernel's OWN references, which carry two parts rather than three:
 * `thread:<id>`, `agent:<handle>`, `user:<id>`. `isActionableMention` has
 * always opened all three, but the href test did not recognise them, so a
 * thread or an agent written as a link stayed raw markdown on screen and the
 * streaming rewrite passed the same token through untouched. Named one by one
 * rather than by shape: "note: something" is punctuation, not a reference.
 */
const KERNEL_REF_HREF = /^(?:thread|agent|user):[^\s/:]+$/i

/**
 * What the reference inside a stored `@[label](ref)` token may be: a scheme,
 * then colon separated parts with no whitespace, brackets, parentheses or
 * backslash. Anything else would end the token early or open a new one, so a
 * chip whose ref breaks this is never written as a mention.
 */
const MENTION_REF_RE = /^[A-Za-z][\w-]*(?::[^\s()[\]\\:]+)+$/

export function isMentionRef(ref: string): boolean {
  return MENTION_REF_RE.test(ref)
}

export function isEntityRefHref(href: string): boolean {
  return ENTITY_REF_HREF.test(href) || KERNEL_REF_HREF.test(href)
}

/**
 * A markdown LINK whose href is an entity reference renders as the same chip a
 * `@[...]` mention does. Agents write `[Client Feedback](mail:conversation:id)`
 * (it is how the reference reaches them), and the sanitizer drops any href that
 * is not http or mailto, so the reader was left with the raw markdown text on
 * screen and nothing to click.
 */
const entityLinkExtension: RendererExtension = {
  name: "link",
  renderer(token) {
    const t = token as Tokens.Link
    if (!isEntityRefHref(t.href)) return false
    const label = t.text ?? t.href
    const cls = isActionableMention(t.href) ? "mention-pill mention-actionable" : "mention-pill"
    return `<span class="${cls}" data-mention-ref="${escapeAttr(t.href)}">${chipText(getMentionPrefix(t.href), label)}</span>`
  },
}

/**
 * THE DESKTOP'S LOCAL PATH LINKS, for the parse in progress: set by
 * `renderContent` around its (synchronous) parse when the shell can open a
 * path, null otherwise. `base` is the conversation's session folder, which a
 * relative link target resolves against.
 */
let localPathContext: { base: string | null; marks: LocalPathMarks } | null = null

/**
 * A markdown link whose target is a path on this computer (`file://`, `C:\`,
 * `/Users/...`, `~/...`, or relative to the session folder). Desktop only:
 * the sanitizer would drop the href, so the link is marked for
 * `linkifyLocalPaths`, which finishes it. Everything else falls through to the
 * entity chip and then to marked's own link.
 */
const localPathLinkExtension: RendererExtension = {
  name: "link",
  renderer(token) {
    if (!localPathContext) return false
    const t = token as Tokens.Link
    const target = localPathFromHref(t.href, localPathContext.base)
    if (!target) return false
    return markLocalPathLink(localPathContext.marks, target, this.parser.parseInline(t.tokens))
  },
}

export const mentionMarked = new Marked(
  {
    breaks: true,
    gfm: true,
    extensions: [mentionExtension, entityLinkExtension, localPathLinkExtension],
  },
  editorMarkdown,
)

/** Build a click handler bound to an authenticated API client. */
export function createMentionDelegate(api: ApiClient) {
  return function handleMentionDelegate(e: MouseEvent) {
    const target = (e.target as HTMLElement).closest?.("[data-mention-ref]")
    if (!target) return
    const ref = target.getAttribute("data-mention-ref")
    if (!ref || !isActionableMention(ref)) return

    e.preventDefault()
    e.stopPropagation()

    const label = target.textContent?.slice(1) ?? "" // strip prefix char
    const parts = ref.split(":")
    if (parts[0] === "thread" && parts[1]) {
      openTab({ type: "thread", entityId: parts[1], label })
      return
    }
    if (parts[0] === "agent" && parts[1]) {
      openAgentPage({ id: parts[1], name: label })
      return
    }
    if (parts.length >= 3) {
      const [app, entityType, id] = parts
      void openEntity(api, app, entityType, id, label).catch((err) => {
        const status = (err as { status?: number } | null)?.status
        if (status === 404 || status === 403) {
          addToast({ message: tNow("kernel.shellUi.approvalGone"), type: "error" })
        }
      })
    }
  }
}

/** Parse mention refs for entity-preview lookup while preserving legacy wire refs. */
export function parsePreviewableRef(
  ref: string,
): { app: string; entityType: string; entityId: string } | null {
  const parts = ref.split(":")
  if (parts[0] === "user" && parts[1]) {
    return { app: "kernel", entityType: "user", entityId: parts.slice(1).join(":") }
  }
  if (parts[0] === "thread" && parts[1]) {
    return { app: "kernel", entityType: "thread", entityId: parts.slice(1).join(":") }
  }
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return null
  return { app: parts[0], entityType: parts[1], entityId: parts.slice(2).join(":") }
}

function previewMention(
  element: HTMLElement,
  ref: string | null,
  previewable: { app: string; entityType: string; entityId: string },
): JSX.Element {
  // Approval-request mentions navigate to the approval discussion thread on
  // click, so they keep hover-only previews (click-to-pin would swallow the
  // navigation via EntityPreview's stopPropagation). Other entity types
  // (contacts, users, threads) follow the default click-or-hover pattern
  // where clicking pins the preview.
  const isNavigationMention =
    previewable.app === "kernel" && previewable.entityType === "approval_request"
  return (
    <EntityPreview
      app={previewable.app}
      entityType={previewable.entityType}
      entityId={previewable.entityId}
      trigger={isNavigationMention ? "hover" : "click-or-hover"}
      interactiveChild={isNavigationMention}
      inline
    >
      <span class={element.getAttribute("class") ?? undefined} data-mention-ref={ref ?? undefined}>
        {element.textContent}
      </span>
    </EntityPreview>
  )
}

/** Sanitized markdown elements (and the table scroll wrapper) rebuilt as they are; anything else becomes a span. */
const PROSE_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "del",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
])

function renderHtmlNode(node: ChildNode): JSX.Element {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ""
  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const element = node as HTMLElement
  const ref = element.getAttribute("data-mention-ref")
  const previewable = ref ? parsePreviewableRef(ref) : null
  if (previewable) {
    // Reactive on registration: the mention upgrades in place when its app's
    // renderer registers after this message rendered. The memo only notifies
    // when availability flips, so unrelated registrations touch nothing.
    const hasRenderer = createMemo(
      () => !!getEntityPreviewRenderer(previewable.app, previewable.entityType),
    )
    const plain = (
      <span class={element.getAttribute("class") ?? undefined} data-mention-ref={ref ?? undefined}>
        {element.textContent}
      </span>
    )
    return (
      <Show when={hasRenderer()} fallback={plain}>
        {previewMention(element, ref, previewable)}
      </Show>
    )
  }

  const children = Array.from(element.childNodes).map(renderHtmlNode)
  const className = element.getAttribute("class") ?? undefined
  const tagName = element.tagName.toLowerCase()

  if (PROSE_TAGS.has(tagName)) {
    return (
      // The only inline style left after sanitizing is the table scroll
      // geometry markdown-tables.ts writes (the sanitizer allows no style).
      <Dynamic
        component={tagName}
        class={className}
        style={element.getAttribute("style") ?? undefined}
      >
        {children}
      </Dynamic>
    )
  }
  if (tagName === "a") {
    return (
      <a
        class={className}
        href={element.getAttribute("href") ?? undefined}
        title={element.getAttribute("title") ?? undefined}
        data-local-path={element.getAttribute("data-local-path") ?? undefined}
      >
        {children}
      </a>
    )
  }
  if (tagName === "span") {
    return (
      <span class={className} data-mention-ref={ref ?? undefined}>
        {children}
      </span>
    )
  }

  return <span>{children}</span>
}

/** Detects sanitized HTML containing a mention ref whose `app:entityType` has a registered preview renderer. */
function hasPreviewableMention(safeHtml: string): boolean {
  const re = /data-mention-ref="([^"]+)"/g
  let m: RegExpExecArray | null
  m = re.exec(safeHtml)
  while (m !== null) {
    const parsed = parsePreviewableRef(m[1])
    if (parsed && getEntityPreviewRenderer(parsed.app, parsed.entityType)) return true
    m = re.exec(safeHtml)
  }
  return false
}

export function renderContent(
  content: string,
  handleMentionDelegate: (e: MouseEvent) => void,
  options: { localPathBase?: string | null; inline?: boolean } = {},
): JSX.Element {
  // An agent mention names the agent as it is NOW, by id: the stored label is
  // the handle it had when the message was written. Read tracked, so a
  // message rendered before the agent directory loaded is relabelled when it does.
  const relabelled = relabelAgentMentions(content, currentAgentHandle)
  // Local path links exist only inside the desktop shell. Read untracked: a
  // message's HTML must not be rebuilt on every change of the shell's state.
  const localPaths = untrack(() => canOpenLocalPaths())
  const marks = newLocalPathMarks()
  localPathContext = localPaths ? { base: options.localPathBase ?? null, marks } : null
  let html: string
  try {
    html = (options.inline ? mentionMarked.parseInline : mentionMarked.parse)(relabelled, {
      async: false,
    }) as string
  } finally {
    localPathContext = null
  }
  // The wrap runs AFTER sanitizing, so the scroll container is markup this
  // file owns rather than markup the sanitizer has to be told to trust. So
  // does the local path pass, which builds its links through the DOM.
  const sanitized = wrapMarkdownTables(sanitizeHtml(html))
  const safeHtml = localPaths
    ? linkifyLocalPaths(sanitized, options.localPathBase ?? null, marks)
    : sanitized
  const onClick = (event: MouseEvent) => {
    if (localPaths && handleLocalPathClick(event)) return
    handleMentionDelegate(event)
  }
  // A message whose mentions have no renderer yet takes the plain innerHTML
  // path; it switches to the node tree once (when a renderer registers), after
  // which each mention resolves on its own.
  const previewable = createMemo(() => hasPreviewableMention(safeHtml))
  return (
    <Show
      when={previewable()}
      fallback={
        <Dynamic
          component={options.inline ? "span" : "div"}
          class="prose-thread"
          innerHTML={safeHtml}
          onClick={onClick}
        />
      }
    >
      {(() => {
        const doc = new DOMParser().parseFromString(safeHtml, "text/html")
        return (
          <Dynamic
            component={options.inline ? "span" : "div"}
            class="prose-thread"
            onClick={onClick}
          >
            {Array.from(doc.body.childNodes).map(renderHtmlNode)}
          </Dynamic>
        )
      })()}
    </Show>
  )
}

/** A mention ref found in raw markdown, e.g. `@[Spec v0.7](knowledge:source_link:<id>)`. */
export interface MentionRef {
  label: string
  ref: string
  app: string
  entityType: string
  entityId: string
}

/** Scan raw markdown for `@[Label](app:entityType:id)` mentions (the same
 *  grammar the tokenizer accepts), in document order, de-duplicated by ref.
 *  Used to list a task's linked documents without rendering anything. */
export function extractMentionRefs(markdown: string | null | undefined): MentionRef[] {
  if (!markdown) return []
  const out: MentionRef[] = []
  const seen = new Set<string>()
  const re = /@\[((?:[^\]\\]|\\.)+)\]\(([^)\s]+)\)/g
  let m: RegExpExecArray | null = re.exec(markdown)
  while (m !== null) {
    const ref = m[2]!
    const parsed = parsePreviewableRef(ref)
    if (parsed && !seen.has(ref)) {
      seen.add(ref)
      out.push({
        label: m[1]!.replace(/\\([\]\\])/g, "$1"),
        ref,
        app: parsed.app,
        entityType: parsed.entityType,
        entityId: parsed.entityId,
      })
    }
    m = re.exec(markdown)
  }
  return out
}

/** Sanitized, mention-aware markdown. Mentions open their entity on click and
 *  show a live preview on hover when the app registered one. */
export const MarkdownContent: Component<{
  content: string | null | undefined
  api: ApiClient
  class?: string
  /** One line of inline markdown (a title): marks and links, no blocks. */
  inline?: boolean
  "data-testid"?: string
}> = (props) => {
  const delegate = createMentionDelegate(props.api)
  return (
    <Show when={props.content}>
      <Dynamic
        component={props.inline ? "span" : "div"}
        class={props.class}
        data-testid={props["data-testid"]}
      >
        {renderContent(props.content ?? "", delegate, { inline: props.inline })}
      </Dynamic>
    </Show>
  )
}
