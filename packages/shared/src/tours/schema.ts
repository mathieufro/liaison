// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Guided tour format. A tour walks a person through the real app as a list of
 * beats:
 *   - `show`: point at one element (`anchor`, a `data-testid`) and explain it;
 *     the person moves on with Next.
 *   - `do`:   ask the person to do something; the beat completes on a server
 *     product EVENT (never on a click), and carries an `autoplay` script the
 *     engine plays for "Do it for me".
 *   - `world`: a live event injected into a demo org (`injector`); refused
 *     outside demo orgs, so `effectiveBeats` drops it there.
 *
 * Tour copy is never inline: `title` / `body` / `summary` are keys in the
 * `tours` i18n namespace (`tours.<app>.<tour>.<…>`).
 *
 * Definitions live in this package, one folder per owning app, and are imported
 * by the web (the engine) and the API (completion binding, routes, CLI).
 */
import { z } from "zod"
import { DEMO_DEFAULT_WORLD, DEMO_WORLDS, type DemoWorldId } from "../demo/worlds"

/** A key in the `tours` i18n namespace. */
const TourCopyKeySchema = z
  .string()
  .regex(/^tours\.[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/, "a tours.* key")

/** A `data-testid` value (no spaces, no quotes). */
const TestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/, "a data-testid")

/**
 * A beat's anchor: a testid, whose `{beat-id}` segments stand for what an
 * earlier `do` or `world` beat of the run recorded (`tickets-list-row-{live-ticket}`:
 * the row of the ticket the live beat brought in). Until that beat recorded
 * it, the anchor points at nothing, never at some other element.
 */
const AnchorSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9_:.-]|\{[a-z0-9][a-z0-9-]*\})*\*?(?:\[data-[a-z][a-z0-9-]*=(?:\{[a-z0-9][a-z0-9-]*\}|[A-Za-z0-9][A-Za-z0-9 _.:'&-]*(?:\|[A-Za-z0-9][A-Za-z0-9 _.:'&-]*)*)\])?$/,
    "a data-testid (or a prefix ending in *), with {beat-id} segments, or a [data-attr=…] pin: what an earlier beat recorded ({beat-id}) or a fixed value (the seeded project's name, a seeded document's title), or fixed values a|b in order of preference",
  )

/**
 * The testid of an anchor, without its `[data-attr=value]` pin (an anchor may
 * pin the testid's elements to the one carrying a recorded id:
 * `approval-card[data-request-id={prepare}]`, the card of the approval the
 * prepare beat saw proposed).
 */
export function anchorTestId(anchor: string): string {
  const at = anchor.indexOf("[")
  return at < 0 ? anchor : anchor.slice(0, at)
}

/**
 * What a click / waitFor step targets: a testid, or a testid prefix ending in
 * `*` for rows keyed by id (`tickets-list-row-*`: the first visible one). A
 * testid built from a name (`routine-enable-toggle-<routine name>`) may hold
 * inner spaces.
 */
const TestIdTargetSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9_:. -]*[A-Za-z0-9_:.-])?\*?$/,
    "a data-testid, or a prefix ending in *",
  )

const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a lowercase slug")

/** Tour ids are `<app>.<name>` (e.g. `tickets.basics`). */
export const TourIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/, "a tour id like <app>.<name>")

/**
 * The person's one conversation with their agent, for a tour that talks to it
 * (`talksToAgent`): the one "Message" and the Chats list open, holding earlier
 * turns too, recorded on the run under this name when it starts, so a route, a `match` value or a step pin names it as `{conversation}` (or
 * `beat: "conversation"`) like an entity an earlier beat recorded. No beat may
 * take the name.
 */
export const RUN_CONVERSATION = "conversation"

/**
 * Pin a step's element to what an earlier `do` beat of the same run created
 * (or a `world` beat brought in): among the elements the testid matches, the
 * one whose `attr` holds the id of the entity that beat's event named, or that
 * the world beat recorded (kept in `beat_states`). When that beat
 * recorded no entity (skipped, or done before ids were kept) the step refuses:
 * "Do it for me" never falls back to some other row.
 */
const CreatedRefSchema = z
  .object({
    beat: SlugSchema,
    attr: z.string().regex(/^data-[a-z][a-z0-9-]*$/, "a data-* attribute"),
  })
  .strict()
export type TourCreatedRef = z.infer<typeof CreatedRefSchema>

/** What a step targets: a testid (or `prefix*`), optionally pinned to a created entity. */
/** An attribute a guard reads: `data-*` or `aria-*`. */
const GuardAttrSchema = z
  .string()
  .regex(/^(?:data-[a-z][a-z0-9-]*|aria-[a-z]+)$/, "a data-* or aria-* attribute")

/**
 * A fixed attribute value an element must carry (`data-personal-agent` is
 * "true"): of the elements the testid matches, only that one is the target.
 *
 * A list of values is an order of preference: the first value any visible
 * element carries wins (the record card a run staged, else its note's card).
 */
const WhereSchema = z
  .object({
    attr: GuardAttrSchema,
    value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  })
  .strict()

const ElementRefSchema = z.union([
  TestIdTargetSchema,
  z.object({ testid: TestIdTargetSchema, created: CreatedRefSchema }).strict(),
  z.object({ testid: TestIdTargetSchema, where: WhereSchema }).strict(),
])
export type TourElementRef = z.infer<typeof ElementRefSchema>

