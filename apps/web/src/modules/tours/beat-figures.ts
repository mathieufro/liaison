// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The figures a step's copy names (`{{pastDue}}`), read when the step shows
 * from the tool its `figures` names, the one the screen behind it reads, and
 * formatted in the person's language. Until they are read, or when the read
 * fails, each shows as an ellipsis: never a figure from elsewhere.
 */
import { type EffectiveBeat, pickTourFigures, type TourFigure } from "@liaison/shared"
import { createResource } from "solid-js"
import { currentLocale } from "~/modules/i18n/i18n-context"
import { readTourTool } from "./tour-store"

const PENDING = "…"

export function formatTourFigure(figure: TourFigure, locale: string): string {
  if (figure.kind === "count") return new Intl.NumberFormat(locale).format(figure.n)
  return new Intl.NumberFormat(locale, { style: "currency", currency: figure.currency }).format(
    figure.minor / 100,
  )
}

/** The copy variables of `beat()`'s figures: formatted, or an ellipsis each until read. */
export function createBeatFigures(beat: () => EffectiveBeat): () => Record<string, string> {
  const [read] = createResource(
    () => {
      const b = beat()
      return b.figures ? { id: b.id, figures: b.figures } : false
    },
    async ({ figures }) => {
      try {
        return pickTourFigures(figures, await readTourTool(figures.tool, figures.params ?? {}))
      } catch {
        return null
      }
    },
  )
  return () => {
    const figures = beat().figures
    if (!figures) return {}
    const values = read.loading ? null : read()
    const locale = currentLocale()
    return Object.fromEntries(
      Object.keys(figures.vars).map((name) => {
        const value = values?.[name]
        return [name, value ? formatTourFigure(value, locale) : PENDING]
      }),
    )
  }
}
