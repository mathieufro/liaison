// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const windowSchema = z
  .tuple([z.string().regex(HHMM), z.string().regex(HHMM)])
  .refine(([a, b]) => a < b, "start < end")

const daySchema = z
  .array(windowSchema)
  // 48 half-hour windows: more than any real day holds.
  .max(48)
  .refine((wins) => {
    const sorted = [...wins].sort((x, y) => (x[0] < y[0] ? -1 : 1))
    let previous: (typeof sorted)[number] | undefined
    for (const current of sorted) {
      if (previous && current[0] < previous[1]) return false
      previous = current
    }
    return true
  }, "windows must not overlap")

const holidaySchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  label: z.string().min(1),
})

export const businessHoursSchema = z.strictObject({
  timezone: z.string().min(1),
  weekly: z
    .object({
      mon: daySchema,
      tue: daySchema,
      wed: daySchema,
      thu: daySchema,
      fri: daySchema,
      sat: daySchema,
      sun: daySchema,
    })
    .refine(
      (w) => Object.values(w).some((d) => d.length > 0),
      "at least one day must have a window",
    ),
  holidays: z.array(holidaySchema).max(1000),
})

const slaTargetsSchema = z.strictObject({
  low: z.number().int().positive(),
  normal: z.number().int().positive(),
  high: z.number().int().positive(),
  urgent: z.number().int().positive(),
})

const emailTemplateSchema = z.strictObject({
  headerName: z.string().nullable(),
  footerText: z.string().nullable(),
  accentColor: z.string().nullable(),
})

// Ticket display ids (`ticket-<CODE>-<n>`). The org picks ONE field whose
// value segments the id, and sets a short code per value. The stored handle
// never changes (`ticket-<n>`, minted by nextHandle); the display form is
// computed from the ticket's CURRENT value of that field, so reclassifying a
// ticket changes its segment and never its number. Keys of `codes` are the
// field's raw value: the audience ("b2b"/"b2c"), the team name, the category
// id or the inbox id.
export const TICKET_ID_SEGMENT_FIELDS = ["none", "audience", "team", "category", "inbox"] as const
export type TicketIdSegmentBy = (typeof TICKET_ID_SEGMENT_FIELDS)[number]
export const TICKET_ID_CODE_RE = /^[A-Z0-9]{1,8}$/

const ticketIdCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(TICKET_ID_CODE_RE, "code must be 1-8 letters or digits"))

export const ticketIdSegmentSchema = z
  .strictObject({
    by: z.enum(TICKET_ID_SEGMENT_FIELDS),
    codes: z.record(z.string().min(1), ticketIdCodeSchema),
  })
  .superRefine((v, ctx) => {
    const seen = new Map<string, string>()
    for (const [key, code] of Object.entries(v.codes)) {
      const prior = seen.get(code)
      if (prior !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["codes", key],
          message: `code ${code} is already used by ${prior}`,
        })
      }
      seen.set(code, key)
    }
  })

export type TicketIdSegment = z.infer<typeof ticketIdSegmentSchema>

export const ticketIdSegmentDefault: TicketIdSegment = { by: "none", codes: {} }

/** The stored config, or "not segmenting" when absent or malformed. Read-time
 *  default: the full settings schema carries no default for it. */
export function readTicketIdSegment(raw: unknown): TicketIdSegment {
  const parsed = ticketIdSegmentSchema.safeParse(raw)
  return parsed.success ? parsed.data : { by: "none", codes: {} }
}

/** `ticket-<n>` and `ticket-<SEG>-<n>` (any case, any segment, so a stale one
 *  still resolves). */
const TICKET_HANDLE_FORM_RE = /^ticket-(?:([a-z0-9]+)-)?(\d+)$/i

/** The ticket NUMBER a handle names, as a canonical decimal string (no
 *  leading zeros), or null when `value` is not a ticket handle. */
export function parseTicketHandleNumber(value: string): string | null {
  const m = TICKET_HANDLE_FORM_RE.exec(value.trim())
  if (!m?.[2]) return null
  return m[2].replace(/^0+(?=\d)/, "")
}

