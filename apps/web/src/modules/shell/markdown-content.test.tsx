// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  entityPreviewRegistry,
  registerEntityPreview,
} from "~/modules/shell/entity-preview/registry"
import {
  extractMentionRefs,
  isEntityRefHref,
  MarkdownContent,
  renderContent,
} from "~/modules/shell/markdown-content"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import { previewLine } from "~/modules/threads/system-line"

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ getEnvelope: vi.fn() }),
}))

describe("markdown-content", () => {
  it("extracts document/file mentions from raw markdown, in order, de-duplicated", () => {
    const md = [
      "Spec: @[PRD App Init v0.7](knowledge:source_link:11111111-1111-4111-8111-111111111111)",
      "Notes @[Notes](knowledge:document:doc-1) and again @[Notes](knowledge:document:doc-1)",
      "Owner @[Dana](kernel:user:u1), mock @[maquette.png](kernel:file:f1)",
      "Escaped \\] label: @[A \\] B](knowledge:document:doc-2)",
      "Not a mention: [link](https://example.com) and @[broken](nope)",
    ].join("\n")
    expect(extractMentionRefs(md)).toEqual([
      {
        label: "PRD App Init v0.7",
        ref: "knowledge:source_link:11111111-1111-4111-8111-111111111111",
        app: "knowledge",
        entityType: "source_link",
        entityId: "11111111-1111-4111-8111-111111111111",
      },
      {
        label: "Notes",
        ref: "knowledge:document:doc-1",
        app: "knowledge",
        entityType: "document",
        entityId: "doc-1",
      },
      { label: "Dana", ref: "kernel:user:u1", app: "kernel", entityType: "user", entityId: "u1" },
      {
        label: "maquette.png",
        ref: "kernel:file:f1",
        app: "kernel",
        entityType: "file",
        entityId: "f1",
      },
      {
        label: "A ] B",
        ref: "knowledge:document:doc-2",
        app: "knowledge",
        entityType: "document",
        entityId: "doc-2",
      },
    ])
    expect(extractMentionRefs(null)).toEqual([])
  })

  it("renders markdown with mention pills and strips script", () => {
    const api = { get: vi.fn() } as any
    const { container } = render(() => (
      <MarkdownContent
        api={api}
        content={
          "**Contexte**\n\n- un\n- deux\n\n@[Spec](knowledge:document:d1) <script>alert(1)</script>"
        }
      />
    ))
    expect(container.querySelector("strong")?.textContent).toBe("Contexte")
    expect(container.querySelectorAll("li")).toHaveLength(2)
    const pill = container.querySelector("[data-mention-ref]")
    expect(pill?.getAttribute("data-mention-ref")).toBe("knowledge:document:d1")
    expect(pill?.textContent).toBe("#Spec")
    expect(container.querySelector("script")).toBeNull()
  })

  it("underlines ++text++ and draws checklists, the way the editor writes them", () => {
    const api = { get: vi.fn() } as any
    const { container } = render(() => (
      <MarkdownContent
        api={api}
        content={
          "Soit ++42 **convertis**++, en C++ et C++.\n\n`a ++b++`\n\n- [ ] à faire\n- [x] fait"
        }
      />
    ))
    const u = container.querySelector("u")
    expect(u?.textContent).toBe("42 convertis")
    expect(u?.querySelector("strong")?.textContent).toBe("convertis")
    expect(container.querySelectorAll("u")).toHaveLength(1)
    expect(container.textContent).toContain("en C++ et C++.")
    expect(container.querySelector("code")?.textContent).toBe("a ++b++")
    const tasks = container.querySelectorAll("li.md-task")
    expect(tasks).toHaveLength(2)
    expect(tasks[0]?.querySelector(".md-task-box:not(.md-task-done)")).not.toBeNull()
    expect(tasks[1]?.querySelector(".md-task-box.md-task-done")).not.toBeNull()
  })

  it("reads a one-line title inline: a leading > is text, not a quote", () => {
    const api = { get: vi.fn() } as any
    const { container } = render(() => (
      <MarkdownContent api={api} inline content={"> cité **gras**"} />
    ))
    expect(container.querySelector("blockquote")).toBeNull()
    expect(container.textContent).toBe("> cité gras")
  })

  it("keeps underline and strikethrough when a mention turns the message into a node tree", () => {
    registerEntityPreview({
      app: "knowledge",
      entityType: "document",
      fetch: async () => ({}),
      render: () => <div />,
    })
    const api = { get: vi.fn() } as any
    const { container } = render(() => (
      <MarkdownContent
        api={api}
        content={"++souligné++ ~~barré~~ @[Spec](knowledge:document:d1)"}
      />
    ))
    expect(container.querySelector('[data-testid="entity-preview"]')).not.toBeNull()
    expect(container.querySelector("u")?.textContent).toBe("souligné")
    expect(container.querySelector("del")?.textContent).toBe("barré")
    entityPreviewRegistry.clear()
  })

  it("upgrades a mention to a preview once its renderer registers after the message rendered", () => {
    entityPreviewRegistry.clear()
    const { container } = render(() => (
      <div>
        {renderContent(
          "**Hi** @[Alice](contacts:contact:c1) and @[Nobody](nope:thing:x1)",
          () => {},
        )}
      </div>
    ))
    const pillBefore = container.querySelector('[data-mention-ref="contacts:contact:c1"]')
    expect(pillBefore?.textContent).toContain("Alice")
    expect(container.querySelector('[data-testid="entity-preview"]')).toBeNull()

    registerEntityPreview({
      app: "contacts",
      entityType: "contact",
      fetch: async () => ({}),
      render: () => <div />,
    })

    const wrapper = container.querySelector('[data-testid="entity-preview"]')
    expect(wrapper).not.toBeNull()
    expect(
      wrapper?.querySelector('[data-mention-ref="contacts:contact:c1"]')?.textContent,
    ).toContain("Alice")
    expect(container.querySelector("strong")?.textContent).toBe("Hi")
    expect(container.querySelectorAll('[data-testid="entity-preview"]')).toHaveLength(1)
    expect(container.querySelector('[data-mention-ref="nope:thing:x1"]')?.textContent).toContain(
      "Nobody",
    )
  })

  // The iPhone drew `@Avery Shaw` as a two-line slab: the preview anchor
  // was an inline-flex role="button", which the phone tier's 44px touch floor
  // stretched. It must stay an inline box on the text line, opted out of the
  // floor (index.css gives the chip its hit area through ::after instead).
  it("keeps a previewable mention an inline box opted out of the touch floor", () => {
    entityPreviewRegistry.clear()
    registerEntityPreview({
      app: "contacts",
      entityType: "contact",
      fetch: async () => ({}),
      render: () => <div />,
    })
    const { container } = render(() => (
      <div data-shell-tier="phone">
        {renderContent("Hi @[Alice](contacts:contact:c1) there", () => {})}
      </div>
    ))
    const anchor = container.querySelector('[data-testid="entity-preview"]') as HTMLElement
    expect(anchor).not.toBeNull()
    expect(anchor.hasAttribute("data-touch-dense")).toBe(true)
    expect(anchor.classList.contains("inline")).toBe(true)
    expect(anchor.classList.contains("inline-flex")).toBe(false)
  })

  it("keeps an already rendered preview mention in place when another renderer registers", () => {
    entityPreviewRegistry.clear()
    registerEntityPreview({
      app: "contacts",
      entityType: "contact",
      fetch: async () => ({}),
      render: () => <div />,
    })
    const { container } = render(() => (
      <div>{renderContent("@[Alice](contacts:contact:c1) @[T](tickets:ticket:t1)", () => {})}</div>
    ))
    const first = container.querySelector('[data-mention-ref="contacts:contact:c1"]')
    expect(first).not.toBeNull()
    registerEntityPreview({
      app: "tickets",
      entityType: "ticket",
      fetch: async () => ({}),
      render: () => <div />,
    })
    expect(container.querySelectorAll('[data-testid="entity-preview"]')).toHaveLength(2)
    // The existing mention node was not torn down and rebuilt.
    expect(container.querySelector('[data-mention-ref="contacts:contact:c1"]')).toBe(first)
  })

  // F6. A table rendered into a narrow dock tab broke per character
  // ("RE TUR NE D"), because the prose column sets `word-break: break-word`
  // and the table was pinned to the column's width.
  it("renders a markdown table inside a scrollable wrapper with nowrap cells", () => {
    const md = ["| Status | Ref |", "| --- | --- |", "| RETURNED | AB-12 |"].join("\n")
    const { container } = render(() => <div>{renderContent(md, () => {})}</div>)

    const table = container.querySelector("table") as HTMLElement
    expect(table).toBeTruthy()
    const wrap = table.parentElement as HTMLElement
    expect(wrap.classList.contains("md-table-wrap")).toBe(true)
    expect(getComputedStyle(wrap).overflowX).toBe("auto")

    const cells = Array.from(container.querySelectorAll("th, td")) as HTMLElement[]
    expect(cells.length).toBe(4)
    for (const cell of cells) expect(getComputedStyle(cell).whiteSpace).toBe("nowrap")
    expect(container.textContent).toContain("RETURNED")
  })

  // A task description written by an agent mentions someone AND carries a
  // table: the mention takes the node-by-node path, which drew the table as
  // loose spans ("Hub Inscrits Cribbs 139" on one line).
  it("keeps a table whole beside a previewable mention", () => {
    entityPreviewRegistry.clear()
    registerEntityPreview({
      app: "contacts",
      entityType: "contact",
      fetch: async () => ({}),
      render: () => <div />,
    })
    const md =
      "Voir @[Alice](contacts:contact:c1)\n\n| Hub | Inscrits |\n| --- | ---: |\n| Cribbs | 139 |"
    const { container } = render(() => <div>{renderContent(md, () => {})}</div>)
    expect(container.querySelector('[data-testid="entity-preview"]')).not.toBeNull()
    const cells = Array.from(container.querySelectorAll("table tr td")) as HTMLElement[]
    expect(cells.map((c) => c.textContent)).toEqual(["Cribbs", "139"])
    const wrap = container.querySelector("table")?.parentElement as HTMLElement
    expect(getComputedStyle(wrap).overflowX).toBe("auto")
    expect(getComputedStyle(cells[0]!).whiteSpace).toBe("nowrap")
  })

  // F6. An agent answers with `[Client Feedback](mail:conversation:<id>)`,
  // which is how the reference reaches it. The sanitizer drops any href that
  // is not http or mailto, so the reader was left with the raw markdown on
  // screen and nothing to click.
  it("renders an entity-reference link as a chip carrying the ref", () => {
    const { container } = render(() => (
      <div>{renderContent("See [Client Feedback](mail:conversation:conv-1) please", () => {})}</div>
    ))

    const chip = container.querySelector("[data-mention-ref]") as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.getAttribute("data-mention-ref")).toBe("mail:conversation:conv-1")
    expect(chip.classList.contains("mention-pill")).toBe(true)
    expect(chip.classList.contains("mention-actionable")).toBe(true)
    expect(chip.textContent).toBe("#Client Feedback")
    // The raw markdown is gone from the reader's screen.
    expect(container.textContent).not.toContain("mail:conversation:conv-1")
    expect(container.textContent).not.toContain("](")
  })

  it("a link whose text carries the @ mention marker reads with the chip's prefix only", () => {
    const { container } = render(() => (
      <div>{renderContent("Closing [@Stock data](projects:project:p-1) now", () => {})}</div>
    ))
    const chip = container.querySelector("[data-mention-ref]") as HTMLElement
    expect(chip.getAttribute("data-mention-ref")).toBe("projects:project:p-1")
    expect(chip.textContent).toBe("#Stock data")
  })

  it("does not double the prefix when the label already carries it (a ticket handle)", () => {
    const { container } = render(() => (
      <div>
        {renderContent("Le ticket @[#ticket-6507](tickets:ticket:t1) est en attente.", () => {})}
      </div>
    ))
    const chip = container.querySelector("[data-mention-ref='tickets:ticket:t1']")
    expect(chip?.textContent).toBe("#ticket-6507")
    const { container: linked } = render(() => (
      <div>{renderContent("Voir [#ticket-6507](tickets:ticket:t1).", () => {})}</div>
    ))
    expect(linked.querySelector("[data-mention-ref='tickets:ticket:t1']")?.textContent).toBe(
      "#ticket-6507",
    )
  })

  it("leaves ordinary links alone", () => {
    const { container } = render(() => (
      <div>{renderContent("[docs](https://example.com/a) and <b@example.com>", () => {})}</div>
    ))
    const anchor = container.querySelector("a[href='https://example.com/a']")
    expect(anchor).toBeTruthy()
    expect(container.querySelector("[data-mention-ref]")).toBeNull()
  })

  it("produces the same markup a @[...] mention does, so the same click path opens it", () => {
    const fromLink = render(() => (
      <div>{renderContent("[Client Feedback](mail:conversation:conv-1)", () => {})}</div>
    ))
    const fromMention = render(() => (
      <div>{renderContent("@[Client Feedback](mail:conversation:conv-1)", () => {})}</div>
    ))
    const chip = (root: HTMLElement) => root.querySelector("[data-mention-ref]") as HTMLElement
    expect(chip(fromLink.container).outerHTML).toBe(chip(fromMention.container).outerHTML)
  })

  // A Discuss reply came back reading "[ #Client Feedback ]": the agent wrapped
  // the mention in square brackets, marked found no link (the closing bracket is
  // not followed by a paren), emitted the brackets as text, and the mention
  // matched between them. The chip was right and the punctuation around it was
  // the raw syntax.
  it("absorbs brackets wrapped around a mention, mid sentence", () => {
    const { container } = render(() => (
      <div>
        {renderContent(
          "I have read [@[Client Feedback](mail:conversation:conv-1)] and replied.",
          () => {},
        )}
      </div>
    ))
    const chip = container.querySelector("[data-mention-ref]") as HTMLElement
    expect(chip.getAttribute("data-mention-ref")).toBe("mail:conversation:conv-1")
    expect(chip.textContent).toBe("#Client Feedback")
    expect(container.textContent?.trim()).toBe("I have read #Client Feedback and replied.")
    expect(container.textContent).not.toContain("[")
    expect(container.textContent).not.toContain("]")
  })

  // A mail subject carries brackets of its own ("Re: [urgent] order"). Written
  // unescaped, marked's own link tokenizer balanced them and won, so the chip
  // rendered with a bare "@" stranded in front of it.
  it("keeps a bracketed label inside the chip, with no stray prefix left behind", () => {
    const { container } = render(() => (
      <div>
        {renderContent("About @[Re: [urgent] order](mail:conversation:conv-1) today", () => {})}
      </div>
    ))
    const chip = container.querySelector("[data-mention-ref]") as HTMLElement
    expect(chip.textContent).toBe("#Re: [urgent] order")
    expect(container.textContent?.trim()).toBe("About #Re: [urgent] order today")
  })

  // An agent that copies a CRM record's id into mention syntax draws a chip
  // that opens nothing: a ref that is no entity reference is plain text.
  it("draws a fabricated mention as its label in plain text, never a chip", () => {
    const { container } = render(() => (
      <div>{renderContent("Customer: @[Acme Instruments](crm:cmp_001) since May.", () => {})}</div>
    ))
    expect(container.querySelector("[data-mention-ref]")).toBeNull()
    expect(container.querySelector(".mention-pill")).toBeNull()
    expect(container.textContent?.trim()).toBe("Customer: Acme Instruments since May.")
  })

  it("leaves an ordinary bracketed phrase alone", () => {
    const { container } = render(() => (
      <div>{renderContent("A note [see below] about it", () => {})}</div>
    ))
    expect(container.textContent?.trim()).toBe("A note [see below] about it")
  })

  it("only treats app:entityType:id hrefs as references", () => {
    expect(isEntityRefHref("mail:conversation:conv-1")).toBe(true)
    expect(isEntityRefHref("tickets:ticket:42")).toBe(true)
    expect(isEntityRefHref("https://example.com/a:b:c")).toBe(false)
    expect(isEntityRefHref("mailto:a@b.com")).toBe(false)
    expect(isEntityRefHref("/mail/conv-1")).toBe(false)
    expect(isEntityRefHref("conv-1")).toBe(false)
  })

  // The kernel's own references carry two parts, not three, and a chip is
  // exactly what they are: `isActionableMention` already opens both.
  it("treats the two part kernel references as references too", () => {
    expect(isEntityRefHref("thread:9c3f2a10")).toBe(true)
    expect(isEntityRefHref("agent:support")).toBe(true)
    expect(isEntityRefHref("user:u1")).toBe(true)
    // Nothing else two part is: a bare word with a colon is punctuation.
    expect(isEntityRefHref("note:something")).toBe(false)
  })
})

