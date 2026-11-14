// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Every tool that hands the agent text a third party wrote marks the turn tainted, and every
// ungated tool with an outward channel is parked after that. A new tool of either kind that is not
// listed here is a review question, not a silent default.
const API_APPS = join(import.meta.dir, "..", "apps")
const BUNDLED = join(import.meta.dir, "..", "..", "..", "..", "bundled-apps")

function tools(path: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(path, "utf8")).tools
}

const TAINT_SOURCES: Array<[string, string[]]> = [
  [join(API_APPS, "mail", "app.manifest.json"), ["search", "read"]],
  [join(API_APPS, "tickets", "app.manifest.json"), ["search", "get"]],
  [join(API_APPS, "calendar", "app.manifest.json"), ["list_events", "search_events"]],
  [
    join(BUNDLED, "gitlab", "app.manifest.json"),
    [
      "gitlab_list_issues",
      "gitlab_list_merge_requests",
      "gitlab_get_merge_request",
      "gitlab_get_commit",
      "gitlab_read_file",
      "gitlab_search",
    ],
  ],
  [
    join(BUNDLED, "github", "app.manifest.json"),
    [
      "github_list_commits",
      "github_get_commit",
      "github_list_pull_requests",
      "github_get_pull_request",
      "github_list_issues",
      "github_read_file",
      "github_search",
    ],
  ],
  [join(BUNDLED, "google-drive", "app.manifest.json"), ["search", "read"]],
  [join(BUNDLED, "database", "app.manifest.json"), ["db_read", "db_query"]],
  [
    join(BUNDLED, "shopify", "app.manifest.json"),
    ["orders_search", "orders_get", "customers_search", "customers_get", "draft_orders_get"],
  ],
  [join(BUNDLED, "social", "app.manifest.json"), ["findings_list", "dm_list", "dm_get"]],
  [join(BUNDLED, "ads", "app.manifest.json"), ["graph_get", "google_search_terms"]],
  [join(BUNDLED, "calls", "app.manifest.json"), ["calls_segments_since", "calls_list"]],
  [join(BUNDLED, "ads", "app.manifest.json"), ["graph_get", "google_search_terms"]],
]

describe("taint sources", () => {
  for (const [path, names] of TAINT_SOURCES) {
    for (const name of names) {
      it(`${path.split("/").slice(-2, -1)[0]}:${name} sets the taint flag`, () => {
        expect(tools(path)[name]?.taintSource).toBe(true)
      })
    }
  }
})

describe("tools with an outward channel", () => {
  it("tickets csat.request and drive upload are externalEffect", () => {
    expect(
      tools(join(API_APPS, "tickets", "app.manifest.json"))["csat.request"]?.externalEffect,
    ).toBe(true)
    expect(tools(join(BUNDLED, "google-drive", "app.manifest.json")).upload?.externalEffect).toBe(
      true,
    )
  })

  it("minting an API key is always a human decision", () => {
    expect(tools(join(API_APPS, "tickets", "app.manifest.json"))["apiKeys.create"]?.gated).toBe(
      true,
    )
  })
})
