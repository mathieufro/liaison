// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The features switched on inside each app for this workspace, read from
// `GET /api/apps/features` with the shell's app list and read again when the
// server broadcasts `kernel:org_app:update`. What is not listed is off, including
// before the first answer: a settings section or tab type naming a feature stays
// away until the server says it is on. A tab already open keeps its registration
// and resolves to the unavailable notice, as an Off app's tab does.
import { createSignal } from "solid-js"

const [enabledFeatures, setEnabledFeatures] = createSignal<ReadonlySet<string>>(new Set())

const featureKey = (app: string, feature: string): string => `${app}:${feature}`

/** Reactive: is this feature of this app off? Something that names no feature never is. */
export function isFeatureOff(appId: string | undefined, feature: string | undefined): boolean {
  if (!feature) return false
  return !appId || !enabledFeatures().has(featureKey(appId, feature))
}

/** Replace the set (the feed below, session teardown, tests). */
export function setEnabledOrgFeatures(list: ReadonlyArray<{ app: string; feature: string }>): void {
  setEnabledFeatures(new Set(list.map((f) => featureKey(f.app, f.feature))))
}

function isFeatureRow(row: unknown): row is { app: string; feature: string } {
  const r = row as { app?: unknown; feature?: unknown } | null
  return typeof r?.app === "string" && typeof r.feature === "string"
}

/** Read the feed. A failed read keeps the last answer; the next sync tries again. */
export async function loadOrgFeatures(url: string, bearer: string): Promise<void> {
  try {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    })
    if (!res.ok) return
    const data = ((await res.json()) as { data?: unknown }).data
    if (Array.isArray(data)) setEnabledOrgFeatures(data.filter(isFeatureRow))
  } catch {
    // Network failure: what is known stands.
  }
}
