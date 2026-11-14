// SPDX-License-Identifier: FSL-1.1-ALv2
// Each software-world tour played to its end by a scripted run: every `do` beat
// completes on the event its binding names (built from the binding itself, with
// the entities the earlier beats recorded), every world beat names an injector
// the registry holds for that world, and the tour ends on its last beat.
import { describe, expect, it } from "bun:test"
import {
  matchEntityRef,
  RUN_CONVERSATION,
  scenarioNeedOf,
  type Tour,
  type TourBeat,
  type TourEventBinding,
  WORLD_SCENARIO_TOURS,
} from "@liaison/shared"
import type { AppEvent } from "~/infra/events/event-bus"
import { worldInjectors } from "~/modules/demo/world/registry"
import { bindingMatches } from "~/modules/tours/consumer"

const SOFTWARE_TOURS = WORLD_SCENARIO_TOURS.filter(
  (t) => t.world === "saas" && scenarioNeedOf(t.id) !== "money",
)

/** Put `value` at the dotted `path` of `target` (numeric parts make arrays). */
function setAt(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  let at: Record<string, unknown> = target
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1
    if (last) {
      at[part] = value
      return
    }
    const nextIsIndex = /^\d+$/.test(parts[i + 1] ?? "")
    const next = at[part] ?? (nextIsIndex ? [] : {})
    at[part] = next
    at = next as Record<string, unknown>
  }
}

/** The event that satisfies `binding`, given what the earlier beats recorded. */
function eventFor(binding: TourEventBinding, created: Record<string, string>): AppEvent {
  const data: Record<string, unknown> = {}
  for (const [path, expected] of Object.entries(binding.match ?? {})) {
    const ref = typeof expected === "string" ? matchEntityRef(expected) : null
    const value = ref === null ? (Array.isArray(expected) ? expected[0] : expected) : created[ref]
    setAt(data, path, value)
  }
  return {
    app: binding.app,
    entity: binding.entity,
    action: binding.action,
    entityId: binding.sameEntityAs ? created[binding.sameEntityAs] : crypto.randomUUID(),
    orgId: "org",
    actorId: "owner",
    actorType: "user",
    data,
    ...(binding.causedBy ? { metadata: { turnMessageId: created[binding.causedBy] } } : {}),
  } as unknown as AppEvent
}

/** Play `tour` beat by beat; returns the beats played, in order. */
function play(tour: Tour): string[] {
  // The person's one conversation with their agent exists before any beat.
  const created: Record<string, string> = { [RUN_CONVERSATION]: crypto.randomUUID() }
  const played: string[] = []
  for (const beat of tour.beats as readonly TourBeat[]) {
    created[beat.id] = crypto.randomUUID()
    if (beat.kind === "world") {
      const injector = worldInjectors().get(beat.injector ?? "")
      expect(injector, `${tour.id}/${beat.id}: injector ${beat.injector}`).toBeDefined()
      expect(injector?.world, `${tour.id}/${beat.id}`).toBe(tour.world)
    }
    if (beat.kind === "do" && beat.event) {
      const event = eventFor(beat.event, created)
      expect(bindingMatches(beat.event, event, created, true), `${tour.id}/${beat.id}`).toBe(true)
    }
    played.push(beat.id)
  }
  return played
}

describe("the software world's tours, played by a scripted run", () => {
  it("each software tour runs to completion with a scripted model", () => {
    expect(SOFTWARE_TOURS.map((t) => scenarioNeedOf(t.id))).toEqual([
      "support",
      "projects",
      "chat",
      "sales",
      "dev",
      "knowledge",
    ])
    for (const tour of SOFTWARE_TOURS) {
      const played = play(tour)
      expect(played).toEqual(tour.beats.map((b) => b.id))
      expect(played.at(-1)).toBe("done")
    }
  })

  it("an event of another app or another approval tool completes none of them", () => {
    for (const tour of SOFTWARE_TOURS) {
      const created: Record<string, string> = Object.fromEntries(
        [RUN_CONVERSATION, ...tour.beats.map((b) => b.id)].map((id) => [id, crypto.randomUUID()]),
      )
      for (const beat of tour.beats) {
        if (beat.kind !== "do" || !beat.event) continue
        const stray = eventFor(beat.event, created)
        expect(
          bindingMatches(
            beat.event,
            { ...stray, app: "someone-elses-app" } as AppEvent,
            created,
            true,
          ),
        ).toBe(false)
      }
    }
  })
})
