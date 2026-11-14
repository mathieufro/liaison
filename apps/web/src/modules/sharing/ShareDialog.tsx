// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one share dialog, for every shareable resource (the generic sharing
// model: owner + general access + user / role / dimension grants, api
// modules/sharing). A resource plugs in by passing how to load and save its
// sharing and which general-access options it offers; Knowledge documents and
// contacts both use it.

import { Check, Search, X } from "lucide-solid"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Dialog } from "~/ui/Dialog"

export type ShareRole = "viewer" | "editor"
export type OrgAccess = "none" | "viewer" | "editor"

export interface UserShare {
  userId: string
  role: ShareRole
}
export interface RoleShare {
  roleId: string
  role: ShareRole
}
/** A grant to everyone holding a dimension value, e.g. access to a mailbox. */
export interface DimensionShare {
  key: string
  value: string
  role: ShareRole
}

export interface ShareState {
  orgAccess: OrgAccess
  /** A resource-specific refinement of the general access (Knowledge's editScope). */
  variant: string | null
  users: UserShare[]
  roles: RoleShare[]
  dimensions: DimensionShare[]
  /** False when the viewer may see but not change the sharing. Default true. */
  canManage?: boolean
}

export interface GeneralAccessOption {
  key: string
  orgAccess: OrgAccess
  variant?: string | null
  /** i18n keys. */
  label: string
  description: string
}

export interface ShareMember {
  userId: string
  name: string
  email: string
}
export interface ShareRoleTarget {
  roleId: string
  name: string
  memberCount: number
}

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** Prefix of every data-testid, e.g. "knowledge-share". */
  testIdPrefix: string
  /**
   * The dialog's own testid, written out where a guided tour rings the dialog,
   * so the static tour-anchor check sees the literal. Must equal
   * `${testIdPrefix}-dialog`.
   */
  testId?: string
  options: GeneralAccessOption[]
  load: () => Promise<ShareState>
  save: (state: ShareState) => Promise<void>
  listMembers: () => Promise<ShareMember[]>
  listRoles: () => Promise<ShareRoleTarget[]>
  /** How a dimension grant reads ("Everyone with access to the mailbox …"). */
  describeDimension?: (share: DimensionShare) => string
  /** Shown above the general-access options (e.g. who owns the resource). */
  notice?: JSX.Element
}

