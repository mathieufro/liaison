// SPDX-License-Identifier: FSL-1.1-ALv2
// The software world's recorded coding session: the same shape the replay plays
// (one permission request, a denied ending), a fiction that says it is recorded
// wherever a person reads it, with its links on the reserved stand-in host only.
import { describe, expect, it } from "bun:test"
import { recordingSchema } from "~/modules/demo/replay/replay"
import recordingJson from "./recording.saas.json"

const recording = recordingSchema.parse(recordingJson)
const text = JSON.stringify(recording)

describe("the software world's recording", () => {
  it("plays the replay's shape: one permission request and a denied ending", () => {
    expect(recording.events.filter((e) => e.type === "permission_request")).toHaveLength(1)
    expect(recording.denied.at(-1)?.type).toBe("result")
    expect(recording.events.at(-1)?.type).toBe("result")
    expect(recording.events.at(-1)?.payload).toMatchObject({ pushed: true })
    expect(recording.denied.at(-1)?.payload).toMatchObject({ pushed: false })
  })

  it("says recorded, and links only on the stand-in host", () => {
    expect(text).toMatch(/recorded session/i)
    const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]))
    expect([...hosts]).toEqual(["github-standin.example"])
  })

  it("fixes the bug the seeded support ticket reports: the export that stops after four venues", () => {
    expect(recording.title).toContain("payroll export")
    expect(recording.prompt).toContain("fourth venue")
    expect(recording.events.at(-1)?.payload).toMatchObject({
      prUrl: expect.stringContaining("github-standin.example"),
    })
  })
})