export const TourStepSchema = z.union([
  /**
   * `unlessVisible`: skip the click when that element is already on screen
   * (open a conversation from the list, unless one is open already).
   * `unlessActive`: skip the click when its target is already the selected
   * one (`data-active`, `aria-pressed`, `aria-selected` or `aria-checked` is
   * "true"), so a script never flips a toggle it meant to switch on.
   */
  z
    .object({
      click: ElementRefSchema,
      unlessVisible: ElementRefSchema.optional(),
      unlessActive: z.literal(true).optional(),
      /**
       * Among the elements the testid matches, press the first one whose
       * `attr` holds `value` (an unread conversation, not one already
       * answered); when none does, the first one as without it.
       */
      prefer: z
        .object({
          attr: z.string().regex(/^data-[a-z][a-z0-9-]*$/, "a data-* attribute"),
          value: z.string().min(1),
        })
        .strict()
        .optional(),
    })
    .strict(),
  /**
   * Type `text` into the field, replacing what it holds (a half-typed draft
   * left by a takeover is never prefixed). `append` continues the text an
   * earlier step of the same script wrote (after picking a mention).
   */
  z
    .object({
      type: z
        .object({
          testid: TestIdSchema,
          /** A `tours.*` copy key: typed in the person's language. */
          text: TourCopyKeySchema,
          append: z.literal(true).optional(),
          /** Type only into the field whose `attr` holds what that beat recorded (the person's conversation with their agent). */
          created: CreatedRefSchema.optional(),
          /** Type only into the field carrying this attribute value (the person's own agent conversation). */
          where: WhereSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ press: z.object({ testid: TestIdSchema, key: z.string().min(1) }).strict() }).strict(),
  z.object({ waitFor: ElementRefSchema }).strict(),
  /**
   * A guard: the element must carry `attr` = `value`, else the script stops
   * before doing anything more (put one before a submit, so a note is never
   * sent as a reply).
   */
  z
    .object({
      require: z
        .object({ testid: TestIdSchema, attr: GuardAttrSchema, value: z.string().min(1) })
        .strict(),
    })
    .strict(),
  z.object({ waitEvent: z.literal(true) }).strict(),
  /**
   * Open the person's conversation with their agent (a `talksToAgent`
   * tour's `RUN_CONVERSATION`): beside the screen the
   * person is on (the chat dock), so the agent still sees that screen, or its
   * own screen on a phone. Refused when the run recorded no conversation.
   */
  z.object({ openRunConversation: z.literal(true) }).strict(),
])
export type TourStep = z.infer<typeof TourStepSchema>

/** An `app:tool` name a held write's approval carries (`TourEventBinding.heldAs`). */
const HeldToolSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*:[A-Za-z0-9_]+$/, "an app:tool name")

/** The tools a binding's write may park as (`heldAs`), as a list; empty when none. */
export function heldTools(binding: { heldAs?: string | readonly string[] }): string[] {
  if (binding.heldAs === undefined) return []
  return typeof binding.heldAs === "string" ? [binding.heldAs] : [...binding.heldAs]
}

export const TourEventBindingSchema = z
  .object({
    app: SlugSchema,
    entity: z.string().regex(/^[a-z][a-z0-9_]*$/),
    action: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /**
     * Exact-match filter on `event.data` fields. A key may be a dotted path
     * (`currentPayload.ticketId`). A string value `{beat-id}` stands for the
     * entity an earlier `do` or `world` beat of the same run recorded (the
     * approval of the ticket this run injected); nothing recorded, no match.
     * A list of strings matches any one of them (the approval of either of
     * two tools); its values are literal, never `{beat-id}` references.
     * `null` matches a field the event carries as null, never a missing one
     * (an agent's reply to a person has no `parentMessageId`; its asks to
     * other agents, and their answers, nest under the turn that asked).
     */
    match: z
      .record(
        // A segment after the first may be a list index (`currentPayload.to.0`).
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/, "a field path"),
        z.union([
          z.string(),
          z.boolean(),
          z.null(),
          z.array(z.string().regex(/^[^{}]+$/, "a literal value")).min(1),
        ]),
      )
      .optional(),
    /**
     * Who must have caused the event: the tour's owner only (`user`, the
     * default), also an agent turn requested by that owner (`user-or-agent`),
     * or anyone (`any`: a routine acting unasked, a teammate). `any` is for a
     * beat that waits on what happens to something this run brought in: its
     * `match` must name an earlier beat's entity (`{beat-id}`), so only the
     * work on this run's own ticket, email or routine completes it, and it is
     * remembered when it happens before the tour reaches the beat.
     */
    actor: z.enum(["user", "user-or-agent", "any"]).optional(),
    /**
     * The event belongs to this run of the tour, not to anything else in the
     * org: it came from the agent turn that answers the message an earlier
     * `do` beat of the same run recorded (that beat's event was the person's
     * message). An agent working for another tour, or an earlier turn in the
     * same conversation, never completes the beat.
     */
    causedBy: SlugSchema.optional(),
    /**
     * The event names the very entity an earlier `do` beat of the same run
     * recorded (approve the approval that beat saw proposed, not another one).
     */
    sameEntityAs: SlugSchema.optional(),
    /**
     * The write this beat waits on may park for approval instead (`app:tool`):
     * an agent turn that read data some readers of the target cannot see asks
     * a person first. That tool's approval, proposed under the same actor and
     * run rules, also completes the beat; its state records the approval as
     * held (`TourBeatDone.held`), and a later `whenHeld` beat approves it.
     * A list names every tool the write may park as (a task, or the agent
     * staging a new project holding it): any of their approvals completes it.
     */
    heldAs: z.union([HeldToolSchema, z.array(HeldToolSchema).min(1)]).optional(),
    /**
     * For an agent's message (`kernel:message:create`): the turn that wrote it
     * made at least one SUCCESSFUL call to one of these tools of `app` (all its
     * tools when `tools` is absent). A call that threw, or whose result is an
     * `{ error }` refusal, does not count, so an answer that only says the
     * reads failed leaves the beat waiting (Try again, Skip) instead of
     * completing it.
     */
    turnUsed: z
      .object({
        app: SlugSchema,
        tools: z
          .array(z.string().regex(/^[A-Za-z0-9_]+$/))
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * The event counts only once no agent turn runs in its conversation
     * (`data.threadId`) any more. An agent that asked another agent and gave
     * up waiting replies before that agent's answer lands: its reply is not
     * the last word yet. The beat completes when the last turn there ends (the
     * event is looked for again then), so the person reads the conversation
     * as it ends. The binding must be scoped to its run (`causedBy`,
     * `sameEntityAs`, or a `{beat-id}` in `match`): only such an event is
     * looked for again.
     */
    turnsEnded: z.literal(true).optional(),
  })
  .strict()
export type TourEventBinding = z.infer<typeof TourEventBindingSchema>

/**
 * A binding that names what THIS run brought in or asked for: the turn
 * answering its ask (`causedBy`), the entity an earlier beat recorded
 * (`sameEntityAs`), or a `{beat-id}` value in its match. Only such a binding
 * may complete a beat from an event looked for again: an unscoped one would
 * complete it on anyone's unrelated work.
 */
export function bindingScopedToRun(binding: TourEventBinding): boolean {
  if (binding.causedBy !== undefined || binding.sameEntityAs !== undefined) return true
  return Object.values(binding.match ?? {}).some(
    (value) => typeof value === "string" && matchEntityRef(value) !== null,
  )
}

/**
 * What an org has set up, beyond its installed apps, that a beat may need.
 * `customer-card`: a connection fills the customer lookup, so tickets and mail
 * show the customer card (an installed API connector alone shows nothing).
 * `connector-add`: the API connector page lets the person add a connection
 * (a demo org's page is read-only, with only its sample connection).
 */
export const TOUR_FEATURES = ["customer-card", "connector-add"] as const
export type TourFeature = (typeof TOUR_FEATURES)[number]

export const TOUR_BEAT_KINDS = ["show", "do", "world"] as const
export type TourBeatKind = (typeof TOUR_BEAT_KINDS)[number]

/**
 * What a beat waits on besides the person, which sizes how long play-all
 * waits before it says the beat has not happened yet:
 * - `agent`: an agent turn (a research turn with a web search took about 100 s
 *   on a visitor's model);
 * - `routine`: a routine's run (its own turn, after the event that fired it);
 * - `replay`: a recorded session playing back (at most REPLAY_MAX_MS).
 */
export const TOUR_WAITS = ["agent", "routine", "replay"] as const
export type TourWait = (typeof TOUR_WAITS)[number]

/**
 * One hop of the way to a beat's element (`TourBeat.path`), outermost first:
 * the panel lists the hops, ticking each off as the person passes it, and
 * rings the one to take on screen. `rail`: the beat's app on the desktop rail
 * (computed from the route, passed once the person is in that app). `anchor`:
 * the element to press (the project's row, the agent in the chats list).
 * Neither: the last thing to do once there (send the request below).
 */
const TourPathHopSchema = z
  .object({
    label: TourCopyKeySchema,
    anchor: AnchorSchema.optional(),
    /** Phone-width override of `anchor`. */
    anchorPhone: AnchorSchema.optional(),
    rail: z.literal(true).optional(),
  })
  .strict()
  .superRefine((hop, ctx) => {
    if (hop.rail && hop.anchor)
      ctx.addIssue({ code: "custom", message: "a rail hop rings the rail: no anchor" })
    if (hop.anchorPhone && !hop.anchor)
      ctx.addIssue({ code: "custom", message: "anchorPhone overrides an anchor; set anchor too" })
  })
export type TourPathHop = z.infer<typeof TourPathHopSchema>

/** At most this many hops on the way to a beat's element. */
export const TOUR_PATH_MAX = 4

/**
 * A figure a step's copy names (`{{pastDue}}`), read when the step shows from
 * the same tool the screen it points at reads, never written into the copy.
 * `path` is a dotted path into the tool's result (`lines.0.pastDueMinor`).
 * `money`: an amount in minor units, its currency at `currency` (a path too).
 * `count`: a plain number.
 */
const TourFigurePickSchema = z
  .object({
    kind: z.enum(["money", "count"]),
    path: z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "a dotted path"),
    currency: z
      .string()
      .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "a dotted path")
      .optional(),
  })
  .strict()
  .superRefine((pick, ctx) => {
    if (pick.kind === "money" && !pick.currency)
      ctx.addIssue({ code: "custom", message: "a money figure names where its currency is" })
    if (pick.kind === "count" && pick.currency)
      ctx.addIssue({ code: "custom", message: "a count has no currency" })
  })

