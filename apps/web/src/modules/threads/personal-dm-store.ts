// SPDX-License-Identifier: FSL-1.1-ALv2

import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { getAttentionApi } from "~/modules/shell/attention-store"
import {
  activeThreadId,
  collapse as collapseDockTab,
  dockAvailable,
  tabs as dockTabs,
  openConversation,
} from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { agentDirectoryLoaded, loadAgentDirectory, personalAgentFor } from "./agent-directory"
import { sendMessage } from "./message-store"

export interface PersonalDmApi {
  get: (path: string) => Promise<any>
  post: (path: string, body: any) => Promise<any>
}

/** The one route this store is allowed to call. Per-session `agent_chat`
 *  thread creation (`POST /threads` with `type: "agent_chat"`) is the old
 *  path this store replaces; a later task retires it. This store must never
 *  call that route. */
const DM_PATH = "/threads/dm"

let cachedId: string | undefined
/** The resolved DM id as a signal, for watchers that react to it (the tour engine). */
const [knownDmId, setKnownDmId] = createSignal<string | undefined>(undefined)
let inFlight: Promise<string> | null = null

/** One resolved DM thread id per agent, so the directory's Message action and
 *  the personal chat gesture never mint a second thread for the same agent. */
const dmByAgent = new Map<string, string>()
const dmInFlight = new Map<string, Promise<string>>()

async function postDm(api: PersonalDmApi, agentId: string): Promise<string> {
  const res = await api.post(DM_PATH, { agentId })
  const thread = res?.data ?? res
  const id = thread?.id
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("personal-dm-store: /threads/dm did not return a thread id")
  }
  return id
}

/**
 * The caller's DM with ANY agent they may address, resolved once per agent and
 * per session. `POST /threads/dm` is idempotent server side; this cache keeps
 * the client from asking twice for the same agent (the agents directory
 * renders one Message action per card).
 */
export function dmWithAgent(api: PersonalDmApi, agentId: string): Promise<string> {
  const known = dmByAgent.get(agentId)
  if (known) return Promise.resolve(known)
  const pending = dmInFlight.get(agentId)
  if (pending) return pending
  const promise = postDm(api, agentId)
    .then((id) => {
      dmByAgent.set(agentId, id)
      dmInFlight.delete(agentId)
      return id
    })
    .catch((err) => {
      dmInFlight.delete(agentId)
      throw err
    })
  dmInFlight.set(agentId, promise)
  return promise
}

/**
 * Open the DM with one agent on whichever surface fits where the user is: a
 * thread tab on a Home surface, the dock anywhere else (the same rule
 * `discussWithPersonalAgent` follows). `label` names the tab, so the agent's
 * display name reaches the tab bar without this store re-reading the roster.
 */
export async function openDmWithAgent(
  agentId: string,
  label?: string,
  api?: PersonalDmApi,
): Promise<string> {
  const threadId = await dmWithAgent(resolveApi(api), agentId)
  revealThread(threadId, label)
  return threadId
}

async function resolve(api: PersonalDmApi): Promise<string> {
  if (!agentDirectoryLoaded()) {
    await loadAgentDirectory(api)
  }
  const userId = userFromToken()?.userId
  const agent = personalAgentFor(userId)
  if (!agent) {
    throw new Error("personal-dm-store: no personal agent found for the current user")
  }
  return dmWithAgent(api, agent.id)
}

/**
 * The caller's DM with their personal agent, resolved lazily and once per
 * session. The id comes from `POST /threads/dm` with the personal agent id
 * that the mentionable-agents roster (`agent-directory`) already exposes for
 * this user (`kind === "personal"`, `ownerUserId === me`) — never a second
 * roster fetch, and never `POST /threads` with `type: "agent_chat"`.
 *
 * The first call from either this function or `ensurePersonalAgentDm` issues
 * the POST; every later call, from any caller, reuses the same in-flight or
 * resolved id until `resetPersonalDmStore` runs (session teardown).
 */
export function personalAgentDmId(api: PersonalDmApi): Promise<string> {
  return ensurePersonalAgentDm(api)
}

