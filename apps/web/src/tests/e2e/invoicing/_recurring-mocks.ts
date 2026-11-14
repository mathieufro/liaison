// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tool answers for the recurring invoicing screens: a list of schedules (one billed besides a
// card processor's subscription, one paused, one with a long customer line), an issued month-end run, and
// shared checks that nothing on a screen scrolls sideways and every control is big enough to tap.
import type { Page } from "@playwright/test"
import { expect } from "../fixtures/test"

const line = (description: string, unit: number) => [
  { description, qty: 1, unit_price_minor: unit, vat_bp: 2000 },
]

export function recurringMocks(): Record<string, unknown> {
  const schedules = [
    ...Array.from({ length: 7 }, (_, i) => ({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      issuer_profile_id: "issuer",
      contact_id: `00000000-0000-4000-9000-00000000000${i}`,
      status: "active",
      repeats: "month",
      billing_day: "last",
      next_issue_on: "2026-11-30",
      next_draft_on: "2026-11-27",
      paused_until: null,
      paid_by: "transfer",
      issue_mode: "review",
      version: 1,
      lines: line(
        i === 0
          ? "Société Hôtelière des Thermes et du Grand Lac de Haute-Savoie, conciergerie, {period}"
          : "Team plan, {period}",
        49000,
      ),
      bills_other_than_stripe: i === 1 ? "On-site training days" : null,
    })),
    {
      id: "00000000-0000-4000-8000-000000000009",
      issuer_profile_id: "issuer",
      contact_id: "00000000-0000-4000-9000-000000000009",
      status: "paused",
      repeats: "month",
      billing_day: "last",
      next_issue_on: "2027-04-30",
      next_draft_on: "2027-04-27",
      paused_until: "2027-04-01",
      paid_by: "card_link",
      issue_mode: "review",
      version: 1,
      lines: line("Starter plan, {period}", 14900),
      bills_other_than_stripe: null,
    },
  ]
  const run = {
    status: "completed",
    run: {
      id: "run-nov",
      status: "issued",
      issue_on: "2026-11-30",
      latest_issue_on: "2026-11-30",
      period: "November 2026",
      approved_by: null,
      approved_at: null,
      auto: false,
    },
    rows: ["0463", "0464", "0465"].map((n, i) => ({
      item_id: `item-${i}`,
      draft_id: null,
      document_id: `00000000-0000-4000-a000-00000000000${i}`,
      state: "issued",
      customer:
        i === 0 ? "Société Hôtelière des Thermes et du Grand Lac de Haute-Savoie" : "Maison Arlon",
      account_manager: null,
      net_minor: "49000",
      vat_minor: "9800",
      total_minor: "58800",
      currency: "EUR",
      number: `F-2026-${n}`,
      updated_at: null,
      latest_change: null,
      flags: [],
      failure: null,
      einvoice_state: i === 2 ? "refused" : "sent",
      collection_state: i === 1 ? "reported" : null,
      payment_status: i === 1 ? "paid" : "unpaid",
    })),
    message: "",
  }
  return {
    "invoicing:recurring_list": { rows: schedules, nextCursor: null, nextRun: "2026-11-30" },
    "invoicing:recurring_run_get": run,
  }
}

/** Every recurring tool the screens read answers from the mocks above. */
export async function installRecurringMocks(page: Page): Promise<void> {
  await page.addInitScript((m: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    let real: any
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    Object.defineProperty(window as any, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const key = `${appName}:${toolName}`
            if (Object.hasOwn(m, key)) return m[key]
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${key}`)
          },
        }
      },
    })
  }, recurringMocks())
}

/** Neither the page nor anything inside the screen reaches past the right edge. */
export async function expectNoSidewaysScroll(page: Page, testid: string): Promise<void> {
  const wide = await page.evaluate((id) => {
    const out: string[] = []
    if (document.documentElement.scrollWidth > window.innerWidth + 1)
      out.push(`page ${document.documentElement.scrollWidth}`)
    const root = document.querySelector(`[data-testid="${id}"]`)
    for (const el of Array.from(root?.querySelectorAll("*") ?? [])) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > window.innerWidth + 1)
        out.push(`${el.tagName} right edge ${Math.round(r.right)}`)
    }
    return out.slice(0, 5)
  }, testid)
  expect(wide).toEqual([])
}

/** On a phone every button and link of the screen is at least 44 px tall. */
export async function expectTapSize(page: Page, testid: string): Promise<void> {
  const small = await page.evaluate((id) => {
    const root = document.querySelector(`[data-testid="${id}"]`)
    const out: string[] = []
    for (const el of Array.from(root?.querySelectorAll("button, a") ?? [])) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height < 44)
        out.push(
          `${el.getAttribute("data-testid") ?? el.textContent?.trim()} ${Math.round(r.height)}`,
        )
    }
    return out.slice(0, 8)
  }, testid)
  expect(small).toEqual([])
}
