// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one quiet line that says the company on screen is an example: on the
// door's company step, in the welcome popup and on Home. It names the world's
// own company (`<copy>.companyExample`), so it takes the world it is about.
// Where that world is not known (the read failed, or the org is not a
// visitor's, as the reserved review org is not) there is no line: it never
// names another world's company.
import type { DemoWorldId } from "@liaison/shared"
import { type Component, Show } from "solid-js"
import { demoWorldId } from "~/modules/demo/demo-world"
import { doorCompanyOf } from "~/modules/demo/door-company"
import { useI18n } from "~/modules/i18n/i18n-context"

export interface DemoExampleLineProps {
  /** The world the line is about; the visitor workspace's own world when absent. */
  world?: DemoWorldId | null
  class?: string
}

export const DemoExampleLine: Component<DemoExampleLineProps> = (props) => {
  const i18n = useI18n()
  const world = () => props.world ?? demoWorldId()
  return (
    <Show when={world()}>
      {(id) => (
        <p data-testid="demo-example-line" class={props.class}>
          {i18n.t(`${doorCompanyOf(id()).copyKey}.companyExample`)}
        </p>
      )}
    </Show>
  )
}
