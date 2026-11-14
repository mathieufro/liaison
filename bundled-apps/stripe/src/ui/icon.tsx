// SPDX-License-Identifier: FSL-1.1-ALv2
//
// StripeAppIcon: the activity bar icon, a card. Drawn inline so the bundle pulls no icon library.
import type { Component } from "solid-js"

export const StripeAppIcon: Component<{ size?: number }> = (props) => {
  const s = props.size ?? 16
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </svg>
  )
}
