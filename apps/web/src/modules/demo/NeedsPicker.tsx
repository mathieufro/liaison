// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "What do you want to see agents do?" on the demo door.
//
// A grid of tiles, one per need, plus "Everything". Each tile carries the app's
// icon and colour, a short name and the minutes the scenario takes; the
// one-line description shows from lg up only, so a phone sees a calm two-column
// grid. Several may be picked; the ORDER of the picks is the order the guided
// scenarios run in, so each picked tile shows its rank (1, 2, 3...).
// The tiles are the world's seven (`DEMO_WORLD_NEEDS[world]`, the products
// world until the door says otherwise). "Everything" picks them in that order, and
// pressing it again clears them. It is the same size as the other tiles but
// inverted (a dark fill, its icon square inverted too, and a "Select all" pill
// in its top-right corner), so it reads as a control over the other tiles
// rather than as an eighth scenario. Once picked it takes the accent fill and
// the pill reads "All selected" with a check.
import {
  DEMO_DEFAULT_WORLD,
  DEMO_WORLD_NEEDS,
  type DemoNeed,
  type DemoWorldId,
} from "@liaison/shared"
import {
  BookOpen,
  Check,
  Code,
  CreditCard,
  FileText,
  FolderKanban,
  Layers,
  Mail,
  MessageSquare,
  ShoppingBag,
  Ticket,
} from "lucide-solid"
import { type Component, For, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { appPillVars, appSquareColor } from "~/modules/shell/app-color"

export interface NeedsPickerProps {
  /** The world whose seven needs are listed; `products` when absent. */
  world?: DemoWorldId
  value: DemoNeed[]
  onChange: (next: DemoNeed[]) => void
}

/** Toggle one need, keeping the pick order of the others. */
export function toggleNeed(current: readonly DemoNeed[], need: DemoNeed): DemoNeed[] {
  return current.includes(need) ? current.filter((n) => n !== need) : [...current, need]
}

/** "Everything": the world's needs in tile order, or none when all are picked. */
export function toggleEverything(
  current: readonly DemoNeed[],
  world: DemoWorldId = DEMO_DEFAULT_WORLD,
): DemoNeed[] {
  const all = DEMO_WORLD_NEEDS[world]
  return current.length === all.length ? [] : [...all]
}

/** About how long each guided scenario takes, in minutes. */
export const NEED_MINUTES: Readonly<Record<DemoNeed, number>> = {
  support: 3,
  projects: 3,
  chat: 3,
  sales: 4,
  commerce: 3,
  money: 3,
  client: 4,
  dev: 3,
  knowledge: 3,
}

/**
 * The minutes a set of picks takes, end to end. A world's own scenario can run
 * longer than the products one it replaces; today only the two world-specific
 * needs differ from the rest, and they carry their own figure above.
 */
export function needsMinutes(needs: readonly DemoNeed[]): number {
  return needs.reduce((total, need) => total + NEED_MINUTES[need], 0)
}

/** The app whose icon and colour a need's tile wears, so the door reads like the product. */
export const NEED_LOOK: Readonly<
  Record<DemoNeed, { app: string; icon: Component<{ size?: number }> }>
> = {
  support: { app: "tickets", icon: Ticket },
  projects: { app: "projects", icon: FolderKanban },
  chat: { app: "chat", icon: MessageSquare },
  sales: { app: "crm", icon: Mail },
  commerce: { app: "shopify", icon: ShoppingBag },
  money: { app: "stripe", icon: CreditCard },
  client: { app: "agreements", icon: FileText },
  dev: { app: "dev-sessions", icon: Code },
  knowledge: { app: "knowledge", icon: BookOpen },
}

/** The app id whose colour stands for a need (tile, rank badge, the chips on step 2). */
export function needAppId(need: DemoNeed): string {
  return NEED_LOOK[need].app
}

const tileBase =
  "relative flex h-full min-h-0 w-full min-w-0 flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:min-h-[120px] lg:gap-2 lg:p-3.5"
const tileOff = "border-border bg-bg hover:border-border-strong"
const iconBase = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"

/** One tile: the icon square, the name, the line saying what it shows (lg+), the minutes. */
const Tile: Component<{
  testid: string
  key: string
  pressed: boolean
  onPress: () => void
  name: string
  desc: string
  minutes: string
  class: string
  style?: JSX.CSSProperties
  icon: JSX.Element
  badge?: JSX.Element
}> = (props) => (
  <li class="min-w-0">
    <button
      type="button"
      data-testid={props.testid}
      aria-pressed={props.pressed}
      onClick={() => props.onPress()}
      class={`${tileBase} ${props.class}`}
      style={props.style}
    >
      {props.icon}
      <span
        data-testid={`demo-needs-name-${props.key}`}
        class="text-[13.5px] font-semibold leading-snug"
      >
        {props.name}
      </span>
      <span
        data-testid={`demo-needs-desc-${props.key}`}
        class="hidden text-[12px] leading-snug opacity-80 lg:block"
      >
        {props.desc}
      </span>
      <span class="mt-auto font-mono text-[11.5px] opacity-70">{props.minutes}</span>
      {props.badge}
    </button>
  </li>
)

export const NeedsPicker: Component<NeedsPickerProps> = (props) => {
  const i18n = useI18n()
  const rank = (need: DemoNeed) => props.value.indexOf(need) + 1
  const world = () => props.world ?? DEMO_DEFAULT_WORLD
  const needs = () => DEMO_WORLD_NEEDS[world()]
  const everything = () => props.value.length === needs().length

  return (
    <ul
      data-testid="demo-needs-list"
      aria-label={i18n.t("kernel.demo.entryTitle")}
      class="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-2.5"
    >
      <For each={needs()}>
        {(need) => {
          const look = NEED_LOOK[need]
          const Icon = look.icon
          return (
            <Tile
              testid={`demo-needs-${need}`}
              key={need}
              pressed={rank(need) > 0}
              onPress={() => props.onChange(toggleNeed(props.value, need))}
              name={i18n.t(`kernel.demo.needShort.${need}`)}
              desc={i18n.t(`kernel.demo.needDesc.${need}`)}
              minutes={i18n.t("kernel.demo.pickMinutes", { minutes: NEED_MINUTES[need] })}
              // Picked, the tile takes its app's pill colours (theme-aware via .app-pill).
              class={rank(need) > 0 ? "app-pill" : `${tileOff} text-text`}
              style={rank(need) > 0 ? appPillVars(look.app) : undefined}
              icon={
                <span
                  aria-hidden="true"
                  class={`${iconBase} text-white`}
                  style={{ "background-color": appSquareColor(look.app) }}
                >
                  <Icon size={16} />
                </span>
              }
              badge={
                <Show when={rank(need) > 0}>
                  <span
                    data-testid={`demo-needs-rank-${need}`}
                    class="absolute right-2.5 top-2.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[10.5px] font-semibold text-white"
                    style={{ "background-color": appSquareColor(look.app) }}
                  >
                    {rank(need)}
                  </span>
                </Show>
              }
            />
          )
        }}
      </For>
      <Tile
        testid="demo-needs-all"
        key="all"
        pressed={everything()}
        onPress={() => props.onChange(toggleEverything(props.value, world()))}
        name={i18n.t("kernel.demo.needEverything")}
        desc={i18n.t("kernel.demo.needDesc.everything")}
        minutes={i18n.t("kernel.demo.pickMinutes", {
          minutes: needsMinutes(needs()),
        })}
        class={
          everything()
            ? "border-accent bg-accent text-accent-foreground"
            : // Not selected, it reads as every other tile off: never the inverted, selected look.
              `${tileOff} text-text`
        }
        icon={
          <span
            aria-hidden="true"
            class={`${iconBase} ${everything() ? "bg-accent-foreground text-accent" : "bg-surface-sunken text-text"}`}
          >
            <Layers size={16} />
          </span>
        }
        badge={
          <span
            data-testid="demo-needs-all-pill"
            class="absolute right-2.5 top-2.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-current px-2 py-px text-[11px] font-semibold lg:right-3 lg:top-3 lg:text-[12px]"
          >
            <Show when={everything()} fallback={i18n.t("kernel.demo.needSelectAll")}>
              <span data-testid="demo-needs-all-check" aria-hidden="true" class="inline-flex">
                <Check size={12} />
              </span>
              {i18n.t("kernel.demo.needAllSelected")}
            </Show>
          </span>
        }
      />
    </ul>
  )
}
