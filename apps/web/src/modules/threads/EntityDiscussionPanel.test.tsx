// SPDX-License-Identifier: FSL-1.1-ALv2
// A bundled app draws the discussion of one of its records through the host
// service, since it cannot import the kernel's component: the host opens the
// discussion for the record and renders it into the app's own node. A failed
// open says so with Retry, and the app's page around it stands.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { type Component, onCleanup, onMount } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildHostServices } from "~/framework/host-services"

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

vi.mock("~/modules/shell/ApiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/ApiContext")>()),
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/threads/EntityDiscussion", () => ({
  default: (p: { threadId: string; testId: string; emptyText: string }) => (
    <div data-testid={p.testId} data-thread={p.threadId}>
      {p.emptyText}
    </div>
  ),
}))

const host = buildHostServices({
  getAccessToken: () => "tok",
  onUnauthorized: () => {},
  onError: () => {},
})

/** The example app's item page, written as a bundle writes it: a node of its own, handed to the host. */
const ExampleItemPage: Component<{ itemId: string }> = (props) => {
  let node: HTMLDivElement | undefined
  onMount(() => {
    const handle = host.mountEntityDiscussion!("example", node as never, {
      entityType: "items",
      entityId: props.itemId,
      emptyText: "Nothing said about this item yet.",
    })
    onCleanup(() => handle.dispose())
  })
  return (
    <div data-testid="example-item-page">
      <h1>Item {props.itemId}</h1>
      <div ref={node} />
    </div>
  )
}

beforeEach(() => {
  mocks.api.post.mockReset()
})
afterEach(() => cleanup())

describe("host.mountEntityDiscussion", () => {
  it("example mounts through host.mountEntityDiscussion", async () => {
    mocks.api.post.mockResolvedValue({ data: { threadId: "th-item-1", created: true } })
    render(() => <ExampleItemPage itemId="item-1" />)
    const thread = await screen.findByTestId("entity-discussion.thread")
    expect(thread.getAttribute("data-thread")).toBe("th-item-1")
    expect(thread.textContent).toBe("Nothing said about this item yet.")
    expect(mocks.api.post).toHaveBeenCalledWith("/threads/entity-discussion", {
      app: "example",
      entityType: "items",
      entityId: "item-1",
    })
  })

  it("route failure shows Retry and the page stands", async () => {
    mocks.api.post.mockRejectedValueOnce(new Error("404"))
    render(() => <ExampleItemPage itemId="item-2" />)
    const retry = await screen.findByTestId("entity-discussion.retry")
    expect(screen.getByTestId("entity-discussion.unavailable")).toBeTruthy()
    expect(screen.getByTestId("example-item-page").querySelector("h1")?.textContent).toBe(
      "Item item-2",
    )
    mocks.api.post.mockResolvedValueOnce({ data: { threadId: "th-item-2", created: false } })
    fireEvent.click(retry)
    await waitFor(() =>
      expect(screen.getByTestId("entity-discussion.thread").getAttribute("data-thread")).toBe(
        "th-item-2",
      ),
    )
    expect(mocks.api.post).toHaveBeenCalledTimes(2)
  })

  it("an isolated host without the service lets the app draw its own fallback", () => {
    const anchor = document.createElement("div")
    // Called outside any component: no page tree to render the discussion in.
    const handle = host.mountEntityDiscussion!("example", anchor, {
      entityType: "items",
      entityId: "item-3",
    })
    expect(handle.resolved).toBe(false)
    expect(anchor.childNodes.length).toBe(0)
  })
})
