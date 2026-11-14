// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the HTTP class of every deliberate error code the boxtal and invoicing
// apps (and the tickets ref resolver) return. An unmapped code answers 500:
// the web client shows a generic "Something went wrong" toast instead of the
// app's own message, and the watchdog pages it as a server fault. The code
// list is read from the app sources, so a new code fails here until it is
// classified in tool-error-status.ts.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { isNotConnectedToolErrorCode, statusForToolError } from "~/modules/apps/execute-tool"

const REPO = resolve(import.meta.dir, "../../../../..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === "ui" || name === "__fixtures__" || name === "node_modules") continue
      out.push(...sourceFiles(p))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

// Snake-case literals in a `code: …` / `code = …` expression that are not codes
// (a status compared in a ternary, a typeof check, a sort direction, a field name).
// `failed` is the boxtal short-code writer's own record of a batch that threw
// (product-attributes.ts), read back in the same function and never returned.
const NOT_A_CODE = new Set(["error", "asc", "desc", "tool_error", "phone", "string", "failed"])

function declaredCodes(dir: string): string[] {
  const codes = new Set<string>()
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, "utf8")
    // The expression after `code:` / `code =` (never a `code ===` comparison, which tests a
    // code another tool returned), plus ternary / fallback continuation lines.
    for (const m of text.matchAll(
      /\bcode\s*(?::|=(?!=))\s*([^,};\n]*(?:\n\s*(?:\?\?|\|\||[?:])[^,};\n]*)*)/g,
    )) {
      for (const lit of m[1]!.matchAll(/"([a-z][a-z0-9]*(?:_[a-z0-9]+)*)"/g)) {
        if (!NOT_A_CODE.has(lit[1]!)) codes.add(lit[1]!)
      }
    }
    // A local helper that takes the code first: `fail("x", ...)`, `err("x", ...)`,
    // `dateRefused("x", ...)`, `refuse("x", ...)`. The code literal is not next to `code:`, and such refusals answered
    // 500 unseen. `refuseTool` and its wrappers are not listed: the host makes those a 4xx itself.
    for (const m of text.matchAll(
      /\b(?:fail|err|dateRefused|refuse)\(\s*"([a-z][a-z0-9]*(?:_[a-z0-9]+)*)"\s*,/g,
    )) {
      if (!NOT_A_CODE.has(m[1]!)) codes.add(m[1]!)
    }
  }
  return [...codes].sort()
}

describe("statusForToolError: every deliberate app code is a non-500", () => {
  for (const app of ["boxtal", "invoicing"]) {
    const codes = declaredCodes(join(REPO, "bundled-apps", app, "src"))

    it(`${app}: the source scan finds its codes`, () => {
      expect(codes).toContain(app === "boxtal" ? "price_increased" : "no_mail_account")
      expect(codes.length).toBeGreaterThan(20)
    })

    for (const code of codes) {
      it(`${app}: ${code}`, () => {
        // A not-connected code is answered as data (200), never as an error.
        if (isNotConnectedToolErrorCode(code)) return
        expect(statusForToolError(code)).not.toBe(500)
      })
    }
  }

  it("the buyer-VAT guard's refusals are 4xx, found by the positional refuse() scan", () => {
    const codes = declaredCodes(join(REPO, "bundled-apps", "invoicing", "src"))
    for (const code of ["vat_id_invalid", "buyer_vat_id_required", "buyer_is_consumer_refused"]) {
      expect(codes).toContain(code)
      expect(statusForToolError(code)).toBe(422)
    }
    expect(statusForToolError("buyer_status_contradiction")).toBe(400)
  })

  it("tickets ref resolver codes are client errors", () => {
    expect(statusForToolError("invalid_params")).toBe(400)
    expect(statusForToolError("not_found")).toBe(404)
  })

  it("expected refusals are 4xx, so the client shows the app's message, not a generic toast", () => {
    expect(statusForToolError("price_increased")).toBe(409)
    expect(statusForToolError("offer_not_quoted")).toBe(409)
    expect(statusForToolError("sender_address_required")).toBe(422)
    expect(statusForToolError("no_mail_account")).toBe(422)
    expect(statusForToolError("like_unsupported_for_target")).toBe(422)
  })

  it("a cotation Boxtal refused for its own data is a 4xx, an upstream cotation fault stays 5xx", () => {
    expect(statusForToolError("cotation_invalid")).toBe(400)
    expect(statusForToolError("cotation_error")).toBe(502)
  })

  it("a missing permission is 403, an app turned Off 409, an unreadable app state 503", () => {
    expect(statusForToolError("forbidden")).toBe(403)
    expect(statusForToolError("collections_scope_required")).toBe(403)
    expect(statusForToolError("app_disabled")).toBe(409)
    expect(statusForToolError("app_state_unavailable")).toBe(503)
  })

  // Production: each answered 500, so a refusal the agent or the operator acts on paged
  // as a server fault (logged at error by the tool seam and the access log).
  it("a packed tick's fulfilment refusals are 4xx; a Shopify upstream fault stays 502", () => {
    expect(statusForToolError("no_tracking")).toBe(409)
    expect(statusForToolError("shopify_refused")).toBe(409)
    expect(statusForToolError("not_linked")).toBe(422)
    expect(statusForToolError("partial_without_sku")).toBe(422)
    expect(statusForToolError("shopify_error")).toBe(502)
  })

  // A person typing a wrong date: refused with a plain message, nothing written. Each answered 500,
  // with the agent reading "HTTP 500" and the watchdog counting a fault.
  it("the invoicing date refusals are 4xx", () => {
    expect(statusForToolError("issued_at_invalid")).toBe(400)
    expect(statusForToolError("issue_date_in_future")).toBe(422)
    expect(statusForToolError("issue_date_before_last_number")).toBe(409)
    expect(statusForToolError("issue_date_crosses_number_year")).toBe(409)
    expect(statusForToolError("issue_date_breaks_number_order")).toBe(409)
    expect(statusForToolError("issue_date_set_by_draft_order")).toBe(409)
  })

  it("kernel and database tool refusals are 4xx: a bad read name, raw query off, not found", () => {
    expect(statusForToolError("unknown_read")).toBe(400)
    expect(statusForToolError("disabled")).toBe(403)
    expect(statusForToolError("NOT_FOUND")).toBe(404)
  })

  it("a company delete refused while accounts or a live recurring schedule hold it is 409", () => {
    expect(statusForToolError("company_has_accounts")).toBe(409)
    expect(statusForToolError("company_has_schedules")).toBe(409)
  })

  it("a person delete refused while a live recurring schedule bills them is 409", () => {
    expect(statusForToolError("contact_has_schedules")).toBe(409)
  })

  it("still answers 500 for a code nobody declared", () => {
    expect(statusForToolError("something_unexpected")).toBe(500)
  })
})
