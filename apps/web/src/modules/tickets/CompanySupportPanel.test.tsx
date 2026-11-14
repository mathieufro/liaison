// SPDX-License-Identifier: FSL-1.1-ALv2
// The Support section of a company's page: the company's open tickets, each
// opening its ticket, and its own line when the read fails.
import { fireEvent, render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  openEntity: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({ post: mocks.post }) }))
vi.mock("~/modules/shell/entity-opener", () => ({ openEntity: mocks.openEntity }))

import { CompanySupportPanel } from "./CompanySupportPanel"

beforeEach(() => {
  mocks.post.mockReset()
  mocks.openEntity.mockReset()
})

describe("CompanySupportPanel", () => {
  it("lists the company's open tickets and opens the one clicked", async () => {
    mocks.post.mockResolvedValue({
      items: [
        {
          id: "tk1",
          handle: "T-12",
          subject: "Lamp flickers",
          status: "open",
          contactName: "Ana Buyer",
        },
      ],
    })
    const { findByTestId } = render(() => <CompanySupportPanel entityId="co-lumen" />)
    const row = await findByTestId("company-support-panel.ticket-tk1")
    expect(row.textContent).toContain("T-12 Lamp flickers")
    expect(row.textContent).toContain("Ana Buyer")
    expect(mocks.post).toHaveBeenCalledWith("/apps/run-tool", {
      toolName: "tickets:company_tickets",
      params: { companyId: "co-lumen" },
    })
    fireEvent.click(row)
    expect(mocks.openEntity).toHaveBeenCalledWith(
      expect.anything(),
      "tickets",
      "ticket",
      "tk1",
      "T-12 Lamp flickers",
    )
  })

  it("says so when no ticket is open, and has its own line when the read fails", async () => {
    mocks.post.mockResolvedValueOnce({ items: [] })
    const empty = render(() => <CompanySupportPanel entityId="co-quiet" />)
    expect((await empty.findByTestId("company-support-panel.empty")).textContent).toBe(
      "No open ticket from this company's people.",
    )
    empty.unmount()
    mocks.post.mockRejectedValueOnce(new Error("down"))
    const failed = render(() => <CompanySupportPanel entityId="co-lumen" />)
    expect((await failed.findByTestId("company-support-panel.error")).textContent).toBe(
      "Could not read this company's tickets.",
    )
  })
})
