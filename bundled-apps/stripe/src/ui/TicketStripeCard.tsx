// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe card in a ticket's side panel (`contributions["ticket:detail:panel"]`): the customer of
// the ticket's contact, found by the app's own context read (it asks the tickets app as the viewer).
// Hidden unless a customer is found and the viewer may read customers.
import { app } from "@liaison/host"
import { type Component, createResource } from "solid-js"
import { uiLocale } from "./i18n"
import { readPanel, StripePanelBody } from "./panel-view"
import { type PanelModel, panelModel } from "./panels-model"

/** The ticket's Stripe customer id, from the context read, or null. */
export async function ticketCustomerId(ticketId: string): Promise<string | null> {
  try {
    const r = await app.invokeTool<{ customerIds?: string[] }>("customer_context", {
      subject: { app: "tickets", entityType: "ticket", entityId: ticketId },
    })
    return r?.customerIds?.[0] ?? null
  } catch {
    return null
  }
}

export const TicketStripeCard: Component<{ ticketId: string }> = (props) => {
  const [read] = createResource(
    () => props.ticketId,
    async (id) => {
      const cid = await ticketCustomerId(id)
      return cid ? readPanel({ id: cid }) : null
    },
  )
  const model = (): PanelModel =>
    read.state === "ready" && read()
      ? panelModel("ticket", read() ?? null, uiLocale())
      : { kind: "hidden" }
  return <StripePanelBody kind="ticket" model={model()} testid="ticket-stripe-card" />
}
