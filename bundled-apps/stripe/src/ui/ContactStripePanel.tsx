// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe card on a contact's page (`slots.contact_detail`): the customer linked to this contact,
// its plan and masked card, or an invitation to link one. The kernel lists it only for a viewer
// holding the customers read scope.
import type { Component } from "solid-js"
import { StripePanelBody, useStripePanel } from "./panel-view"
import { panelArgs } from "./panels-model"

export const ContactStripePanel: Component<{ entityId?: string }> = (props) => {
  const model = useStripePanel("contact", () =>
    props.entityId ? panelArgs("contact", props.entityId) : undefined,
  )
  return <StripePanelBody kind="contact" model={model()} testid="contact-stripe-panel" />
}
