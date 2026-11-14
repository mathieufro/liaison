// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  guideCoversLoaded,
  normalizeAppGuide,
  parseGuideMarkdown,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "~/modules/agent/context/app-guide"

const guide = normalizeAppGuide({
  core: "Widgets core rule.",
  sections: [
    { tools: ["search"], text: "SEARCH SECTION" },
    { tools: ["zap", "widgets__unzap"], text: "ZAP SECTION" },
  ],
})

describe("app guide parts", () => {
  it("a string guide is a core with no sections", () => {
    expect(normalizeAppGuide("plain")).toEqual({ core: "plain", sections: [] })
  })

  it("renders the core and only the sections whose tools are loaded", () => {
    const parts = selectAppGuideParts("widgets", guide, new Set(["widgets__search"]))
    expect(parts.core).toBe("Widgets core rule.")
    expect(parts.sections.map((s) => s.text)).toEqual(["SEARCH SECTION"])
    const block = renderAppGuideBlock("widgets", parts)
    expect(block).toBe("### widgets\nWidgets core rule.\n\nSEARCH SECTION")
  })

  it("a section tool may be written bare or as its sdk name", () => {
    const parts = selectAppGuideParts("widgets", guide, new Set(["widgets__unzap"]))
    expect(parts.sections.map((s) => s.key)).toEqual(["widgets#1"])
  })

  it("nothing loaded renders the core alone; all renders every section", () => {
    expect(selectAppGuideParts("widgets", guide, new Set()).sections).toEqual([])
    expect(selectAppGuideParts("widgets", guide, "all").sections.length).toBe(2)
  })

  it("a block without a core carries only its sections", () => {
    expect(renderAppGuideBlock("widgets", { sections: [{ text: "ZAP SECTION" }] })).toBe(
      "### widgets\nZAP SECTION",
    )
  })

  it("a guide that names its tools covers an exact name or a `*` prefix, nothing else", () => {
    const g = { core: "c", coveredTools: ["kernel__config_*", "kernel__request_secret"] }
    expect(guideCoversLoaded(g, ["kernel__config_mail"])).toBe(true)
    expect(guideCoversLoaded(g, ["kernel__request_secret"])).toBe(true)
    expect(guideCoversLoaded(g, ["kernel__request_scope", "kernel__configure"])).toBe(false)
    expect(guideCoversLoaded(g, [])).toBe(false)
    expect(guideCoversLoaded("plain", ["kernel__config_mail"])).toBe(false)
    expect(guideCoversLoaded({ core: "c" }, ["kernel__config_mail"])).toBe(false)
  })
})

describe("a markdown guide's sections", () => {
  const md = [
    "Core rule for every call.",
    "",
    "<!-- tools: kernel__create_role -->",
    "ROLE SECTION",
    "",
    "<!-- tools: kernel__run_on_my_computer, kernel__computer_session_read -->",
    "COMPUTER SECTION",
  ].join("\n")

  it("the text before the first marker is the core, and each marker opens a section about its tools", () => {
    expect(parseGuideMarkdown(md)).toEqual({
      core: "Core rule for every call.",
      sections: [
        { tools: ["kernel__create_role"], text: "ROLE SECTION" },
        {
          tools: ["kernel__run_on_my_computer", "kernel__computer_session_read"],
          text: "COMPUTER SECTION",
        },
      ],
    })
  })

  it("a file with no marker and no named tools stays a plain string guide", () => {
    expect(parseGuideMarkdown("Just a core.")).toBe("Just a core.")
  })

  it("a guide that names its tools also covers its sections' tools", () => {
    const parsed = parseGuideMarkdown(md, ["kernel__roles_list"])
    expect(typeof parsed === "string" ? [] : parsed.coveredTools).toEqual([
      "kernel__roles_list",
      "kernel__create_role",
      "kernel__run_on_my_computer",
      "kernel__computer_session_read",
    ])
    expect(guideCoversLoaded(parsed, ["kernel__create_role"])).toBe(true)
    expect(guideCoversLoaded(parsed, ["kernel__users_list"])).toBe(false)
  })

  it("a kernel tool's section renders with that tool loaded and not with another", () => {
    const guide = normalizeAppGuide(parseGuideMarkdown(md))
    const one = selectAppGuideParts("kernel", guide, new Set(["kernel__create_role"]))
    expect(one.sections.map((s) => s.text)).toEqual(["ROLE SECTION"])
    const other = selectAppGuideParts("kernel", guide, new Set(["kernel__threads_list"]))
    expect(other.sections).toEqual([])
  })
})
