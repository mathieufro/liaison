// SPDX-License-Identifier: FSL-1.1-ALv2
// The edition switch: only LIAISON_EDITION=managed is managed. The legacy
// control-plane pair alone never switches managed on (such a server refuses to
// boot, lib/managed-boot.ts); anything else is self-hosted.
import { afterEach, describe, expect, it } from "bun:test"
import {
  _setEdition,
  detectEdition,
  edition,
  isManagedEdition,
  toolMeaningEnabled,
} from "~/lib/edition"
import { env } from "~/lib/env"

const saved = env.LIAISON_EDITION
const savedMeaning = env.LIAISON_TOOL_MEANING
const setMeaningEnv = (v: "on" | "off" | undefined) => {
  ;(env as { LIAISON_TOOL_MEANING?: string }).LIAISON_TOOL_MEANING = v
}
const setEditionEnv = (v: "managed" | "self_hosted" | undefined) => {
  ;(env as { LIAISON_EDITION?: string }).LIAISON_EDITION = v
}

afterEach(() => {
  setEditionEnv(saved)
  setMeaningEnv(savedMeaning)
  _setEdition(null)
})

describe("detectEdition", () => {
  const base = { NODE_ENV: "production" }
  it.each([
    ["nothing set", {}, "self_hosted"],
    ["LIAISON_EDITION=managed", { LIAISON_EDITION: "managed" }, "managed"],
    ["LIAISON_EDITION=self_hosted", { LIAISON_EDITION: "self_hosted" }, "self_hosted"],
    [
      "the legacy control-plane pair alone",
      { CONTROL_PLANE_URL: "https://cp.example", CONTROL_PLANE_API_KEY: "k" },
      "self_hosted",
    ],
    [
      "an explicit self_hosted wins over the legacy pair",
      {
        LIAISON_EDITION: "self_hosted",
        CONTROL_PLANE_URL: "https://cp.example",
        CONTROL_PLANE_API_KEY: "k",
      },
      "self_hosted",
    ],
    ["half the legacy pair", { CONTROL_PLANE_URL: "https://cp.example" }, "self_hosted"],
  ] as const)("%s -> %s", (_label, vars, expected) => {
    expect(detectEdition({ ...base, ...vars })).toBe(expected)
  })
})

describe("edition()", () => {
  it("follows LIAISON_EDITION at call time", () => {
    _setEdition(null)
    setEditionEnv("managed")
    expect(edition()).toBe("managed")
    expect(isManagedEdition()).toBe(true)
    setEditionEnv("self_hosted")
    expect(isManagedEdition()).toBe(false)
  })

  it("the test override still wins", () => {
    setEditionEnv("managed")
    _setEdition("self_hosted")
    expect(isManagedEdition()).toBe(false)
  })
})

describe("tool search by meaning", () => {
  it("is on by default in the managed edition", () => {
    setMeaningEnv(undefined)
    _setEdition("managed")
    expect(toolMeaningEnabled()).toBe(true)
  })

  it("is off by default on a self-hosted server, so no model loads", () => {
    setMeaningEnv(undefined)
    _setEdition("self_hosted")
    expect(toolMeaningEnabled()).toBe(false)
  })

  it("LIAISON_TOOL_MEANING=on turns it on for a self-hosted server", () => {
    setMeaningEnv("on")
    _setEdition("self_hosted")
    expect(toolMeaningEnabled()).toBe(true)
  })

  it("LIAISON_TOOL_MEANING=off turns it off in the managed edition", () => {
    setMeaningEnv("off")
    _setEdition("managed")
    expect(toolMeaningEnabled()).toBe(false)
  })
})
