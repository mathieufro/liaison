// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  resolveLocale,
  type ShippedLocale,
  type ThemePreference,
  toShippedLocale,
} from "@liaison/shared"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  on,
  Show,
  Suspense,
} from "solid-js"
import { getTimezones } from "~/lib/timezones"
import { noteDictationAutoClean } from "~/modules/assist/dictation-capabilities"
import DesktopClaudeAccount from "~/modules/desktop/DesktopClaudeAccount"
import { isDesktop } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { getThemeStore } from "~/modules/shell/theme-store"
import { addToast } from "~/modules/shell/toast-store"
import { AvatarImage } from "~/ui/AvatarImage"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { Skeleton } from "~/ui/Skeleton"
import { Switch } from "~/ui/Switch"
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_ACCEPT_MIME,
  AVATAR_MAX_UPLOAD_BYTES,
  removeAvatar,
  uploadAvatar,
} from "./avatar-service"
import { DesktopServersSection } from "./NativeServersSection"

interface UserProfile {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
  timezone?: string
  locale?: string
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

const ProfileSettings: Component = () => {
  const api = useApi()
  const { t, locale: activeLocale, setLocale: setUiLocale } = useI18n()

  const [profile] = createResource(async () => {
    return api.get<UserProfile>("/users/me")
  })

  // Current persisted UI language + theme + magic-wand instruction
  // (kernel.user_preferences.{language,theme,magic_wand_instructions}).
  const [prefs] = createResource(async () =>
    api.get<{
      language?: string | null
      orgDefaultLocale?: string | null
      theme?: ThemePreference
      magicWandInstructions?: string | null
      dictationAutoClean?: boolean
    }>("/user/preferences"),
  )

  const themeStore = getThemeStore()

  const [name, setName] = createSignal("")
  const [timezone, setTimezone] = createSignal("")
  const [locale, setLocale] = createSignal("")
  // "" = the user never chose: the org default (then the browser) decides.
  const [language, setLanguage] = createSignal<ShippedLocale | "">(activeLocale())
  const fallbackLocale = (): ShippedLocale =>
    resolveLocale(
      prefs()?.orgDefaultLocale,
      typeof navigator !== "undefined" ? navigator.language : null,
    )
  const [themePref, setThemePref] = createSignal<ThemePreference>(themeStore.preference())
  const [wandInstructions, setWandInstructions] = createSignal("")
  // Last value persisted on the server, so onBlur only saves an actual edit.
  const [savedWandInstructions, setSavedWandInstructions] = createSignal("")
  const [savingWand, setSavingWand] = createSignal(false)
  // On unless the user turned it off (the column defaults to true).
  const [autoClean, setAutoClean] = createSignal(true)
  const [saving, setSaving] = createSignal(false)

  // Avatar state is kept in its own signal (not folded into the profile
  // resource) so replacing the picture does not re-run the form-init effect and
  // clobber unsaved name/timezone/locale edits.
  const [avatarUrl, setAvatarUrl] = createSignal<string | null>(null)
  const [avatarBusy, setAvatarBusy] = createSignal(false)
  let avatarInputRef: HTMLInputElement | undefined

  createEffect(
    on(
      prefs,
      (p) => {
        if (!p) return
        setLanguage(toShippedLocale(p.language) ?? "")
        const tt = p.theme
        if (tt === "light" || tt === "dark" || tt === "system") {
          // Server is source of truth across devices once authenticated.
          themeStore.hydrateFromServer(tt)
          setThemePref(tt)
        }
        const wand = p.magicWandInstructions ?? ""
        setWandInstructions(wand)
        setSavedWandInstructions(wand)
        setAutoClean(p.dictationAutoClean !== false)
      },
      { defer: true },
    ),
  )

  async function handleSaveWand() {
    // Skip the network round-trip + toast when the field was not actually edited
    // (blur fires on every focus-out). Compare trimmed, mirroring the server's
    // blank → null normalization so trailing whitespace alone is not "dirty".
    if (wandInstructions().trim() === savedWandInstructions().trim()) return
    setSavingWand(true)
    try {
      await api.put("/user/preferences/magic-wand", { instructions: wandInstructions() })
      setSavedWandInstructions(wandInstructions())
      addToast({ message: t("kernel.magicWandSaved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    } finally {
      setSavingWand(false)
    }
  }

  async function handleAutoCleanChange(next: boolean) {
    const previous = autoClean()
    setAutoClean(next)
    try {
      // Its own partial endpoint: the full /user/preferences PUT replaces the row.
      await api.put("/user/preferences/dictation", { autoClean: next })
      noteDictationAutoClean(api, next)
      addToast({ message: t("kernel.magicWandSaved"), type: "success" })
    } catch {
      setAutoClean(previous)
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    }
  }

  async function handleThemeChange(next: ThemePreference) {
    const previous = themeStore.preference()
    // Optimistic: apply immediately for instant feedback.
    themeStore.setPreference(next)
    setThemePref(next)
    try {
      // Theme-only partial endpoint — mirrors language flow.
      await api.put("/user/preferences/theme", { theme: next })
    } catch {
      themeStore.setPreference(previous)
      setThemePref(previous)
      addToast({ message: t("kernel.settings.themeUpdateFailed"), type: "error" })
    }
  }

  async function handleLanguageChange(next: ShippedLocale | "") {
    setLanguage(next)
    // Immediate reactive re-render of every mounted tab (no remount).
    setUiLocale(next === "" ? fallbackLocale() : next)
    try {
      // Language-only partial endpoint — the full-replace /user/preferences
      // PUT requires the entire preferences object the toggle doesn't hold.
      // null clears the choice so the org default applies again.
      await api.put("/user/preferences/language", { language: next === "" ? null : next })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    }
  }

  createEffect(
    on(
      profile,
      (p) => {
        if (!p) return
        // One-shot form initialization from resource — not a reactive derivation
        setName(p.name)
        setTimezone(p.timezone ?? "")
        setLocale(p.locale ?? "")
        setAvatarUrl(p.avatarUrl ?? null)
      },
      { defer: true },
    ),
  )

  async function handleSave(e: Event) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.patch("/users/me", {
        name: name(),
        timezone: timezone() || undefined,
        locale: locale() || undefined,
      })
      addToast({ message: t("kernel.settings.profile.updated"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.updateFailed"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarSelected(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Reset so picking the same file again still fires onChange.
    input.value = ""
    if (!file) return
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      addToast({ message: t("kernel.settings.profile.avatarTooLarge"), type: "error" })
      return
    }
    if (file.type && !(AVATAR_ACCEPT_MIME as readonly string[]).includes(file.type)) {
      addToast({ message: t("kernel.settings.profile.avatarUnsupported"), type: "error" })
      return
    }
    setAvatarBusy(true)
    try {
      const updated = await uploadAvatar(api, file)
      setAvatarUrl(updated.avatarUrl ?? null)
      addToast({ message: t("kernel.settings.profile.avatarUpdated"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.avatarUploadFailed"), type: "error" })
    } finally {
      setAvatarBusy(false)
    }
  }

  async function handleRemoveAvatar() {
    setAvatarBusy(true)
    try {
      await removeAvatar(api)
      setAvatarUrl(null)
      addToast({ message: t("kernel.settings.profile.avatarRemoved"), type: "success" })
    } catch {
      addToast({ message: t("kernel.settings.profile.avatarUploadFailed"), type: "error" })
    } finally {
      setAvatarBusy(false)
    }
  }

  return (
    <div>
      <h1 class="mb-6 text-lg font-semibold text-text">{t("kernel.settings.profile.title")}</h1>

      {/* The desktop's saved servers and the Claude account its local
          sessions run on, first thing in the account area (no OS has a
          native Account menu). The phone draws its servers
          on the You screen instead, and a browser has neither. */}
      <Show when={shellTier() !== "phone" && isDesktop()}>
        <div class="mb-6 overflow-hidden rounded-lg border border-border-subtle pb-1">
          <DesktopServersSection />
          <DesktopClaudeAccount />
        </div>
      </Show>

      <ErrorBoundary fallback={(err) => <p class="p-4 text-sm text-error">{err.message}</p>}>
        <Suspense
          fallback={
            <div class="flex flex-col gap-4">
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
              <Skeleton class="h-8 w-full" />
            </div>
          }
        >
          <Show when={profile()}>
            <div class="mb-6 flex items-center gap-4">
              <div
                data-testid="profile-avatar-preview"
                class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-medium text-text-secondary"
                style={{ "background-color": "var(--color-surface-hover)" }}
              >
                <AvatarImage
                  url={avatarUrl()}
                  alt={profile()!.name}
                  class="h-16 w-16 rounded-full object-cover"
                  fallback={<span>{initialsOf(name() || profile()!.name)}</span>}
                />
              </div>
              <div class="flex flex-col gap-2">
                <span class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.avatarLabel")}
                </span>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept={AVATAR_ACCEPT_ATTR}
                  class="hidden"
                  data-testid="profile-avatar-file-input"
                  onChange={(e) => void handleAvatarSelected(e)}
                />
                <div class="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={avatarBusy()}
                    data-testid="profile-avatar-change"
                    onClick={() => avatarInputRef?.click()}
                  >
                    {t("kernel.settings.profile.changePicture")}
                  </Button>
                  <Show when={avatarUrl()}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={avatarBusy()}
                      data-testid="profile-avatar-remove"
                      onClick={() => void handleRemoveAvatar()}
                    >
                      {t("kernel.settings.profile.removePicture")}
                    </Button>
                  </Show>
                </div>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.profile.avatarHint")}
                </p>
              </div>
            </div>

            <form onSubmit={handleSave} class="flex flex-col gap-4">
              <Input
                label={t("kernel.settings.profile.displayName")}
                value={name()}
                onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              />
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.language")}
                </label>
                <select
                  data-testid="settings-language-select"
                  aria-label={t("kernel.settings.language")}
                  value={language()}
                  onChange={(e) =>
                    void handleLanguageChange(e.currentTarget.value as ShippedLocale | "")
                  }
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">
                    {t("kernel.settings.languageOrgDefault", {
                      language: t(
                        fallbackLocale() === "fr"
                          ? "kernel.settings.languageFrench"
                          : "kernel.settings.languageEnglish",
                      ),
                    })}
                  </option>
                  <option value="en">{t("kernel.settings.languageEnglish")}</option>
                  <option value="fr">{t("kernel.settings.languageFrench")}</option>
                </select>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.languageDescription")}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.theme")}
                </label>
                <select
                  data-testid="settings-theme-select"
                  aria-label={t("kernel.settings.theme")}
                  value={themePref()}
                  onChange={(e) => void handleThemeChange(e.currentTarget.value as ThemePreference)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="system">{t("kernel.settings.themeSystem")}</option>
                  <option value="light">{t("kernel.settings.themeLight")}</option>
                  <option value="dark">{t("kernel.settings.themeDark")}</option>
                </select>
                <p class="text-[12px] text-text-tertiary">
                  {t("kernel.settings.themeDescription")}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.timezone")}
                </label>
                <select
                  aria-label={t("kernel.settings.profile.timezone")}
                  value={timezone()}
                  onChange={(e) => setTimezone(e.currentTarget.value)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">{t("kernel.settings.profile.selectTimezone")}</option>
                  {getTimezones().map((tz) => (
                    <option value={tz}>{tz}</option>
                  ))}
                </select>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.locale")}
                </label>
                <select
                  aria-label={t("kernel.settings.profile.locale")}
                  value={locale()}
                  onChange={(e) => setLocale(e.currentTarget.value)}
                  class="w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
                >
                  <option value="">{t("kernel.settings.profile.selectLocale")}</option>
                  <option value="en-US">{t("kernel.settings.profile.localeEnUs")}</option>
                  <option value="en-GB">{t("kernel.settings.profile.localeEnGb")}</option>
                  <option value="fr-FR">{t("kernel.settings.profile.localeFr")}</option>
                  <option value="de-DE">{t("kernel.settings.profile.localeDe")}</option>
                  <option value="es-ES">{t("kernel.settings.profile.localeEs")}</option>
                  <option value="pt-BR">{t("kernel.settings.profile.localePtBr")}</option>
                  <option value="ja-JP">{t("kernel.settings.profile.localeJa")}</option>
                  <option value="zh-CN">{t("kernel.settings.profile.localeZhCn")}</option>
                </select>
              </div>
              <div class="pt-2">
                <Button fullWidth type="submit" loading={saving()}>
                  {t("kernel.settings.profile.saveChanges")}
                </Button>
              </div>
            </form>

            <AwaySection />

            <div class="mt-6 flex flex-col gap-1.5 border-t border-border pt-6">
              <label
                for="magic-wand-instructions"
                class="text-[12.5px] font-medium text-text-secondary"
              >
                {t("kernel.magicWandLabel")}
              </label>
              <textarea
                id="magic-wand-instructions"
                data-testid="settings-magic-wand-instructions"
                rows={3}
                maxlength={2000}
                aria-busy={savingWand() || undefined}
                value={wandInstructions()}
                onInput={(e) => setWandInstructions(e.currentTarget.value)}
                // Mirrors the language/theme fields above: persist on blur via the
                // dedicated /magic-wand partial endpoint — no extra Save button.
                onBlur={() => void handleSaveWand()}
                placeholder={t("kernel.magicWandPlaceholder")}
                class="w-full resize-y rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"
              />
              <p class="text-[12px] text-text-tertiary">{t("kernel.magicWandHint")}</p>
              <div class="mt-3 flex min-h-11 items-center justify-between gap-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-[12.5px] font-medium text-text-secondary">
                    {t("kernel.dictation.autoCleanLabel")}
                  </span>
                  <span class="text-[12px] text-text-tertiary">
                    {t("kernel.dictation.autoCleanHint")}
                  </span>
                </div>
                <Switch
                  data-testid="settings-dictation-auto-clean"
                  checked={autoClean()}
                  onChange={(next) => void handleAutoCleanChange(next)}
                  label={t("kernel.dictation.autoCleanLabel")}
                />
              </div>
            </div>
          </Show>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

interface AwayPerson {
  id: string
  name: string
  active?: boolean
}
interface AwayRangeView {
  id: string
  from: string
  to: string | null
  everyWeekday: number[] | null
  days: string[]
  nextInLine: (AwayPerson & { active: boolean }) | null
  nextInLineIsDefault: boolean
  setBy: AwayPerson | null
  source?: "said" | "lead" | "calendar"
  runningToday: boolean
}
interface AwayState {
  today: string
  ranges: AwayRangeView[]
  standingNextInLine: (AwayPerson & { active: boolean }) | null
  people: Array<{ id: string; name: string; awayUntil: string | null }>
  /** Calendar events that looked like leave, waiting for Yes or No: dates only. */
  questions: Array<{ id: string; said: string }>
}
interface AwaySaved {
  id: string
  message: string
  cannotDecide: Array<{ label: string; goesTo: string[] }>
  staysWithYou: string[]
}

const AWAY_UNDO_MS = 8_000
const SELECT_CLASS =
  "w-full rounded-sm border border-border bg-bg px-3 py-[9px] text-[13.5px] text-text outline-none transition-colors duration-150 focus:border-accent-muted"

/**
 * The person's own away days and next in line, under the profile. The same writer as the
 * agent's set_away; saving runs at once, with Undo for a few seconds and End early after.
 */
const AwaySection: Component = () => {
  const api = useApi()
  const { t } = useI18n()
  // A failed read leaves the section out rather than the whole profile page.
  const [state, { refetch }] = createResource(() =>
    api
      .get<Partial<AwayState> | null>("/user/preferences/away")
      .then(
        (r): AwayState => ({
          today: r?.today ?? "",
          ranges: Array.isArray(r?.ranges) ? r.ranges : [],
          standingNextInLine: r?.standingNextInLine ?? null,
          people: Array.isArray(r?.people) ? r.people : [],
          questions: Array.isArray(r?.questions) ? r.questions : [],
        }),
      )
      .catch(() => null),
  )
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [nextInLine, setNextInLine] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal<AwaySaved | null>(null)

  const person = (id: string) => state()?.people.find((p) => p.id === id)
  const chosenAwayToo = () => {
    const p = nextInLine() ? person(nextInLine()) : undefined
    return p?.awayUntil ? p : null
  }
  const label = (r: AwayRangeView) =>
    r.everyWeekday
      ? t("kernel.settings.profile.away.weekly", {
          days: r.days.map((d) => d.split(" ")[0]).join(", "),
          from: r.from,
        })
      : r.to === null || r.to === r.from
        ? t("kernel.settings.profile.away.oneDay", { day: r.days[0] ?? r.from })
        : t("kernel.settings.profile.away.range", {
            from: r.days[0] ?? r.from,
            to: r.to,
          })

  async function save(e: Event) {
    e.preventDefault()
    if (!from() || !to()) return
    setSaving(true)
    try {
      const res = await api.post<AwaySaved>("/user/preferences/away", {
        from: from(),
        to: to(),
        ...(nextInLine() ? { nextInLineId: nextInLine() } : {}),
      })
      setSaved(res)
      setFrom("")
      setTo("")
      void refetch()
      addToast({
        message: res.message,
        type: "success",
        durationMs: AWAY_UNDO_MS,
        action: {
          label: t("kernel.settings.profile.away.undo"),
          onClick: () => {
            void api.delete(`/user/preferences/away/${res.id}`).then(() => {
              setSaved(null)
              void refetch()
            })
          },
        },
      })
    } catch (err) {
      addToast({
        message:
          err instanceof Error && err.message
            ? err.message
            : t("kernel.settings.profile.away.failed"),
        type: "error",
      })
    } finally {
      setSaving(false)
    }
  }

  async function endEarly(id: string) {
    try {
      const res = await api.post<{ message: string }>(`/user/preferences/away/${id}/end`, {})
      addToast({ message: res.message, type: "success" })
      void refetch()
    } catch {
      addToast({ message: t("kernel.settings.profile.away.endFailed"), type: "error" })
    }
  }

  async function answer(id: string, yes: boolean) {
    try {
      const res = await api.post<{ message: string }>(`/user/preferences/away/${id}/answer`, {
        yes,
      })
      addToast({ message: res.message, type: "success" })
      void refetch()
    } catch {
      addToast({ message: t("kernel.settings.profile.away.failed"), type: "error" })
    }
  }

  async function setStanding(id: string) {
    try {
      const res = await api.put<{ message: string }>("/user/preferences/away/next-in-line", {
        nextInLineId: id || null,
      })
      addToast({ message: res.message, type: "success" })
      void refetch()
    } catch (err) {
      addToast({
        message:
          err instanceof Error && err.message
            ? err.message
            : t("kernel.settings.profile.away.failed"),
        type: "error",
      })
    }
  }

  const optionLabel = (p: { name: string; awayUntil: string | null }) =>
    p.awayUntil
      ? t("kernel.settings.profile.away.awayUntilOption", { name: p.name, until: p.awayUntil })
      : p.name

  return (
    <section
      data-testid="settings-away"
      class="mt-6 flex flex-col gap-3 border-t border-border pt-6"
    >
      <div class="flex flex-col gap-0.5">
        <span class="text-[12.5px] font-medium text-text-secondary">
          {t("kernel.settings.profile.away.title")}
        </span>
        <span class="text-[12px] text-text-tertiary">{t("kernel.settings.profile.away.hint")}</span>
      </div>
      <Show when={state()}>
        {(s) => (
          <>
            <Show when={s().questions.length > 0}>
              <ul class="flex flex-col gap-2">
                <For each={s().questions}>
                  {(q) => (
                    <li
                      data-testid="settings-away-question"
                      class="flex items-start justify-between gap-3 text-[13px] text-text"
                    >
                      <span class="min-w-0">
                        {t("kernel.settings.profile.away.question", { dates: q.said })}
                      </span>
                      <div class="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="settings-away-question-yes"
                          onClick={() => void answer(q.id, true)}
                        >
                          {t("kernel.settings.profile.away.yes")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="settings-away-question-no"
                          onClick={() => void answer(q.id, false)}
                        >
                          {t("kernel.settings.profile.away.no")}
                        </Button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show
              when={s().ranges.length > 0}
              fallback={
                <p class="text-[12.5px] text-text-tertiary">
                  {t("kernel.settings.profile.away.none")}
                </p>
              }
            >
              <ul class="flex flex-col gap-2">
                <For each={s().ranges}>
                  {(r) => (
                    <li
                      data-testid="settings-away-range"
                      class="flex items-start justify-between gap-3 text-[13px] text-text"
                    >
                      <div class="flex min-w-0 flex-col gap-0.5">
                        <span>{label(r)}</span>
                        <Show when={r.nextInLine}>
                          {(n) => (
                            <span class="text-[12px] text-text-tertiary">
                              {n().active
                                ? t("kernel.settings.profile.away.nextInLineIs", { name: n().name })
                                : t("kernel.settings.profile.away.hasLeft", { name: n().name })}
                            </span>
                          )}
                        </Show>
                        <Show when={r.source === "calendar"}>
                          <span class="text-[12px] text-text-tertiary">
                            {t("kernel.settings.profile.away.fromCalendar")}
                          </span>
                        </Show>
                        <Show when={r.setBy}>
                          {(b) => (
                            <span class="text-[12px] text-text-tertiary">
                              {t("kernel.settings.profile.away.setBy", { name: b().name })}
                            </span>
                          )}
                        </Show>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="settings-away-end"
                        onClick={() => void endEarly(r.id)}
                      >
                        {t("kernel.settings.profile.away.endEarly")}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <form class="flex flex-col gap-3" onSubmit={save}>
              <div class="grid grid-cols-2 gap-3">
                <label class="flex flex-col gap-1.5 text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.away.from")}
                  <input
                    type="date"
                    data-testid="settings-away-from"
                    min={s().today}
                    value={from()}
                    onInput={(e) => setFrom(e.currentTarget.value)}
                    class={SELECT_CLASS}
                  />
                </label>
                <label class="flex flex-col gap-1.5 text-[12.5px] font-medium text-text-secondary">
                  {t("kernel.settings.profile.away.to")}
                  <input
                    type="date"
                    data-testid="settings-away-to"
                    min={from() || s().today}
                    value={to()}
                    onInput={(e) => setTo(e.currentTarget.value)}
                    class={SELECT_CLASS}
                  />
                </label>
              </div>
              <label class="flex flex-col gap-1.5 text-[12.5px] font-medium text-text-secondary">
                {t("kernel.settings.profile.away.nextInLine")}
                <select
                  data-testid="settings-away-next"
                  value={nextInLine()}
                  onChange={(e) => setNextInLine(e.currentTarget.value)}
                  class={SELECT_CLASS}
                >
                  <option value="">
                    {s().standingNextInLine?.name ?? t("kernel.settings.profile.away.nobody")}
                  </option>
                  <For each={s().people}>
                    {(p) => <option value={p.id}>{optionLabel(p)}</option>}
                  </For>
                </select>
              </label>
              <Show when={chosenAwayToo()}>
                {(p) => (
                  <p data-testid="settings-away-too" class="text-[12px] text-text-secondary">
                    {t("kernel.settings.profile.away.awayToo", {
                      name: p().name,
                      until: p().awayUntil ?? "",
                    })}
                  </p>
                )}
              </Show>
              <Show when={saved()}>
                {(r) => (
                  <p data-testid="settings-away-result" class="text-[12px] text-text-secondary">
                    {r().message}
                  </p>
                )}
              </Show>
              <div>
                <Button
                  type="submit"
                  data-testid="settings-away-save"
                  loading={saving()}
                  disabled={!from() || !to()}
                >
                  {t("kernel.settings.profile.away.save")}
                </Button>
              </div>
            </form>
            <label class="flex flex-col gap-1.5 text-[12.5px] font-medium text-text-secondary">
              {t("kernel.settings.profile.away.standing")}
              <select
                data-testid="settings-away-standing"
                value={s().standingNextInLine?.id ?? ""}
                onChange={(e) => void setStanding(e.currentTarget.value)}
                class={SELECT_CLASS}
              >
                <option value="">{t("kernel.settings.profile.away.nobody")}</option>
                <For each={s().people}>{(p) => <option value={p.id}>{optionLabel(p)}</option>}</For>
              </select>
              <span class="text-[12px] font-normal text-text-tertiary">
                {t("kernel.settings.profile.away.standingHint")}
              </span>
            </label>
            <Show when={s().standingNextInLine && !s().standingNextInLine?.active}>
              <p class="text-[12px] text-text-secondary">
                {t("kernel.settings.profile.away.hasLeft", {
                  name: s().standingNextInLine?.name ?? "",
                })}
              </p>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}

export default ProfileSettings