export const TourBeatFiguresSchema = z
  .object({
    /** `<app>:<tool>`, a read the person may call themselves. */
    tool: z.string().regex(/^[a-z0-9-]+:[a-z0-9_]+$/, "an app:tool name"),
    params: z.record(z.string(), z.unknown()).optional(),
    vars: z.record(
      z.string().regex(/^[a-z][A-Za-z0-9]*$/, "a copy variable name"),
      TourFigurePickSchema,
    ),
  })
  .strict()
export type TourBeatFigures = z.infer<typeof TourBeatFiguresSchema>

/** A figure as read: the copy formats it in the person's language. */
export type TourFigure =
  | { kind: "money"; minor: number; currency: string }
  | { kind: "count"; n: number }

function atPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      value,
    )
}

/**
 * The figures `figures` names, picked from `result` (what its tool answered).
 * Null when any is missing or not a number: the step then shows no figure
 * rather than a wrong one.
 */
export function pickTourFigures(
  figures: TourBeatFigures,
  result: unknown,
): Record<string, TourFigure> | null {
  const out: Record<string, TourFigure> = {}
  for (const [name, pick] of Object.entries(figures.vars)) {
    const raw = atPath(result, pick.path)
    const n = typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw
    if (typeof n !== "number" || !Number.isFinite(n)) return null
    if (pick.kind === "count") {
      out[name] = { kind: "count", n }
      continue
    }
    const currency = atPath(result, pick.currency ?? "")
    if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return null
    out[name] = { kind: "money", minor: n, currency: currency.toUpperCase() }
  }
  return out
}

