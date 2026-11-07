// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import ProfileSettings from "~/modules/settings/ProfileSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { ThemeStoreTestAccess } from "~/modules/shell/theme-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

describe("ProfileSettings", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // A Response body can only be read once, so every call must get a FRESH
    // Response. `mockResolvedValue` would hand the same instance to the profile
    // GET and the preferences GET, and the second read rejects with
    // "Body has already been read" outside any assertion.
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The desktop's saved servers head the account area: no OS has a native
  // Account menu, so Settings is where servers are managed.
  it("shows the desktop's servers group first, and none in a browser", async () => {
    const renderProfile = () =>
      render(() => (
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      ))
    const first = renderProfile()
    expect(screen.queryByTestId("you-group-servers")).toBeNull()
    expect(screen.queryByTestId("desktop-claude-account")).toBeNull()
    first.unmount()
    installFakeBridge(
      {},
      {
        platform: "windows",
        servers: {
          list: async () => ({
            current: "https://liaison.acme.example",
            servers: [{ address: "https://liaison.acme.example", label: "Acme" }],
          }),
          add: async () => {},
          switchTo: async () => {},
          remove: async () => {},
          signOut: async () => {},
          confirmsRemoval: true,
        },
      },
    )
    try {
      renderProfile()
      expect(await screen.findByTestId("you-group-servers")).toBeInTheDocument()
      expect((await screen.findAllByTestId("you-server-row"))[0].textContent).toBe("Acme")
      // The Claude account sits beside the servers on every desktop OS.
      expect(await screen.findByTestId("desktop-claude-account")).toBeInTheDocument()
    } finally {
      uninstallFakeBridge()
    }
  })

  it("renders profile form fields", async () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <ProfileSettings />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    expect(screen.getByText("Profile")).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText("Display name")).toBeInTheDocument()
      expect(screen.getByLabelText("Timezone")).toBeInTheDocument()
      expect(screen.getByLabelText("Locale")).toBeInTheDocument()
    })
  })

  it("language select persists via prefs PUT and flips t() reactively", async () => {
    // Profile GET + prefs GET both 200; capture the prefs PUT body.
    let putBody: unknown
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/user/preferences") && init?.method === "PUT") {
        putBody = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ data: putBody }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))

    const select = (await screen.findByTestId("settings-language-select")) as HTMLSelectElement
    // English value before the switch.
    expect(screen.getByText("Profile")).toBeInTheDocument()

    fireEvent.change(select, { target: { value: "fr" } })

    await waitFor(() => {
      expect(putBody).toMatchObject({ language: "fr" })
    })
    // t() flips reactively without remount: the heading is now French.
    await waitFor(() => {
      expect(screen.getByText("Profil")).toBeInTheDocument()
    })
  })

  it("hydrates theme from /user/preferences on mount", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/user/preferences")) {
        return new Response(
          JSON.stringify({
            data: {
              userId: "u1",
              digestCadence: "daily",
              workHoursStart: "09:00",
              workHoursEnd: "17:00",
              workDays: [1, 2, 3, 4, 5],
              timezone: "UTC",
              language: "en",
              theme: "dark",
              lastDailySentAt: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(
        JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    // Pre-existing local preference is 'system' — server hydrate must win.
    localStorage.setItem("liaison:theme", "system")
    document.documentElement.removeAttribute("data-theme")
    ThemeStoreTestAccess.reset()

    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <ProfileSettings />
            </ApiProvider>
          )}
        />
      </Router>
    ))

    await waitFor(() => {
      expect(localStorage.getItem("liaison:theme")).toBe("dark")
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark")
    })
  })

  it("renders three theme options (System / Light / Dark)", async () => {
    ThemeStoreTestAccess.reset()
    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))
    const picker = (await screen.findByTestId("settings-theme-select")) as HTMLSelectElement
    expect(picker).toBeTruthy()
    expect(picker.querySelectorAll("option").length).toBe(3)
  })

  it("selecting Light fires PUT /user/preferences/theme with body { theme: 'light' }", async () => {
    ThemeStoreTestAccess.reset()
    let putUrl: string | undefined
    let putBody: unknown
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.includes("/user/preferences/theme") &&
        init?.method === "PUT"
      ) {
        putUrl = url
        putBody = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ data: putBody }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))
    const picker = (await screen.findByTestId("settings-theme-select")) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: "light" } })
    await waitFor(() => {
      expect(putUrl).toMatch(/\/user\/preferences\/theme$/)
      expect(putBody).toEqual({ theme: "light" })
    })
  })

  it("selecting theme updates data-theme attribute immediately (optimistic)", async () => {
    ThemeStoreTestAccess.reset()
    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))
    const picker = (await screen.findByTestId("settings-theme-select")) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: "light" } })
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light")
    })
  })

  it("PUT failure surfaces toast and reverts to previous selection", async () => {
    ThemeStoreTestAccess.reset()
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.includes("/user/preferences/theme") &&
        init?.method === "PUT"
      ) {
        return new Response(JSON.stringify({ error: { message: "net" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route
            path="*"
            component={() => (
              <ApiProvider>
                <ProfileSettings />
              </ApiProvider>
            )}
          />
        </Router>
      </I18nProvider>
    ))
    resetToastStore()
    const picker = (await screen.findByTestId("settings-theme-select")) as HTMLSelectElement
    // Theme was 'system' before the click — capture it for revert assertion.
    fireEvent.change(picker, { target: { value: "light" } })
    await waitFor(() => {
      expect(toasts().some((tt) => /Failed to update theme/i.test(tt.message))).toBe(true)
    })
    // Optimistic flip rolled back to the previous concrete value (which was
    // 'system' resolving to 'dark' under the matchMedia polyfill: matches=false → 'light').
    await waitFor(() => {
      expect(picker.value).not.toBe("light")
    })
  })

  it("renders save button", async () => {
    render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <ProfileSettings />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument()
    })
  })

  it("dictation clean-up: on by default, off from the stored preference, saved on its own endpoint", async () => {
    let putBody: unknown
    let putUrl: string | undefined
    let stored: boolean | undefined = false
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/user/preferences/dictation")) {
        putUrl = url
        putBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ data: putBody }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (typeof url === "string" && url.endsWith("/user/preferences")) {
        return new Response(JSON.stringify({ data: { dictationAutoClean: stored } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify({ data: { id: "1", name: "Test", email: "test@test.com" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const mount = () =>
      render(() => (
        <I18nProvider initialLocale="en">
          <Router>
            <Route
              path="*"
              component={() => (
                <ApiProvider>
                  <ProfileSettings />
                </ApiProvider>
              )}
            />
          </Router>
        </I18nProvider>
      ))
    const first = mount()
    const off = await screen.findByTestId("settings-dictation-auto-clean")
    await waitFor(() => expect(off.getAttribute("aria-checked")).toBe("false"))
    expect(screen.getByText("Clean up dictation automatically")).toBeInTheDocument()
    fireEvent.click(off)
    await waitFor(() => {
      expect(putUrl).toMatch(/\/user\/preferences\/dictation$/)
      expect(putBody).toEqual({ autoClean: true })
    })
    expect(off.getAttribute("aria-checked")).toBe("true")
    first.unmount()

    // No stored value: the default is on.
    stored = undefined
    mount()
    const on = await screen.findByTestId("settings-dictation-auto-clean")
    await waitFor(() => expect(on.getAttribute("aria-checked")).toBe("true"))
  })

  describe("Away", () => {
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const AWAY = {
      today: "2026-11-07",
      standingNextInLine: { id: "u-lea", name: "Léa Fontaine", active: false },
      people: [
        { id: "u-tom", name: "Tom Reyes", awayUntil: "2026-11-20" },
        { id: "u-sara", name: "Sara Benali", awayUntil: null },
      ],
      ranges: [
        {
          id: "r-1",
          from: "2026-11-23",
          to: "2026-11-27",
          everyWeekday: null,
          days: ["Mon 23 Nov 2026", "Tue 24 Nov 2026", "Wed 25 Nov 2026"],
          nextInLine: { id: "u-sara", name: "Sara Benali", active: true },
          nextInLineIsDefault: false,
          setBy: { id: "u-lead", name: "Nadia Lead" },
          runningToday: false,
        },
      ],
      questions: [{ id: "q-1", said: "from Mon 14 Dec 2026 to Fri 18 Dec 2026" }],
    }

    function mountAway(calls: Array<{ url: string; method: string; body?: unknown }>) {
      fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        if (url.includes("/user/preferences/away") && method === "GET") return json(AWAY)
        if (url.endsWith("/user/preferences/away") && method === "POST") {
          return json({
            id: "r-new",
            message: "Recorded: you are away from Mon 30 Nov 2026 to Fri 4 Dec 2026.",
            cannotDecide: [],
            staysWithYou: [],
          })
        }
        if (url.includes("/user/preferences/away/"))
          return json({ message: "Ended.", undone: true })
        return json({ id: "1", name: "Test", email: "test@test.com" })
      })
      vi.stubGlobal("fetch", fetchMock)
      resetToastStore()
      render(() => (
        <I18nProvider initialLocale="en">
          <Router>
            <Route
              path="*"
              component={() => (
                <ApiProvider>
                  <ProfileSettings />
                </ApiProvider>
              )}
            />
          </Router>
        </I18nProvider>
      ))
    }

    it("lists a range with who set it and its next in line, and End early ends it", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      mountAway(calls)
      const row = await screen.findByTestId("settings-away-range")
      expect(row.textContent).toContain("Mon 23 Nov 2026 to 2026-11-27")
      expect(row.textContent).toContain("Next in line: Sara Benali")
      expect(row.textContent).toContain("Set by Nadia Lead")
      // A standing next in line who left is named, with what to do.
      expect(screen.getByText("Léa Fontaine has left, choose someone.")).toBeInTheDocument()
      fireEvent.click(screen.getByTestId("settings-away-end"))
      await waitFor(() =>
        expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/away/r-1/end"))).toBe(
          true,
        ),
      )
    })

    it("asks about a calendar event with its dates only, and Yes answers it", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      mountAway(calls)
      const q = await screen.findByTestId("settings-away-question")
      expect(q.textContent).toContain(
        "Your calendar has an event from Mon 14 Dec 2026 to Fri 18 Dec 2026 that looks like time off.",
      )
      fireEvent.click(screen.getByTestId("settings-away-question-yes"))
      await waitFor(() =>
        expect(
          calls.find((c) => c.method === "POST" && c.url.endsWith("/away/q-1/answer"))?.body,
        ).toEqual({ yes: true }),
      )
    })

    it("says the chosen next in line is away too before saving", async () => {
      mountAway([])
      const next = (await screen.findByTestId("settings-away-next")) as HTMLSelectElement
      expect(screen.queryByTestId("settings-away-too")).toBeNull()
      fireEvent.change(next, { target: { value: "u-tom" } })
      expect((await screen.findByTestId("settings-away-too")).textContent).toBe(
        "Tom Reyes is away too, until 2026-11-20.",
      )
      fireEvent.change(next, { target: { value: "u-sara" } })
      await waitFor(() => expect(screen.queryByTestId("settings-away-too")).toBeNull())
    })

    it("saving posts the dates, states the result, and Undo takes it back", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      mountAway(calls)
      fireEvent.input(await screen.findByTestId("settings-away-from"), {
        target: { value: "2026-11-30" },
      })
      fireEvent.input(screen.getByTestId("settings-away-to"), { target: { value: "2026-12-04" } })
      fireEvent.change(screen.getByTestId("settings-away-next"), { target: { value: "u-sara" } })
      fireEvent.click(screen.getByTestId("settings-away-save"))
      await waitFor(() =>
        expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/away"))?.body).toEqual({
          from: "2026-11-30",
          to: "2026-12-04",
          nextInLineId: "u-sara",
        }),
      )
      expect((await screen.findByTestId("settings-away-result")).textContent).toContain(
        "Mon 30 Nov 2026",
      )
      const toast = toasts().find((tt) => tt.message.startsWith("Recorded:"))
      expect(toast?.action?.label).toBe("Undo")
      toast?.action?.onClick()
      await waitFor(() =>
        expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/away/r-new"))).toBe(
          true,
        ),
      )
    })
  })
})
