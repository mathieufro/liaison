// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { TicketAssignSheet } from "./TicketAssignSheet"

describe("TicketAssignSheet", () => {
  it("shows away until a date beside a teammate who is away; the list is unchanged", async () => {
    const api = {
      getEnvelope: vi.fn(async () => ({
        data: [
          {
            id: "u-morgan",
            name: "Morgan Lee",
            email: "morgan@x.test",
            away: { until: "2099-12-20" },
          },
          { id: "u-alice", name: "Alice Chen", email: "alice@x.test", away: null },
        ],
        meta: { total: 2 },
      })),
    } as any
    render(() => (
      <ApiContext.Provider value={api}>
        <TicketAssignSheet ticketId="t1" open onClose={() => {}} />
      </ApiContext.Provider>
    ))
    await waitFor(() => expect(screen.getByTestId("ticket-assign-member-u-morgan")).toBeTruthy())
    expect(screen.getByTestId("ticket-assign-away-u-morgan").textContent).toMatch(
      /away until (20 Dec|Dec 20)/,
    )
    expect(screen.queryByTestId("ticket-assign-away-u-alice")).toBeNull()
    expect(screen.getByTestId("ticket-assign-member-u-alice")).toBeTruthy()
  })
})