/**
 * EVERY SCHEME THE APP KNOWS, in the renderer that draws a FINISHED turn.
 *
 * The reported break was a ticket: "[@[title](tickets:ticket:<id>)](...)", the
 * mention as a markdown link's own text, which is the form the model produces.
 * The bracket-pair rule does not match it, so the chip was drawn with the
 * link's reference left hanging after it as raw text.
 */
describe("markdown-content: every entity scheme, in both spellings", () => {
  const SCHEMES: Array<[string, string, string]> = [
    ["a ticket", "tickets:ticket:4a2a2f26-0f1e-4f1b-9b6d-1c9a7f2b3c4d", "#"],
    ["a mail conversation", "mail:conversation:c1", "#"],
    ["a project task", "projects:task:t1", "#"],
    ["a contact", "contacts:contact:k1", "#"],
    // What the composer stored when `@` still offered contacts: the kernel
    // contact's entity reference. It reads as the `#` entity chip it always
    // was, the same as a contact picked under `#` today.
    [
      "a contact picked under @ before it moved to #",
      "kernel:contact:6f1c2b3a-9d4e-4f5a-8b6c-7d8e9f0a1b2c",
      "#",
    ],
    ["a kernel user", "kernel:user:u1", "@"],
    ["a thread", "thread:9c3f2a10", "#"],
    ["an agent", "agent:support", "@"],
  ]

  for (const [name, ref, prefix] of SCHEMES) {
    for (const [shape, text] of [
      ["bare", `I read @[Title](${ref}) already.`],
      ["bracket wrapped", `I read [@[Title](${ref})] already.`],
      ["link wrapped", `I read [@[Title](${ref})](${ref}) already.`],
      ["a plain entity link", `I read [Title](${ref}) already.`],
    ] as const) {
      it(`draws ${name} written ${shape} as one chip and nothing else`, () => {
        const { container } = render(() => <div>{renderContent(text, () => {})}</div>)
        const chips = container.querySelectorAll("[data-mention-ref]")
        expect(chips.length).toBe(1)
        expect(chips[0].getAttribute("data-mention-ref")).toBe(ref)
        expect(chips[0].textContent).toBe(`${prefix}Title`)
        // Nothing of the raw syntax survives beside it.
        expect(container.textContent?.trim()).toBe(`I read ${prefix}Title already.`)
        expect(container.textContent).not.toContain(ref)
      })
    }
  }
})

