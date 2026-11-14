// SPDX-License-Identifier: FSL-1.1-ALv2
//
// This app's copy in the reader's language. An app bundle does not carry the
// kernel's dictionaries, so its UI strings are keyed by their English text
// and the French lives beside them (i18n-fr.ts). The host hands over the
// reader's locale (`hostLocale`, reactive on the kernel). A string with no
// French entry falls back to English; the app's i18n test fails on any gap.
import { hostLocale } from "@liaison/host"
import { FR } from "./i18n-fr"

export type TrParams = Record<string, string | number>

function interpolate(text: string, params?: TrParams): string {
  if (!params) return text
  return text.replace(/\{\{(\w+)\}\}/g, (m, name: string) =>
    params[name] === undefined ? m : String(params[name]),
  )
}

/** The reader's locale ("en" without a host). */
export function uiLocale(): string {
  try {
    return hostLocale()
  } catch {
    return "en"
  }
}

/** `english` in the reader's language, `{{name}}` placeholders filled. */
export function tr(english: string, params?: TrParams): string {
  const text = uiLocale().startsWith("fr") ? (FR[english] ?? english) : english
  return interpolate(text, params)
}
