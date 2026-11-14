// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `ctx.turn.get()`: which agent acts and whether a person is behind the turn, read from the frame
// captured when the bridge was built. A handler's bridge calls run after a hop that lost the
// frame, so the answer must survive it (the session bridge rebuilds per call, outside the frame).

import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { RlsClient } from "~/db"
import type { RlsSession } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const poisonTx = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined
      throw new Error(`turn_get touched txDb.${String(prop)}`)
    },
  },
) as unknown as RlsClient

const ORG = randomUUID()
const USER = randomUUID()
const AGENT = randomUUID()
const APP = "turn-probe"

function frame(extra: Partial<RunContext>): RunContext {
  const runId = randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, agentId: AGENT, ...extra }
}

type Bridge = Record<string, (...args: unknown[]) => Promise<string>>

async function turnOf(build: () => Bridge, inFrame: RunContext | null) {
  // Built inside the frame (or none), read after it has ended.
  const bridge = inFrame ? runContextStore.run(inFrame, build) : build()
  return JSON.parse(await bridge.turn_get!()) as { agentId: string | null; hasPerson: boolean }
}

const plain = () => createRpcBridge(APP, USER, ORG, poisonTx, { name: APP }) as Bridge
const session = () =>
  createSessionRpcBridge(
    APP,
    USER,
    ORG,
    {
      run: async (fn: (tx: RlsClient) => Promise<unknown>) => fn(poisonTx),
    } as unknown as RlsSession,
    { name: APP },
  ) as Bridge

describe("ctx.turn", () => {
  it("a routine turn reads hasPerson false, a person's turn true, and the agent id is the acting agent", async () => {
    for (const build of [plain, session]) {
      expect(await turnOf(build, frame({ routineId: randomUUID() }))).toEqual({
        agentId: AGENT,
        hasPerson: false,
      })
      expect(await turnOf(build, frame({ humanTurn: true }))).toEqual({
        agentId: AGENT,
        hasPerson: true,
      })
      // A background turn has no person behind it, even one a person started earlier.
      expect(await turnOf(build, frame({ humanTurn: true, background: true }))).toEqual({
        agentId: AGENT,
        hasPerson: false,
      })
      // No frame: a job or a webhook. No agent, no person.
      expect(await turnOf(build, null)).toEqual({ agentId: null, hasPerson: false })
    }
  })
})