// A personal agent's handle changed from `@ada` (read as the person Ada) to
// `@adas-agent`. A message written before carries the old handle as its token
// label; the chip names the agent as it is now, by id.
describe("an agent mention renders the agent's current handle", () => {
  const AGENT_ID = "6f0c2a52-6b8e-4f5e-9a59-0d3c9a1e2b7f"
  const OLD = `@[ada](agent:${AGENT_ID}) can you check the order?`

  afterEach(() => resetAgentDirectory())

  async function loadDirectory() {
    await loadAgentDirectory({
      get: async () => ({
        data: [
          { id: AGENT_ID, handle: "@adas-agent", displayName: "Personal agent", kind: "personal" },
        ],
      }),
    })
  }

  it("draws an old-label token as the current handle", async () => {
    await loadDirectory()
    const { container } = render(() => <div>{renderContent(OLD, () => {})}</div>)
    const chip = container.querySelector(`[data-mention-ref="agent:${AGENT_ID}"]`)
    expect(chip?.textContent).toBe("@adas-agent")
    expect(container.textContent).not.toContain("@ada ")
  })

  it("relabels a message rendered before the directory loaded, once it does", async () => {
    const { container } = render(() => <div>{renderContent(OLD, () => {})}</div>)
    const chip = () => container.querySelector(`[data-mention-ref="agent:${AGENT_ID}"]`)
    expect(chip()?.textContent).toBe("@ada")
    await loadDirectory()
    expect(chip()?.textContent).toBe("@adas-agent")
  })

  it("names the current handle in a list row's one-line preview", async () => {
    await loadDirectory()
    expect(previewLine(OLD, (key) => key)).toBe("@adas-agent can you check the order?")
  })
})