export const TourBeatSchema = z
  .object({
    id: SlugSchema,
    kind: z.enum(TOUR_BEAT_KINDS),
    title: TourCopyKeySchema,
    body: TourCopyKeySchema,
    /**
     * The element the beat is about (spotlit). A `{beat-id}` segment pins it to
     * what an earlier beat recorded; a show beat pinned so is not passed with
     * Next before that element is on screen.
     */
    anchor: AnchorSchema.optional(),
    /** Phone-width override of `anchor` (390 px shell renders other surfaces). */
    anchorPhone: AnchorSchema.optional(),
    /**
     * Ring every visible element the anchor matches as one, not the first:
     * a group of rows (the subtasks the agent just made, by their
     * `data-parent-task-id`).
     */
    anchorAll: z.literal(true).optional(),
    /**
     * Who the person is in the story and why this step matters: one line,
     * shown under the title.
     */
    role: TourCopyKeySchema.optional(),
    /**
     * The way to the anchor, one hop per place to open (`TourPathHopSchema`):
     * listed in the panel and ringed in turn on screen while the anchor is
     * not, so the person learns the way there, not only "Take me there".
     */
    path: z.array(TourPathHopSchema).min(1).max(TOUR_PATH_MAX).optional(),
    /**
     * The exact words the step asks the person to send: `lead` introduces them
     * ("Ask Support Desk:"), `text` is the very copy key "Do it for me" types.
     */
    say: z.object({ lead: TourCopyKeySchema, text: TourCopyKeySchema }).strict().optional(),
    /**
     * `do` beats that approve: what the step says while the approval waits
     * out its undo window (the toast that offers Undo is ringed meanwhile):
     * every approved action waits a few seconds before it really happens.
     */
    undo: z
      .object({ title: TourCopyKeySchema, role: TourCopyKeySchema, body: TourCopyKeySchema })
      .strict()
      .optional(),
    /**
     * In-app path "Take me there" navigates to when the anchor is not on
     * screen. A `{beat-id}` segment stands for the entity an earlier `do` or
     * `world` beat of the same run recorded (`/projects/tasks/{teammate}`);
     * with nothing recorded there, there is nowhere to go.
     */
    route: z
      .string()
      .regex(/^\/[A-Za-z0-9_./:?=&{}-]*$/, "an in-app path")
      .optional(),
    /**
     * Phone-width override of `route`: where the beat's element is on a phone
     * when it is elsewhere than on a desktop (a draft approved from the
     * approvals screen once the person asked from the Chats tab).
     */
    routePhone: z
      .string()
      .regex(/^\/[A-Za-z0-9_./:?=&{}-]*$/, "an in-app path")
      .optional(),
    /**
     * `show` beats: the steps that bring the anchor on screen once on the
     * route (open the first conversation). "Take me there" and "Play whole
     * scenario" play them; the beat itself still moves on with Next.
     */
    reach: z.array(TourStepSchema).min(1).optional(),
    /** `do` beats: the product event that completes the beat. */
    event: TourEventBindingSchema.optional(),
    /** `do` beats: what "Do it for me" plays. */
    autoplay: z.array(TourStepSchema).min(1).optional(),
    /** Phone-width override of `autoplay`. */
    autoplayPhone: z.array(TourStepSchema).min(1).optional(),
    /** `world` beats: the demo injector that produces the live event. */
    injector: SlugSchema.optional(),
    /**
     * `show` and `do` beats: what produces what the beat waits for (the agent's
     * answer the anchor is part of, a routine's run, a replay). Play-all waits
     * that long, saying so, before it offers Try again and Skip. A do beat
     * without it waits as its event says (`beatWaitsOn`).
     */
    waitsOn: z.enum(TOUR_WAITS).optional(),
    /**
     * `do` beats: played only when the earlier do beat named here completed on
     * its held approval (`heldAs`): the person approves what the agent parked.
     * When that write ran at once, the run goes straight past this beat.
     */
    whenHeld: SlugSchema.optional(),
    /**
     * `do` beats approving what a routine staged: played only when the
     * routine's run raised the request this beat approves (an approval on one
     * of its event's `toolName`s, from the routine its
     * `metadata.originRoutineId` names, since the run began). A run that
     * finished without raising one passes this beat, as `whenHeld` passes an
     * approve step whose write ran at once: the step never waits on a request
     * that will not come, and never completes on another one.
     */
    whenRaised: z.literal(true).optional(),
    /**
     * `show` beats: figures the copy names (`{{name}}`), read from a tool when
     * the step shows (`TourBeatFiguresSchema`).
     */
    figures: TourBeatFiguresSchema.optional(),
    /** The beat exists only when this app is installed / this feature is set up in the org. */
    optional: z
      .object({ whenApp: SlugSchema.optional(), whenFeature: z.enum(TOUR_FEATURES).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((beat, ctx) => {
    if (beat.kind === "do") {
      if (!beat.event) ctx.addIssue({ code: "custom", message: "a do beat needs an event" })
      if (!beat.autoplay) ctx.addIssue({ code: "custom", message: "a do beat needs an autoplay" })
    } else {
      if (beat.event)
        ctx.addIssue({ code: "custom", message: `a ${beat.kind} beat cannot bind an event` })
      if (beat.autoplay || beat.autoplayPhone)
        ctx.addIssue({ code: "custom", message: `a ${beat.kind} beat cannot carry an autoplay` })
    }
    if (beat.kind === "world") {
      if (!beat.injector)
        ctx.addIssue({ code: "custom", message: "a world beat needs an injector" })
    } else if (beat.injector) {
      ctx.addIssue({ code: "custom", message: "only a world beat names an injector" })
    }
    if (beat.figures && beat.kind !== "show") {
      ctx.addIssue({ code: "custom", message: "only a show beat reads figures" })
    }
    if (beat.reach && beat.kind !== "show") {
      ctx.addIssue({ code: "custom", message: "only a show beat carries reach steps" })
    }
    if (beat.reach && !beat.anchor) {
      ctx.addIssue({ code: "custom", message: "reach steps bring an anchor on screen; set anchor" })
    }
    if (beat.anchorPhone && !beat.anchor) {
      ctx.addIssue({ code: "custom", message: "anchorPhone overrides an anchor; set anchor too" })
    }
    if (beat.anchorAll && !beat.anchor) {
      ctx.addIssue({
        code: "custom",
        message: "anchorAll rings what the anchor matches; set anchor",
      })
    }
    if (beat.path && !beat.anchor) {
      ctx.addIssue({ code: "custom", message: "a path leads to an anchor; set anchor too" })
    }
    if (beat.say) {
      const typed = [...(beat.autoplay ?? []), ...(beat.autoplayPhone ?? [])].flatMap((step) =>
        "type" in step ? [step.type.text] : [],
      )
      if (!typed.includes(beat.say.text)) {
        ctx.addIssue({ code: "custom", message: "say.text must be what Do it for me types" })
      }
    }
    if (beat.undo && beat.kind !== "do") {
      ctx.addIssue({ code: "custom", message: "only a do beat that approves has an undo window" })
    }
    if (beat.autoplayPhone && !beat.autoplay) {
      ctx.addIssue({ code: "custom", message: "autoplayPhone overrides an autoplay" })
    }
    if (beat.waitsOn && beat.kind === "world") {
      ctx.addIssue({ code: "custom", message: "a world beat waits on its own live event" })
    }
    if (beat.waitsOn && beat.kind === "show" && !beat.anchor) {
      ctx.addIssue({ code: "custom", message: "a show beat waits on its anchor; set anchor" })
    }
    if (beat.event?.turnsEnded && !bindingScopedToRun(beat.event)) {
      ctx.addIssue({
        code: "custom",
        message:
          "turnsEnded looks for the event again once the turns end: scope the binding to its run (causedBy, sameEntityAs or a {beat-id} in match)",
      })
    }
    if (beat.whenHeld && beat.kind !== "do") {
      ctx.addIssue({ code: "custom", message: "only a do beat approves a held write" })
    }
    if (beat.whenRaised) {
      const match = beat.event?.match ?? {}
      const routine = match["metadata.originRoutineId"]
      if (
        beat.kind !== "do" ||
        beat.event?.entity !== "approval_request" ||
        match.toolName === undefined ||
        typeof routine !== "string" ||
        matchEntityRef(routine) === null
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "a whenRaised beat approves a routine's request: a do beat on approval_request matching toolName and metadata.originRoutineId: {beat}",
        })
      }
    }
  })
export type TourBeat = z.infer<typeof TourBeatSchema>

export const TourSchema = z
  .object({
    id: TourIdSchema,
    app: SlugSchema,
    title: TourCopyKeySchema,
    summary: TourCopyKeySchema,
    requires: z
      .object({
        apps: z.array(SlugSchema).optional(),
        scopes: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    /**
     * A demo scenario: offered, startable and deep-linkable only in a demo org
     * (a regular org's "Show me how" never lists it).
     */
    demoOnly: z.literal(true).optional(),
    /**
     * The demo world this tour belongs to: it is offered, startable and
     * deep-linkable only in a workspace of that world. A tour without one
     * belongs to no world (every org it is otherwise available in).
     */
    world: z.enum(DEMO_WORLDS).optional(),
    /**
     * The scenario is played once: it offers no "Start again" once played,
     * only the visitor's whole "Start over".
     */
    singleRun: z.literal(true).optional(),
    /**
     * The tour talks to the person's own agent, in the one conversation they
     * have with it (their DM, made when missing), recorded when the run starts
     * (`RUN_CONVERSATION`) so its events and guards bind to that thread. It
     * holds earlier turns too: a write the agent makes after reading outside
     * text may ask for approval first (`heldAs`, `whenHeld`).
     */
    talksToAgent: z.literal(true).optional(),
    /**
     * The org agent a `talksToAgent` tour talks to instead of the person's own
     * (its handle, `@operations`): the run's conversation is the person's DM
     * with that agent (made when missing), so a scenario asks the desk that
     * holds the tools for the job.
     */
    agent: z
      .string()
      .regex(/^@[a-z0-9][a-z0-9-]*$/, "an agent handle like @operations")
      .optional(),
    beats: z.array(TourBeatSchema).min(1),
  })
  .strict()
  .superRefine((tour, ctx) => {
    if (tour.agent && !tour.talksToAgent) {
      ctx.addIssue({
        code: "custom",
        message: `tour ${tour.id} names an agent but does not talk to it`,
      })
    }
    if (!tour.id.startsWith(`${tour.app}.`)) {
      ctx.addIssue({ code: "custom", message: `tour id ${tour.id} must start with "${tour.app}."` })
    }
    const seen = new Set<string>()
    /** What a step pin may name: earlier do and world beats, and the person's agent conversation. */
    const earlierDo = new Set<string>(tour.talksToAgent ? [RUN_CONVERSATION] : [])
    /** Beats that may record an entity: do beats (their event's) and world beats (what they injected). */
    const earlierRecording = new Set<string>(tour.talksToAgent ? [RUN_CONVERSATION] : [])
    /** What `causedBy` / `sameEntityAs` may name: an earlier do beat, never the conversation. */
    const earlierDoBeat = new Set<string>()
    /** Earlier do beats whose write may park for approval (`heldAs`): what `whenHeld` may name. */
    const earlierHeld = new Set<string>()
    for (const beat of tour.beats) {
      if (beat.id === RUN_CONVERSATION) {
        ctx.addIssue({
          code: "custom",
          message: `beat id ${RUN_CONVERSATION} is reserved for the person's conversation with their agent`,
        })
      }
      for (const ref of [
        ...routeEntityRefs(beat.route),
        ...routeEntityRefs(beat.routePhone),
        ...routeEntityRefs(beat.anchor),
        ...routeEntityRefs(beat.anchorPhone),
        ...(beat.path ?? []).flatMap((hop) => [
          ...routeEntityRefs(hop.anchor),
          ...routeEntityRefs(hop.anchorPhone),
        ]),
      ]) {
        if (!earlierRecording.has(ref)) {
          ctx.addIssue({
            code: "custom",
            message: `beat ${beat.id} routes to ${ref}, which is not an earlier do or world beat`,
          })
        }
      }
      if (seen.has(beat.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate beat id ${beat.id}` })
      }
      seen.add(beat.id)
      for (const ref of [
        ...stepCreatedRefs(beat.autoplay),
        ...stepCreatedRefs(beat.autoplayPhone),
        ...stepCreatedRefs(beat.reach),
      ]) {
        if (!earlierDo.has(ref.beat)) {
          ctx.addIssue({
            code: "custom",
            message: `beat ${beat.id} pins to ${ref.beat}, which is not an earlier do or world beat`,
          })
        }
      }
      for (const value of Object.values(beat.event?.match ?? {})) {
        const ref = typeof value === "string" ? matchEntityRef(value) : null
        if (ref !== null && !earlierRecording.has(ref)) {
          ctx.addIssue({
            code: "custom",
            message: `beat ${beat.id} matches on ${ref}, which is not an earlier do or world beat`,
          })
        }
      }
      if (
        beat.event?.actor === "any" &&
        !Object.values(beat.event.match ?? {}).some(
          (v) => typeof v === "string" && matchEntityRef(v) !== null,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message: `beat ${beat.id} accepts any actor, so its match must name an earlier beat's entity`,
        })
      }
      for (const ref of [beat.event?.causedBy, beat.event?.sameEntityAs]) {
        if (ref !== undefined && !earlierDoBeat.has(ref)) {
          ctx.addIssue({
            code: "custom",
            message: `beat ${beat.id} binds to ${ref}, which is not an earlier do beat`,
          })
        }
      }
      if (beat.whenHeld !== undefined && !earlierHeld.has(beat.whenHeld)) {
        ctx.addIssue({
          code: "custom",
          message: `beat ${beat.id} approves ${beat.whenHeld}, which is not an earlier do beat whose write may be held`,
        })
      }
      if (beat.kind === "do") earlierDoBeat.add(beat.id)
      if (beat.kind === "do" && beat.event?.heldAs) earlierHeld.add(beat.id)
      if (beat.kind === "do" || beat.kind === "world") earlierDo.add(beat.id)
      if (beat.kind === "do" || beat.kind === "world") earlierRecording.add(beat.id)
    }
  })
export type Tour = z.infer<typeof TourSchema>

/**
 * Validate a tour definition at import. Throws with every issue listed, so a
 * malformed tour fails the build/test that imports the registry.
 */
export function defineTour(input: z.input<typeof TourSchema>): Tour {
  const parsed = TourSchema.safeParse(input)
  if (!parsed.success) {
    const id = typeof input.id === "string" ? input.id : "(no id)"
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new Error(`Invalid tour ${id}: ${issues}`)
  }
  return parsed.data
}

// ── Effective beats ────────────────────────────────────────────────────

/** A beat as one person plays it: phone overrides applied, no override fields. */
export interface EffectiveBeat {
  id: string
  kind: TourBeatKind
  title: string
  body: string
  /** May hold `{beat-id}` segments (`resolveBeatAnchor`). */
  anchor?: string
  /** `anchor` names what an earlier beat recorded: Next waits until it is on screen. */
  anchorPinned?: true
  /** Every visible element `anchor` matches is ringed as one. */
  anchorAll?: true
  /** Who the person is in the story and why the step matters (a copy key). */
  role?: string
  /** The way to the anchor, outermost hop first, phone overrides applied (anchors may hold `{beat-id}`). */
  path?: EffectivePathHop[]
  /** The exact words to send: a lead-in and the text Do it for me types (copy keys). */
  say?: { lead: string; text: string }
  /** What the step says while its approval waits out the undo window (copy keys). */
  undo?: { title: string; role: string; body: string }
  route?: string
  event?: TourEventBinding
  autoplay?: TourStep[]
  /** `show` beats: the steps that bring the anchor on screen. */
  reach?: TourStep[]
  injector?: string
  /** Figures the copy names, read when the step shows (`TourBeatFiguresSchema`). */
  figures?: TourBeatFigures
  waitsOn?: TourWait
  /** Played only when that earlier beat completed on its held approval. */
  whenHeld?: string
  whenRaised?: true
}

/** A hop of a beat's way, as one person plays it (`TourPathHopSchema`). */
export interface EffectivePathHop {
  label: string
  anchor?: string
  rail?: true
}

/**
 * What a beat waits on (`TourBeat.waitsOn`); for a do beat that names none,
 * what its event says: anyone's work on what the run brought in is a
 * routine's (`actor: "any"`), a turn the person's message started is their
 * agent's (`causedBy`, `user-or-agent`). Undefined: the person's own action.
 */
export function beatWaitsOn(
  beat: Pick<EffectiveBeat, "kind" | "event" | "waitsOn">,
): TourWait | undefined {
  if (beat.waitsOn) return beat.waitsOn
  if (beat.kind !== "do" || !beat.event) return undefined
  if (beat.event.actor === "any") return "routine"
  if (beat.event.causedBy || beat.event.actor === "user-or-agent") return "agent"
  return undefined
}

/**
 * A do beat the person's agent completes: the request it sends starts a turn
 * the beat waits on. A beat approving what the agent proposed waits on its
 * card, never on a turn.
 */
export function waitsOnAgentTurn(beat: Pick<EffectiveBeat, "kind" | "event" | "waitsOn">): boolean {
  if (beat.kind !== "do" || beatWaitsOn(beat) !== "agent") return false
  return !(beat.event?.entity === "approval_request" && beat.event.action === "update")
}

/** The dock's Chats item: the first hop of every beat played in the dock beside a screen. */
export const DOCK_CHATS_ANCHOR = "dock-chats"

/**
 * A beat played in the chat dock beside its screen (its way opens Chats in
 * the dock): asking the agent, watching it work, approving what it asked.
 * The runner keeps the dock's windows open between such beats on one screen
 * and puts them away when a beat points back at the screen itself.
 */
export function beatUsesDock(beat: Pick<EffectiveBeat, "path">): boolean {
  return (beat.path ?? []).some((hop) => hop.anchor === DOCK_CHATS_ANCHOR)
}

export interface EffectiveBeatsContext {
  /** App names installed (and enabled) in the org. */
  installedApps: ReadonlySet<string> | readonly string[]
  /** The org is a demo org (world beats play only there). */
  isDemo: boolean
  /** What the org has set up (TOUR_FEATURES); none when absent. */
  features?: readonly TourFeature[]
  /** The person plays at phone width (anchorPhone / autoplayPhone apply). */
  phone?: boolean
  /** The demo world of the org (read as the default world when absent). */
  worldId?: DemoWorldId
}

/**
 * The beats one person actually plays. The ONE derivation used by the web
 * engine, the completion consumer, the routes and the CLI, so beat indexes
 * agree everywhere: optional beats whose app or feature is missing drop, world beats drop
 * outside demo orgs. `phone` only swaps anchor/route/autoplay, never the list, so a
 * tour resumed on another device lands on the same beat.
 */
export function effectiveBeats(tour: Tour, ctx: EffectiveBeatsContext): EffectiveBeat[] {
  const installed =
    ctx.installedApps instanceof Set
      ? (ctx.installedApps as ReadonlySet<string>)
      : new Set(ctx.installedApps as readonly string[])
  const out: EffectiveBeat[] = []
  // A tour of another world has no beats here, whatever else is installed.
  if (tour.world !== undefined && (ctx.worldId ?? DEMO_DEFAULT_WORLD) !== tour.world) return out
  for (const beat of tour.beats) {
    if (beat.optional?.whenApp && !installed.has(beat.optional.whenApp)) continue
    if (beat.optional?.whenFeature && !ctx.features?.includes(beat.optional.whenFeature)) continue
    if (beat.kind === "world" && !ctx.isDemo) continue
    const anchor = ctx.phone ? (beat.anchorPhone ?? beat.anchor) : beat.anchor
    const autoplay = ctx.phone ? (beat.autoplayPhone ?? beat.autoplay) : beat.autoplay
    const effective: EffectiveBeat = {
      id: beat.id,
      kind: beat.kind,
      title: beat.title,
      body: beat.body,
    }
    if (anchor !== undefined) effective.anchor = anchor
    if (anchor !== undefined && routeEntityRefs(anchor).length > 0) effective.anchorPinned = true
    if (anchor !== undefined && beat.anchorAll) effective.anchorAll = true
    if (beat.role !== undefined) effective.role = beat.role
    if (beat.path !== undefined) {
      effective.path = beat.path.map((hop) => {
        const anchor = ctx.phone ? (hop.anchorPhone ?? hop.anchor) : hop.anchor
        const out: EffectivePathHop = { label: hop.label }
        if (anchor !== undefined) out.anchor = anchor
        if (hop.rail) out.rail = true
        return out
      })
    }
    if (beat.say !== undefined) effective.say = beat.say
    if (beat.undo !== undefined) effective.undo = beat.undo
    const route = ctx.phone ? (beat.routePhone ?? beat.route) : beat.route
    if (route !== undefined) effective.route = route
    if (beat.event !== undefined) effective.event = beat.event
    if (autoplay !== undefined) effective.autoplay = autoplay
    if (beat.reach !== undefined) effective.reach = beat.reach
    if (beat.injector !== undefined) effective.injector = beat.injector
    if (beat.figures !== undefined) effective.figures = beat.figures
    if (beat.waitsOn !== undefined) effective.waitsOn = beat.waitsOn
    if (beat.whenHeld !== undefined) effective.whenHeld = beat.whenHeld
    if (beat.whenRaised !== undefined) effective.whenRaised = beat.whenRaised
    out.push(effective)
  }
  return out
}

/**
 * Index of `beatId` in an effective list, or -1. Progress stores the beat id
 * and re-derives the index, so a beat appearing/disappearing (an app installed
 * mid-tour) never shifts the person onto another beat.
 */
export function beatIndexOf(beats: readonly EffectiveBeat[], beatId: string | null): number {
  if (beatId === null) return -1
  return beats.findIndex((b) => b.id === beatId)
}

export interface TourAvailabilityContext {
  installedApps: ReadonlySet<string> | readonly string[]
  /** The caller's scopes; `*` grants everything. */
  scopes: ReadonlySet<string> | readonly string[]
  /** The org is a demo org (`demoOnly` tours exist only there). Absent = not a demo org. */
  isDemo?: boolean
  /** The demo world of the org (read as the default world when absent); a tour of another world is not offered. */
  worldId?: DemoWorldId
}

/**
 * The tour can be offered to this caller in this org (`requires`, owning app,
 * and `demoOnly` tours only in a demo org).
 */
export function isTourAvailable(tour: Tour, ctx: TourAvailabilityContext): boolean {
  if (tour.demoOnly && ctx.isDemo !== true) return false
  if (tour.world !== undefined && (ctx.worldId ?? DEMO_DEFAULT_WORLD) !== tour.world) return false
  const installed = new Set(ctx.installedApps as Iterable<string>)
  const scopes = new Set(ctx.scopes as Iterable<string>)
  if (tour.app !== "kernel" && !installed.has(tour.app)) return false
  for (const app of tour.requires?.apps ?? []) {
    if (!installed.has(app)) return false
  }
  if (scopes.has("*")) return true
  for (const scope of tour.requires?.scopes ?? []) {
    if (!scopes.has(scope)) return false
  }
  return true
}

/** The testid an element ref names. */
export function refTestId(ref: TourElementRef): string {
  return typeof ref === "string" ? ref : ref.testid
}

/** The created-entity pin of an element ref, if any. */
export function refCreated(ref: TourElementRef): TourCreatedRef | undefined {
  return typeof ref === "string" || !("created" in ref) ? undefined : ref.created
}

/** The fixed attribute value an element ref requires, if any. */
export function refWhere(
  ref: TourElementRef,
): { attr: string; value: string | readonly string[] } | undefined {
  return typeof ref === "string" || !("where" in ref) ? undefined : ref.where
}

const MATCH_ENTITY_RE = /^\{([a-z0-9][a-z0-9-]*)\}$/

/** The beat a `match` value `{beat-id}` names, or null for a literal value. */
export function matchEntityRef(value: string): string | null {
  return MATCH_ENTITY_RE.exec(value)?.[1] ?? null
}

const ROUTE_ENTITY_RE = /\{([a-z0-9][a-z0-9-]*)\}/g

/** The beat ids a route's `{beat-id}` segments name. */
export function routeEntityRefs(route: string | undefined): string[] {
  if (!route) return []
  return [...route.matchAll(ROUTE_ENTITY_RE)].map((m) => m[1]!)
}

/**
 * A beat's route with each `{beat-id}` replaced by the entity that beat
 * recorded (`created`, by beat id). Null when one is missing: the beat has
 * nowhere to go, rather than going somewhere else.
 */
export function resolveBeatRoute(
  route: string | undefined,
  created: Readonly<Record<string, string>>,
): string | null {
  if (!route) return null
  let missing = false
  const out = route.replace(ROUTE_ENTITY_RE, (_, beatId: string) => {
    const id = created[beatId]
    if (!id) {
      missing = true
      return ""
    }
    return encodeURIComponent(id)
  })
  return missing ? null : out
}

/**
 * A beat's anchor with each `{beat-id}` replaced by what that beat recorded.
 * Null when there is none, or when one is missing: the beat points at
 * nothing yet, rather than at some other element.
 */
export function resolveBeatAnchor(
  anchor: string | undefined,
  created: Readonly<Record<string, string>>,
): string | null {
  if (!anchor) return null
  let missing = false
  const out = anchor.replace(ROUTE_ENTITY_RE, (_, beatId: string) => {
    const id = created[beatId]
    if (!id) missing = true
    return id ?? ""
  })
  return missing ? null : out
}

/** Every created-entity pin a list of steps uses. */
function stepCreatedRefs(steps: readonly TourStep[] | undefined): TourCreatedRef[] {
  const out: TourCreatedRef[] = []
  for (const step of steps ?? []) {
    const refs: TourElementRef[] =
      "click" in step
        ? [step.click, ...(step.unlessVisible ? [step.unlessVisible] : [])]
        : "waitFor" in step
          ? [step.waitFor]
          : []
    for (const ref of refs) {
      const created = refCreated(ref)
      if (created) out.push(created)
    }
    if ("type" in step && step.type.created) out.push(step.type.created)
    if ("openRunConversation" in step) out.push({ beat: RUN_CONVERSATION, attr: "data-thread-id" })
  }
  return out
}

/** Every testid a tour names (anchors and autoplay steps, phone overrides included). */
export function tourTestIds(tour: Tour): string[] {
  const ids = new Set<string>()
  const fromSteps = (steps: readonly TourStep[] | undefined) => {
    for (const step of steps ?? []) {
      if ("click" in step) {
        ids.add(refTestId(step.click))
        if (step.unlessVisible) ids.add(refTestId(step.unlessVisible))
      } else if ("type" in step) ids.add(step.type.testid)
      else if ("press" in step) ids.add(step.press.testid)
      else if ("waitFor" in step) ids.add(refTestId(step.waitFor))
      else if ("require" in step) ids.add(step.require.testid)
    }
  }
  for (const beat of tour.beats) {
    if (beat.anchor) ids.add(anchorTestId(beat.anchor))
    if (beat.anchorPhone) ids.add(anchorTestId(beat.anchorPhone))
    for (const hop of beat.path ?? []) {
      if (hop.anchor) ids.add(anchorTestId(hop.anchor))
      if (hop.anchorPhone) ids.add(anchorTestId(hop.anchorPhone))
    }
    fromSteps(beat.autoplay)
    fromSteps(beat.autoplayPhone)
    fromSteps(beat.reach)
  }
  return [...ids]
}

/** Every `tours.*` copy key a tour uses, the text its autoplay types included. */
export function tourCopyKeys(tour: Tour): string[] {
  const keys = [tour.title, tour.summary]
  const typed = (steps: readonly TourStep[] | undefined) => {
    for (const step of steps ?? []) if ("type" in step) keys.push(step.type.text)
  }
  for (const beat of tour.beats) {
    keys.push(beat.title, beat.body)
    if (beat.role) keys.push(beat.role)
    for (const hop of beat.path ?? []) keys.push(hop.label)
    if (beat.say) keys.push(beat.say.lead, beat.say.text)
    if (beat.undo) keys.push(beat.undo.title, beat.undo.role, beat.undo.body)
    typed(beat.autoplay)
    typed(beat.autoplayPhone)
    typed(beat.reach)
  }
  return [...new Set(keys)]
}