/**
 * Record the personal agent DM's id when a surface already knows it (the
 * Chats list holds the thread), so every reader of `knownPersonalAgentDmId`
 * (the composer's tour guard, the tour's agent-turn watch) sees it without a
 * second `POST /threads/dm`.
 */
export function rememberPersonalAgentDm(id: string): void {
  if (cachedId === id) return
  cachedId = id
  setKnownDmId(id)
}

/** The personal agent DM's id once resolved in this session, else undefined (reactive). */
export function knownPersonalAgentDmId(): string | undefined {
  return knownDmId()
}

/** Imperative counterpart for callers that just need the id (e.g. before
 *  navigating to the DM thread), identical in behavior to `personalAgentDmId`. */
export function ensurePersonalAgentDm(api: PersonalDmApi): Promise<string> {
  if (cachedId) return Promise.resolve(cachedId)
  if (!inFlight) {
    inFlight = resolve(api)
      .then((id) => {
        cachedId = id
        setKnownDmId(id)
        inFlight = null
        return id
      })
      .catch((err) => {
        inFlight = null
        throw err
      })
  }
  return inFlight
}

/** The api to use when a caller has none in hand (stores, keybinding handlers).
 *  It is the same client every module already shares through the shell. */
function resolveApi(api?: PersonalDmApi): PersonalDmApi {
  const client = api ?? (getAttentionApi() as PersonalDmApi | null)
  if (!client) throw new Error("personal-dm-store: no api client available")
  return client
}

/** Kernel Home surfaces: the Home tab and a thread tab. Both already show
 *  conversations full width, so a chat opened from there becomes a thread TAB
 *  rather than a dock tab floating over the same content. */
export function isHomeSurface(): boolean {
  const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
  if (!tab) return false
  const type = tab.type.startsWith("kernel:") ? tab.type.slice("kernel:".length) : tab.type
  return type === "home" || type === "thread"
}

/**
 * The conversation the MAIN panel's active tab holds, or null when its active
 * tab is not a conversation at all. It is what `focusThreadComposer` would put
 * the caret in, named, so a caller can check WHICH conversation that composer
 * writes into before it takes the shortcut.
 */
export function activeThreadTabId(): string | null {
  const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
  if (!tab) return null
  const type = tab.type.startsWith("kernel:") ? tab.type.slice("kernel:".length) : tab.type
  if (type !== "thread") return null
  return tab.entityId ?? null
}

/**
 * Put the caret in the composer of the conversation the user is looking at.
 * ComposeBar exposes no focus affordance (no store signal, no ref registry),
 * so the visible tab's editor is addressed through the markup both already
 * publish: MainPanel marks the active tab `data-tab-active="true"` and
 * ComposeBar tags its editor `data-testid="compose-editor"`. Returns false when
 * there is no composer on screen, so the caller can fall back to the dock.
 */
function focusThreadComposer(): boolean {
  if (typeof document === "undefined") return false
  const editor = document.querySelector<HTMLElement>(
    '[data-tab-active="true"] [data-testid="compose-editor"]',
  )
  if (!editor) return false
  editor.focus()
  return true
}

/** Show a thread to the user on whichever surface fits where they are. */
function revealThread(threadId: string, label?: string): void {
  // F3: at phone tier a conversation is a ROUTE, not an overlay. Every caller
  // of this store (the personal agent row, "Discuss this with Liaison" from
  // Mail and Knowledge, `mod+.`) lands on the thread screen, which is where
  // the phone's own back control already knows how to leave from.
  if (shellTier() === "phone" || (dockAvailable() && isHomeSurface())) {
    openTab({
      type: "thread",
      entityId: threadId,
      label:
        label ??
        localizeAgentName(
          personalAgentFor(userFromToken()?.userId)?.name ?? PERSONAL_AGENT_DISPLAY_NAME,
        ),
    })
    return
  }
  // P4c-T14: Chats sheet — at tablet and phone the dock state below is what
  // the sheet renders, so opening the conversation here is already correct.
  openConversation(threadId)
}