const ShareDialog: Component<ShareDialogProps> = (props) => {
  const i18n = useI18n()

  const [orgAccess, setOrgAccess] = createSignal<OrgAccess>("none")
  const [variant, setVariant] = createSignal<string | null>(null)
  const [users, setUsers] = createSignal<UserShare[]>([])
  const [roles, setRoles] = createSignal<RoleShare[]>([])
  const [dimensions, setDimensions] = createSignal<DimensionShare[]>([])
  // Nothing is editable until the load says the person may change it: a load
  // that fails leaves a read-only dialog, never an empty form with a Save.
  const [canManage, setCanManage] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [addQuery, setAddQuery] = createSignal("")
  const [addOpen, setAddOpen] = createSignal(false)
  const [addRoleQuery, setAddRoleQuery] = createSignal("")
  const [addRoleOpen, setAddRoleOpen] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const [sharing] = createResource(
    () => (props.open ? true : null),
    async () => {
      setCanManage(false)
      setLoadError(null)
      let result: Awaited<ReturnType<typeof props.load>>
      try {
        result = await props.load()
      } catch (err) {
        setLoadError(
          err instanceof ApiError && (err.status === 404 || err.status === 403)
            ? i18n.t("kernel.sharing.forbidden")
            : err instanceof Error
              ? err.message
              : String(err),
        )
        return null
      }
      setOrgAccess(result.orgAccess)
      setVariant(result.variant ?? null)
      setUsers(result.users)
      setRoles(result.roles ?? [])
      setDimensions(result.dimensions ?? [])
      setCanManage(result.canManage !== false)
      setError(null)
      return result
    },
  )

  const [members] = createResource(
    () => (props.open ? true : null),
    async () => props.listMembers(),
  )

  const [roleTargets] = createResource(
    () => (props.open ? true : null),
    async () => props.listRoles(),
  )

  const memberById = createMemo(() => {
    const map = new Map<string, ShareMember>()
    for (const m of members() ?? []) map.set(m.userId, m)
    return map
  })

  const roleById = createMemo(() => {
    const map = new Map<string, ShareRoleTarget>()
    for (const r of roleTargets() ?? []) map.set(r.roleId, r)
    return map
  })

  const availableMembers = createMemo(() => {
    const sharedIds = new Set(users().map((s) => s.userId))
    const q = addQuery().trim().toLowerCase()
    // The person managing the sharing already has access: never offered to themselves.
    const self = userFromToken()?.userId
    return (members() ?? []).filter((m) => {
      if (sharedIds.has(m.userId) || m.userId === self) return false
      if (!q) return true
      return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
    })
  })

  const availableRoles = createMemo(() => {
    const sharedIds = new Set(roles().map((s) => s.roleId))
    const q = addRoleQuery().trim().toLowerCase()
    return (roleTargets() ?? []).filter((r) => {
      if (sharedIds.has(r.roleId)) return false
      if (!q) return true
      return r.name.toLowerCase().includes(q)
    })
  })

  function addPerson(userId: string) {
    if (!canManage()) return
    setUsers((prev) => [...prev, { userId, role: "viewer" }])
    setAddQuery("")
    setAddOpen(false)
  }

  function updateRole(userId: string, role: ShareRole) {
    if (!canManage()) return
    setUsers((prev) => prev.map((s) => (s.userId === userId ? { ...s, role } : s)))
  }

  function removePerson(userId: string) {
    if (!canManage()) return
    setUsers((prev) => prev.filter((s) => s.userId !== userId))
  }

  function addRole(roleId: string) {
    if (!canManage()) return
    setRoles((prev) => [...prev, { roleId, role: "viewer" }])
    setAddRoleQuery("")
    setAddRoleOpen(false)
  }

  function updateRoleShareRole(roleId: string, role: ShareRole) {
    if (!canManage()) return
    setRoles((prev) => prev.map((s) => (s.roleId === roleId ? { ...s, role } : s)))
  }

  function removeRole(roleId: string) {
    if (!canManage()) return
    setRoles((prev) => prev.filter((s) => s.roleId !== roleId))
  }

  function removeDimension(share: DimensionShare) {
    if (!canManage()) return
    setDimensions((prev) => prev.filter((d) => d.key !== share.key || d.value !== share.value))
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      await props.save({
        orgAccess: orgAccess(),
        variant: variant(),
        users: users(),
        roles: roles(),
        dimensions: dimensions(),
      })
      props.onOpenChange(false)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        setError(i18n.t("kernel.sharing.forbidden"))
      } else {
        setError(err instanceof Error ? err.message : i18n.t("kernel.sharing.saveFailed"))
      }
    } finally {
      setSaving(false)
    }
  }

  function handleCancel() {
    setError(null)
    props.onOpenChange(false)
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content data-testid={props.testId ?? `${props.testIdPrefix}-dialog`} class="max-w-lg">
        <Dialog.Title>{props.title}</Dialog.Title>

        <Show
          when={!sharing.loading && !members.loading && !roleTargets.loading}
          fallback={
            <div
              data-testid={`${props.testIdPrefix}-loading`}
              class="py-8 text-center text-[13px] text-text-tertiary"
            >
              {i18n.t("kernel.common.loading2")}
            </div>
          }
        >
          <div class="mt-4 flex flex-col gap-4">
            <Show when={props.notice}>{props.notice}</Show>
            <Show when={loadError()}>
              <p data-testid={`${props.testIdPrefix}-load-error`} class="text-xs text-danger">
                {loadError()}
              </p>
            </Show>
            <Show when={!canManage() && !loadError()}>
              <p
                data-testid={`${props.testIdPrefix}-read-only`}
                class="text-[12px] text-text-tertiary"
              >
                {i18n.t("kernel.sharing.ownerOnly")}
              </p>
            </Show>
            <fieldset disabled={!canManage()} class="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
              {/* People with access */}
              <section>
                <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                  {i18n.t("kernel.sharing.peopleWithAccess")}
                </span>

                <div class="mt-2 flex flex-col gap-1">
                  <For each={users()}>
                    {(share) => {
                      const member = () => memberById().get(share.userId)
                      return (
                        <div
                          data-testid={`${props.testIdPrefix}-person-${share.userId}`}
                          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover"
                        >
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-[13px] text-text">
                              {member()?.name ?? share.userId}
                            </div>
                            <Show when={member()?.email}>
                              <div class="truncate text-[11px] text-text-tertiary">
                                {member()?.email}
                              </div>
                            </Show>
                          </div>
                          <select
                            data-testid={`${props.testIdPrefix}-person-role-${share.userId}`}
                            value={share.role}
                            onChange={(e) =>
                              updateRole(share.userId, e.currentTarget.value as ShareRole)
                            }
                            disabled={!canManage()}
                            class="rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12px] text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="viewer">{i18n.t("kernel.sharing.viewer")}</option>
                            <option value="editor">{i18n.t("kernel.sharing.editor")}</option>
                          </select>
                          <Show when={canManage()}>
                            <button
                              type="button"
                              aria-label={i18n.t("kernel.sharing.removeShare", {
                                name: member()?.name ?? share.userId,
                              })}
                              onClick={() => removePerson(share.userId)}
                              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
                            >
                              <X size={13} />
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                  <Show when={users().length === 0}>
                    <div class="px-2 py-1 text-[12px] text-text-tertiary">
                      {i18n.t("kernel.sharing.noOneElseHasBeenAdded")}
                    </div>
                  </Show>
                </div>

                {/* Add people (only for whoever may change the sharing) */}
                <Show when={canManage()}>
                  <div class="relative mt-2">
                    <div class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
                      <Search size={13} class="shrink-0 text-text-tertiary" />
                      <input
                        type="text"
                        data-testid={`${props.testIdPrefix}-add-person`}
                        placeholder={i18n.t("kernel.sharing.addPeople")}
                        class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                        value={addQuery()}
                        onInput={(e) => {
                          setAddQuery(e.currentTarget.value)
                          setAddOpen(true)
                        }}
                        // Opened by the person (a click or typing), not by the focus the
                        // dialog gives it on open, so it never covers General access.
                        onClick={() => setAddOpen(true)}
                        onBlur={() => setTimeout(() => setAddOpen(false), 150)}
                      />
                    </div>
                    <Show when={addOpen() && availableMembers().length > 0}>
                      <div class="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border-subtle bg-elevated shadow-popover">
                        <For each={availableMembers()}>
                          {(m) => (
                            <button
                              type="button"
                              data-testid={`${props.testIdPrefix}-add-option-${m.userId}`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => addPerson(m.userId)}
                              class="flex w-full flex-col items-start gap-0 px-3 py-1.5 text-left hover:bg-surface-hover"
                            >
                              <span class="text-[13px] text-text">{m.name}</span>
                              <span class="text-[11px] text-text-tertiary">{m.email}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>

              {/* Roles with access */}
              <section>
                <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                  {i18n.t("kernel.sharing.rolesWithAccess")}
                </span>

                <div class="mt-2 flex flex-col gap-1">
                  <For each={roles()}>
                    {(roleShare) => {
                      const role = () => roleById().get(roleShare.roleId)
                      return (
                        <div
                          data-testid={`${props.testIdPrefix}-role-${roleShare.roleId}`}
                          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover"
                        >
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-[13px] text-text">
                              {role()?.name ?? roleShare.roleId}
                            </div>
                          </div>
                          <select
                            data-testid={`${props.testIdPrefix}-role-role-${roleShare.roleId}`}
                            value={roleShare.role}
                            onChange={(e) =>
                              updateRoleShareRole(
                                roleShare.roleId,
                                e.currentTarget.value as ShareRole,
                              )
                            }
                            disabled={!canManage()}
                            class="rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12px] text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="viewer">{i18n.t("kernel.sharing.viewer")}</option>
                            <option value="editor">{i18n.t("kernel.sharing.editor")}</option>
                          </select>
                          <Show when={canManage()}>
                            <button
                              type="button"
                              aria-label={i18n.t("kernel.sharing.removeShare", {
                                name: role()?.name ?? roleShare.roleId,
                              })}
                              onClick={() => removeRole(roleShare.roleId)}
                              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
                            >
                              <X size={13} />
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                  <Show when={roles().length === 0}>
                    <div class="px-2 py-1 text-[12px] text-text-tertiary">
                      {i18n.t("kernel.sharing.noRolesHaveBeenAddedYet")}
                    </div>
                  </Show>
                </div>

                {/* Add role (only for whoever may change the sharing) */}
                <Show when={canManage()}>
                  <div class="relative mt-2">
                    <div class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
                      <Search size={13} class="shrink-0 text-text-tertiary" />
                      <input
                        type="text"
                        data-testid={`${props.testIdPrefix}-add-role`}
                        placeholder={i18n.t("kernel.sharing.addRoles")}
                        class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
                        value={addRoleQuery()}
                        onInput={(e) => {
                          setAddRoleQuery(e.currentTarget.value)
                          setAddRoleOpen(true)
                        }}
                        onFocus={() => setAddRoleOpen(true)}
                        onBlur={() => setTimeout(() => setAddRoleOpen(false), 150)}
                      />
                    </div>
                    <Show when={addRoleOpen() && availableRoles().length > 0}>
                      <div class="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-border-subtle bg-elevated shadow-popover">
                        <For each={availableRoles()}>
                          {(r) => (
                            <button
                              type="button"
                              data-testid={`${props.testIdPrefix}-add-role-option-${r.roleId}`}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => addRole(r.roleId)}
                              class="flex w-full flex-col items-start gap-0 px-3 py-1.5 text-left hover:bg-surface-hover"
                            >
                              <span class="text-[13px] text-text">{r.name}</span>
                              <span class="text-[11px] text-text-tertiary">
                                {r.memberCount} {i18n.t("kernel.sharing.members")}
                              </span>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </section>

              <Show when={dimensions().length > 0}>
                <section>
                  <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                    {i18n.t("kernel.sharing.alsoSharedWith")}
                  </span>
                  <div class="mt-2 flex flex-col gap-1">
                    <For each={dimensions()}>
                      {(share) => {
                        const label = () =>
                          props.describeDimension?.(share) ?? `${share.key} = ${share.value}`
                        return (
                          <div
                            data-testid={`${props.testIdPrefix}-dimension-${share.key}=${share.value}`}
                            class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover"
                          >
                            <div class="min-w-0 flex-1 truncate text-[13px] text-text">
                              {label()}
                            </div>
                            <span class="text-[12px] text-text-tertiary">
                              {i18n.t(`kernel.sharing.${share.role}`)}
                            </span>
                            <Show when={canManage()}>
                              <button
                                type="button"
                                aria-label={i18n.t("kernel.sharing.removeShare", { name: label() })}
                                onClick={() => removeDimension(share)}
                                class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
                              >
                                <X size={13} />
                              </button>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </section>
              </Show>

              {/* General access */}
              <section>
                <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                  {i18n.t("kernel.sharing.generalAccess")}
                </span>
                <div
                  data-testid={`${props.testIdPrefix}-general-access`}
                  class="mt-2 flex flex-col gap-1"
                >
                  <For each={props.options}>
                    {(opt) => {
                      const selected = () =>
                        orgAccess() === opt.orgAccess && variant() === (opt.variant ?? null)
                      return (
                        <button
                          type="button"
                          data-testid={`${props.testIdPrefix}-access-${opt.key}`}
                          aria-pressed={selected()}
                          disabled={!canManage()}
                          onClick={() => {
                            if (!canManage()) return
                            setOrgAccess(opt.orgAccess)
                            setVariant(opt.variant ?? null)
                          }}
                          class={`flex items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-default ${
                            selected()
                              ? "border-accent bg-surface-hover"
                              : "border-border-subtle hover:bg-surface-hover disabled:opacity-50 disabled:hover:bg-transparent"
                          }`}
                        >
                          <span
                            class={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                              selected()
                                ? "border-accent bg-accent text-accent-foreground"
                                : "border-border-subtle"
                            }`}
                          >
                            <Show when={selected()}>
                              <Check size={10} />
                            </Show>
                          </span>
                          <span class="flex flex-col">
                            <span class="text-[13px] text-text">{i18n.t(opt.label)}</span>
                            <span class="text-[11px] text-text-tertiary">
                              {i18n.t(opt.description)}
                            </span>
                          </span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              </section>
            </fieldset>

            <Show when={error()}>
              <p class="text-xs text-danger">{error()}</p>
            </Show>

            <div class="flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
              <button
                type="button"
                data-testid={`${props.testIdPrefix}-cancel`}
                onClick={handleCancel}
                class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
              >
                {i18n.t("kernel.common.cancel")}
              </button>
              {/* Read only: nothing to save, so no Save that could look like it did something. */}
              <Show when={canManage()}>
                <button
                  type="button"
                  data-testid={`${props.testIdPrefix}-save`}
                  disabled={saving()}
                  onClick={() => void handleSave()}
                  class="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving() ? i18n.t("kernel.common.saving") : i18n.t("kernel.common.save")}
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </Dialog.Content>
    </Dialog>
  )
}

export default ShareDialog
