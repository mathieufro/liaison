// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { boolean, jsonb, smallint, text, time, timestamp, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"
import { users } from "./users"

/** Home card order/collapse persistence shape — see `updateHomeCardLayout`. */
export interface HomeCardLayout {
  order: string[]
  collapsed: string[]
}

/**
 * Stored shape of `notification_channels` (0108): only the grid cells that
 * differ from `DEFAULT_GRID`, whether the user set work hours explicitly
 * (until then quiet hours are the default evenings and weekends), and the
 * groups the user set to off (`mutedGroups`, mute the kind). Unknown keys are
 * ignored on read and rejected on write.
 */
export interface NotificationChannelsStored {
  grid?: Record<string, Record<string, boolean>>
  workHoursExplicit?: boolean
  /** Groups set to off: silenced on push, desktop and email, kept quietly in the inbox. */
  mutedGroups?: string[]
  /** The person set `timezone` (settings, the agent, or their browser reported it). */
  timezoneSet?: boolean
  /** Approval reminder frequency; absent = daily (the default). */
  approvalReminder?: "every_3_days" | "weekly" | "off"
}

/** Stored shape of `agent_mail_access` (0115). `mac` is present when enabled. */
export interface AgentMailAccessRecord {
  enabled: boolean
  /** Epoch milliseconds of the change on the device that made it. */
  at: number
  mac?: string
}

/**
 * kernel.user_preferences — per-user digest cadence + work-hours schedule (Phase 10).
 * One row per user. Defaults are written lazily when a user first opens the
 * Settings → Attention preferences page. Work hours is always-on: identical
 * start/end means "all 24 hours" of the selected work days. workDays is an
 * ISO weekday array (1=Mon … 7=Sun).
 */
export const userPreferences = kernel.table("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  digestCadence: text("digest_cadence").notNull().default("daily"),
  workHoursStart: time("work_hours_start").notNull().default("09:00"),
  workHoursEnd: time("work_hours_end").notNull().default("17:00"),
  workDays: smallint("work_days").array().notNull().default(sql`'{1,2,3,4,5}'::smallint[]`),
  timezone: text("timezone").notNull().default("UTC"),
  // Per-user UI language (I4): the user's EXPLICIT choice, NULL when they
  // never picked one. Resolution is choice > org default locale > browser
  // language > "en" (resolveLocale in packages/shared). It had a NOT NULL
  // "en" default, which beat the org default for every user who never chose.
  language: text("language"),
  // Per-user UI theme preference (Phase 14). 'system' resolves to OS preference
  // client-side via prefers-color-scheme; 'light' / 'dark' force explicit mode.
  theme: text("theme").notNull().default("system"),
  // Per-user "magic wand" custom instruction (tone/style). Null = plain
  // spelling/grammar correction only. Length-capped at the route layer.
  magicWandInstructions: text("magic_wand_instructions"),
  // "Clean up dictation automatically" (0173): a dictated transcript goes
  // through the clean-up model before insertion. Written ONLY via
  // `updateDictationAutoClean`'s targeted UPDATE (same trap as below).
  dictationAutoClean: boolean("dictation_auto_clean").notNull().default(true),
  lastDailySentAt: timestamp("last_daily_sent_at", { withTimezone: true }),
  // Home card order/collapse state (Task 7, liaison-messaging-visibility).
  // Nullable — absent means "use the default order, nothing collapsed".
  // Written ONLY via `updateHomeCardLayout`'s targeted UPDATE, never through
  // the full-replace `updatePreferences` — see that function's comment (same
  // trap `updateTheme` already documents: a full-replace save from Settings
  // would otherwise null this out on every unrelated preferences change).
  homeCardLayout: jsonb("home_card_layout").$type<HomeCardLayout | null>(),
  // Notification grid overrides + explicit work hours (0108). NULL = defaults.
  // Written ONLY via the targeted updates in modules/notifications/settings.ts,
  // never through the full-replace `updatePreferences` (same trap as above).
  notificationChannels: jsonb("notification_channels").$type<NotificationChannelsStored | null>(),
  // Reaction picker favourites row (0111), in row order, at most 24. NULL =
  // never customised (the client shows its nine defaults). Written ONLY via
  // `updateFavoriteEmoji`'s targeted UPDATE (same trap as above). A CHECK
  // (`user_preferences_favorite_emoji_array`) keeps it an array.
  favoriteEmoji: jsonb("favorite_emoji").$type<string[] | null>(),
  // The "assistant may read my mail" switch relayed between the holder's
  // devices (0115). The server is a relay only: devices apply enabled=true
  // only when `mac` verifies under the mailbox key. NULL = never synced.
  // Written ONLY via `updateAgentMailAccess` (same trap as above).
  agentMailAccess: jsonb("agent_mail_access").$type<AgentMailAccessRecord | null>(),
  // Who takes over by default while this person is away. NULL = nobody named.
  // Never written through the full-replace `updatePreferences` (same trap as above).
  nextInLineId: uuid("next_in_line_id").references(() => users.id, { onDelete: "set null" }),
  // The rail entries this person hid from their sidebar (0293): activity-bar
  // entry ids, unknown ids kept. NULL = nothing hidden. A display preference,
  // never access. Written ONLY via `updateHiddenSidebarApps` (same trap as
  // above). A CHECK (`user_preferences_hidden_sidebar_apps_array`) keeps it an array.
  hiddenSidebarApps: jsonb("hidden_sidebar_apps").$type<string[] | null>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export type UserPreference = typeof userPreferences.$inferSelect
export type NewUserPreference = typeof userPreferences.$inferInsert
