// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A payment processor key typed into the composer is not sent. The send stops,
// the draft stays in the field, and a line under it says why. The server masks
// a key that arrives some other way (threads/key-mask.integration.test.ts).

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import { ApiProvider } from "~/modules/shell/ApiContext"
import ComposeBar from "~/modules/threads/ComposeBar"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

afterEach(cleanup)

const LIVE_SECRET = `sk_live_${"51HxQzA9bC3dE4fG5hI6jK7lM8"}`
const TEST_RESTRICTED = `rk_test_${"51HxQzA9bC3dE4fG5hI6jKmN"}`
const SIGNING = `whsec_${"Kx8pYQ2mZ7cV3nB6vR1tW9aS4dF0gH5j"}`

async function renderCompose() {
  const onSend = vi.fn()
  render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ComposeBar onSend={onSend} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
  const editor = await screen.findByRole("textbox", { name: "Write a message" })
  const type = (text: string) => {
    const ed = editorOf(editor)
    ed.commands.clearContent()
    typeInto(ed, text)
  }
  const send = () => fireEvent.keyDown(editor, { key: "Enter" })
  return { editor, onSend, type, send }
}

describe("composer key block", () => {
  it("the composer stops a message holding a key and says why", async () => {
    for (const key of [LIVE_SECRET, TEST_RESTRICTED, SIGNING]) {
      const { onSend, type, send, editor } = await renderCompose()
      type(`here is our key ${key} for the setup`)
      send()
      expect(onSend).not.toHaveBeenCalled()
      const line = screen.getByTestId("compose-key-blocked")
      expect(line.textContent).toBe(en.composerKeyBlocked)
      expect(line.getAttribute("role")).toBe("alert")
      // The draft stays, so the person can take the key out and send the rest.
      expect(editor.textContent).toContain(key)
      cleanup()
    }
  })

  it("taking the key out clears the line and the message sends", async () => {
    const { onSend, type, send } = await renderCompose()
    type(`key ${LIVE_SECRET}`)
    send()
    expect(screen.getByTestId("compose-key-blocked")).toBeTruthy()
    type("key removed, the setup is done")
    expect(screen.queryByTestId("compose-key-blocked")).toBeNull()
    send()
    expect(onSend).toHaveBeenCalledWith("key removed, the setup is done", undefined)
  })

  it("a key prefix with too few characters, or a publishable key, is sent", async () => {
    const { onSend, type, send } = await renderCompose()
    type("the restricted key starts with rk_live_ and pk_live_51HxQzA9bC3dE4fG5h is public")
    send()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("compose-key-blocked")).toBeNull()
  })

  it("the reason has a French translation", () => {
    expect(fr.composerKeyBlocked).toBeTruthy()
    expect(fr.composerKeyBlocked).not.toBe(en.composerKeyBlocked)
  })
})
