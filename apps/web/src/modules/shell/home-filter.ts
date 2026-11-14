// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What Home's main panel shows (D21): the whole overview, or the slice the
// sidebar (or a phone chip) picked. Shared by the sidebar, the phone chips and
// the panel, with the sections model they all read, so a count and the rows
// it opens come from one computation.

import { createMemo, createRoot, createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { attentionStore } from "~/modules/shell/attention-store"
import { currentHomeViewer } from "~/modules/shell/home-action-count"
import { buildHomeSections, type HomeFilter, OVERVIEW } from "~/modules/shell/home-sections"

const [homeFilter, setHomeFilterSignal] = createSignal<HomeFilter>(OVERVIEW)

export { homeFilter }

export function setHomeFilter(next: HomeFilter): void {
  setHomeFilterSignal(next)
}

/** The sidebar model for the signed-in viewer, kept live by the attention store. */
export const homeSections = createRoot(() =>
  createMemo(() =>
    buildHomeSections(attentionStore.items, {
      viewer: currentHomeViewer(),
    }),
  ),
)

onSessionTeardown(() => setHomeFilterSignal(OVERVIEW))
