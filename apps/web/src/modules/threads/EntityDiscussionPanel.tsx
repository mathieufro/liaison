// SPDX-License-Identifier: FSL-1.1-ALv2
// The discussion of any record an app declares (`entities.<type>.discussion`):
// opens it through `POST /threads/entity-discussion` (the server enrols whoever
// may see the record, and answers 404 to anyone else), then draws it with the
// same EntityDiscussion a task and a contact use. While it opens it says so; a
// failed open says so with Retry, and the page around it stands.
//
// A bundled app cannot import this component: it mounts it through the host
// service `host.mountEntityDiscussion` (framework/host-services.ts).

import { type Component, createSignal, lazy, onMount, Show, Suspense } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

const EntityDiscussion = lazy(() => import("~/modules/threads/EntityDiscussion"))

export interface EntityDiscussionPanelProps {
  app: string
  entityType: string
  entityId: string
  /** The root data-testid (default `entity-discussion`). */
  testId?: string
  emptyText?: string
  placeholder?: string
  sendLabel?: string
}

function unwrapData<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in result
    ? (result as { data: T }).data
    : (result as T)
}

export const EntityDiscussionPanel: Component<EntityDiscussionPanelProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const tid = () => props.testId ?? "entity-discussion"
  const [threadId, setThreadId] = createSignal<string | null>(null)
  const [failed, setFailed] = createSignal(false)
  const [opening, setOpening] = createSignal(false)

  const openDiscussion = async (): Promise<void> => {
    if (opening()) return
    setOpening(true)
    setFailed(false)
    try {
      if (!api.post) throw new Error("this api client cannot post")
      const opened = unwrapData<{ threadId: string }>(
        await api.post("/threads/entity-discussion", {
          app: props.app,
          entityType: props.entityType,
          entityId: props.entityId,
        }),
      )
      setThreadId(opened.threadId)
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  onMount(() => {
    void openDiscussion()
  })

  return (
    <section data-testid={tid()} class="flex min-h-0 flex-col gap-3">
      <Show
        when={threadId()}
        fallback={
          <Show
            when={failed()}
            fallback={
              <p data-testid={`${tid()}.loading`} class="py-2 text-[12.5px] text-text-tertiary">
                {i18n.t("kernel.entityDiscussion.loading")}
              </p>
            }
          >
            <div
              data-testid={`${tid()}.unavailable`}
              class="flex items-center gap-3 py-2 text-[12.5px] text-text-tertiary"
            >
              <span>{i18n.t("kernel.entityDiscussion.unavailable")}</span>
              <button
                type="button"
                data-testid={`${tid()}.retry`}
                class="text-text-secondary underline-offset-2 hover:underline"
                onClick={() => void openDiscussion()}
              >
                {i18n.t("kernel.entityDiscussion.retry")}
              </button>
            </div>
          </Show>
        }
      >
        {(id) => (
          <Suspense>
            <EntityDiscussion
              threadId={id()}
              testId={`${tid()}.thread`}
              emptyText={props.emptyText ?? i18n.t("kernel.entityDiscussion.empty")}
              placeholder={props.placeholder ?? i18n.t("kernel.entityDiscussion.placeholder")}
              sendLabel={props.sendLabel ?? i18n.t("kernel.entityDiscussion.send")}
            />
          </Suspense>
        )}
      </Show>
    </section>
  )
}

export default EntityDiscussionPanel