export interface DiscussionSubject {
  /** What the user is looking at, in their words (the entity's label). */
  title: string
  /** Deep link to it — the app route the tab store would open for that entity. */
  link: string
  /**
   * The entity reference `app:entityType:id`, when the caller has one. With it
   * the message carries a REFERENCE the thread renders as a chip that opens the
   * entity, instead of a bare path the reader has to copy: "/mail/af05..." told
   * nobody what it pointed at and opened nothing.
   */
  ref?: string
}

/** A mention label lives inside `@[...]`, so the two characters that could
 *  close it early are escaped. */
function escapeMentionLabel(label: string): string {
  return label.replace(/([\\\]])/g, "\\$1")
}

/**
 * The one message "Discuss this" posts. With an entity reference the link IS
 * the title (the chip renders the entity's name), so the sentence names the
 * thing once rather than repeating it beside a raw path.
 */
export function discussionMessage(subject: DiscussionSubject): string {
  if (subject.ref) {
    return `I want to discuss @[${escapeMentionLabel(subject.title)}](${subject.ref})`
  }
  return `I want to discuss ${subject.title}: ${subject.link}`
}

/**
 * "Discuss this with Liaison": the entity the user is looking at becomes ONE
 * message in their personal DM, authored by them, and the agent's turn starts
 * from the normal send path. There is no discussion thread, no per-entity
 * panel and no hidden seed message: the DM is the single place their agent
 * talks to them.
 */
export async function discussWithPersonalAgent(
  subject: DiscussionSubject,
  api?: PersonalDmApi,
): Promise<void> {
  const client = resolveApi(api)
  const threadId = await ensurePersonalAgentDm(client)
  revealThread(threadId)
  const user = userFromToken()
  await sendMessage(
    client as { post: (path: string, body: unknown) => Promise<any> },
    threadId,
    discussionMessage(subject),
    { id: user?.userId ?? "", name: user?.name ?? "" },
  )
}

/**
 * The `mod+.` / "toggle chat" gesture: bring the personal agent DM up, or put
 * it away when it is already the expanded dock tab in front of the user.
 */
export async function togglePersonalAgentChat(api?: PersonalDmApi): Promise<void> {
  const client = resolveApi(api)
  const threadId = await ensurePersonalAgentDm(client)
  const expandedAndActive =
    activeThreadId() === threadId && dockTabs().some((t) => t.threadId === threadId && t.expanded)
  if (expandedAndActive) {
    collapseDockTab(threadId)
    return
  }
  // ANOTHER CONVERSATION IS IN FRONT OF THE USER. An expanded dock tab sits
  // over whatever the main panel holds, so that conversation is the one being
  // read, and the personal agent comes up beside it rather than behind it.
  if (dockTabs().some((t) => t.expanded && t.threadId !== threadId)) {
    openConversation(threadId)
    return
  }
  // ONLY THEN the caret shortcut, and only for a composer that writes into THIS
  // conversation: the personal agent DM as the main tab, or the Home surface,
  // which renders that same conversation full width and carries no entity id of
  // its own. Every other thread tab is somebody else's composer.
  const mainThread = activeThreadTabId()
  const onOwnComposer = mainThread === threadId || (mainThread === null && isHomeSurface())
  if (onOwnComposer && focusThreadComposer()) return
  revealThread(threadId)
}

/**
 * The personal agent DM for a caller that may hold no api client, and the way it is shown: the
 * pair the dock's prefill uses (shell/dock-prefill.ts).
 */
export function personalAgentDmFor(api?: PersonalDmApi): Promise<string> {
  return ensurePersonalAgentDm(resolveApi(api))
}
export function revealPersonalAgentDm(threadId: string): void {
  revealThread(threadId)
}

export function resetPersonalDmStore(): void {
  cachedId = undefined
  setKnownDmId(undefined)
  inFlight = null
  dmByAgent.clear()
  dmInFlight.clear()
}
onSessionTeardown(resetPersonalDmStore)