/** The segment field values of one ticket, in either naming. */
export interface TicketSegmentFields {
  audience?: string | null
  team?: string | null
  categoryId?: string | null
  sourceInboxId?: string | null
}

function segmentValue(fields: TicketSegmentFields, by: TicketIdSegmentBy): string | null {
  switch (by) {
    case "audience":
      return fields.audience ?? null
    case "team":
      return fields.team ?? null
    case "category":
      return fields.categoryId ?? null
    case "inbox":
      return fields.sourceInboxId ?? null
    default:
      return null
  }
}

/** `ticket-<n>` formatted with an optional segment code. */
export function formatTicketHandle(n: string | number, code?: string | null): string {
  return code ? `ticket-${code}-${n}` : `ticket-${n}`
}

/**
 * The display handle of a ticket: `ticket-<CODE>-<n>` when the org segments
 * and the ticket's current field value has a code, else `ticket-<n>`. A
 * stored handle that is not `ticket-<n>` is returned as stored.
 */
export function displayTicketHandle(
  storedHandle: string,
  fields: TicketSegmentFields,
  cfg: TicketIdSegment,
): string {
  const m = /^ticket-(\d+)$/i.exec(storedHandle)
  if (!m?.[1] || cfg.by === "none") return storedHandle
  const value = segmentValue(fields, cfg.by)
  const code = value !== null ? cfg.codes[value] : undefined
  return code ? formatTicketHandle(m[1], code) : storedHandle
}

/** Remove every `[#ticket-<n>]` / `[#ticket-<SEG>-<n>]` tag naming the same
 *  ticket number as `handle`, so an email subject is tagged with the current
 *  display form once, never twice. Other tickets' tags are kept. */
export function stripTicketHandleTags(subject: string, handle: string): string {
  const n = parseTicketHandleNumber(handle)
  if (n === null) return subject
  const re = new RegExp(`\\s*\\[#ticket-(?:[a-z0-9]+-)?0*${n}\\]`, "gi")
  return subject.replace(re, "").trimEnd()
}

export const ticketsSettingsSchema = z.strictObject({
  sla: z.strictObject({
    targets: slaTargetsSchema,
    businessHours: businessHoursSchema,
  }),
  emailTemplate: emailTemplateSchema,
  idSegment: ticketIdSegmentSchema.optional(),
  approveRepliesFromHome: z.boolean().optional(),
})

/**
 * `settings.tickets.approveRepliesFromHome`: whether a pending customer reply
 * (a tool declaring `decideInContext`) may be approved, edited or rejected from
 * its Home card. Off by default: the card then only opens the ticket, so the
 * reviewer reads the conversation before the reply goes out. When on, the card
 * is decidable like any other approval (the decide path is the same either
 * way). Absent or malformed reads as off.
 */
export function ticketsApproveRepliesFromHome(settings: unknown): boolean {
  return appApprovesFromHome(settings, "tickets")
}

/**
 * The same opt-out for any app whose gated tools declare `decideInContext`:
 * `settings.<app>.approveRepliesFromHome`. The kernel reads it per app name,
 * so no kernel code branches on which app that is. Absent or malformed reads
 * as off.
 */
export function appApprovesFromHome(settings: unknown, appName: string): boolean {
  if (!settings || typeof settings !== "object") return false
  const app = (settings as Record<string, unknown>)[appName]
  if (!app || typeof app !== "object") return false
  return (app as { approveRepliesFromHome?: unknown }).approveRepliesFromHome === true
}

export const ticketsSettingsDefaults = {
  sla: {
    targets: { low: 86400, normal: 28800, high: 7200, urgent: 3600 },
    businessHours: {
      timezone: "Europe/Paris",
      weekly: {
        mon: [["09:00", "18:00"]],
        tue: [["09:00", "18:00"]],
        wed: [["09:00", "18:00"]],
        thu: [["09:00", "18:00"]],
        fri: [["09:00", "18:00"]],
        sat: [],
        sun: [],
      },
      holidays: [],
    },
  },
  emailTemplate: { headerName: null, footerText: null, accentColor: null },
} as const

export type TicketsSettings = z.infer<typeof ticketsSettingsSchema>
