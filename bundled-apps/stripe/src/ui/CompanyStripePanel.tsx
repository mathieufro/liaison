// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe card in the Money group of a company's page (`slots.company_detail`): the customer linked
// to this company with a "Past due" badge when its subscription is, or an invitation to link one.
import type { Component } from "solid-js"
import { StripePanelBody, useStripePanel } from "./panel-view"
import { panelArgs } from "./panels-model"

export const CompanyStripePanel: Component<{ entityId?: string }> = (props) => {
  const model = useStripePanel("company", () =>
    props.entityId ? panelArgs("company", props.entityId) : undefined,
  )
  return <StripePanelBody kind="company" model={model()} testid="company-stripe-panel" />
}
