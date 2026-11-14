// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe rail: Home, Customers, and the Stripe dashboard as an external link, under a dot that says
// whether the connection is healthy. Calm: green, amber or grey, never a count or an alarm.
import { app, currentPath } from "@liaison/host"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  type DotTone,
  dashboardShown,
  dashboardUrl,
  dotTone,
  dotWord,
  type HomeLoad,
  type PageKind,
  pageKind,
} from "./home-model"
import { tr } from "./i18n"

export { dotTone }

export function sidebarRows(mode: string | undefined) {
  return {
    nav: [
      { label: tr("Home"), href: "/stripe", id: "home" },
      { label: tr("Customers"), href: "/stripe/customers", id: "customers" },
    ],
    external: { label: tr("Stripe dashboard"), href: dashboardUrl(mode) },
  }
}

const DOT: Record<DotTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  muted: "bg-text-tertiary",
}

const isActive = (path: string, href: string) =>
  href === "/stripe" ? path === href : path === href || path.startsWith(`${href}/`)

export const StripeSidebar: Component = () => {
  const [kind, setKind] = createSignal<PageKind>("not_connected")
  const [mode, setMode] = createSignal<string | undefined>(undefined)
  // The demo's stand-in install has no Stripe dashboard: the link is not rendered.
  const [standIn, setStandIn] = createSignal(false)
  const [path, setPath] = createSignal(currentPath().replace(/\?.*$/, ""))
  onMount(() => {
    void app
      .invokeTool<HomeLoad>("home_load", {})
      .then((l) => {
        setKind(pageKind(l))
        setMode(l?.connection.mode)
        setStandIn(!dashboardShown(l))
      })
      .catch(() => {})
    const onChange = () => setPath(currentPath().replace(/\?.*$/, ""))
    window.addEventListener("popstate", onChange)
    onCleanup(() => window.removeEventListener("popstate", onChange))
  })
  const rows = () => sidebarRows(mode())
  return (
    <nav data-testid="stripe-sidebar" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <span
          data-testid="stripe-sidebar-dot"
          data-tone={dotTone(kind())}
          class={`h-1.5 w-1.5 rounded-full ${DOT[dotTone(kind())]}`}
          aria-hidden="true"
        />
        <span class="text-[12.5px] font-semibold text-text">{tr("Stripe")}</span>
        <span data-testid="stripe-sidebar-state" class="ml-auto text-[11.5px] text-text-tertiary">
          {dotWord(kind())}
        </span>
      </div>
      <div class="flex-1 overflow-y-auto px-2 py-3">
        <ul class="flex flex-col gap-0.5">
          <For each={rows().nav}>
            {(r) => (
              <li>
                <a
                  href={r.href}
                  data-testid={`stripe-sidebar-link-${r.id}`}
                  aria-current={isActive(path(), r.href) ? "page" : undefined}
                  class={`flex min-h-11 items-center rounded-md px-3 text-[12.5px] transition-colors md:min-h-8 ${
                    isActive(path(), r.href)
                      ? "bg-surface-active font-medium text-text"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text"
                  }`}
                >
                  {r.label}
                </a>
              </li>
            )}
          </For>
        </ul>
        <Show when={!standIn()}>
          <div class="mt-3 border-t border-border-subtle pt-3">
            <a
              href={rows().external.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="stripe-sidebar-dashboard"
              class="flex min-h-11 items-center justify-between rounded-md px-3 text-[12px] text-text-tertiary hover:bg-surface-hover hover:text-text md:min-h-8"
            >
              <span>{rows().external.label}</span>
              <span aria-hidden="true">{"↗"}</span>
            </a>
          </div>
        </Show>
      </div>
    </nav>
  )
}
