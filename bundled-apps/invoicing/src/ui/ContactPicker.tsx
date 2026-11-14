// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ContactPicker: links an editor document to a kernel contact by NAME. The
// operator searches the organisation's contacts (the kernel's own contacts
// list, read as the signed-in user, so sharing and RLS apply) and picks one;
// the linked contact then shows as its name, never as its raw id. A linked
// contact can be opened or unlinked.
//
// Pure helpers (`contactLabel`, `pickedContactPatch`) are exported for the
// bun:test suite; the component is thin glue around them.

import { fetch as hostFetch, navigate } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { tr } from "./i18n"
import { cx, inputClass } from "./kit"

/** The slice of a kernel contact (`GET /api/contacts`) the picker reads. */
export interface PickerContact {
  id: string
  name: string | null
  email: string | null
  company: string | null
}

/** What a person reads for a contact: its name, else its company, else its email. */
export function contactLabel(c: Pick<PickerContact, "name" | "email" | "company">): string {
  const name = c.name?.trim()
  if (name) return name
  const company = c.company?.trim()
  if (company) return company
  return c.email?.trim() || tr("Unnamed contact")
}

/**
 * The draft patch for a picked contact: the link itself, plus the customer name
 * and email when the operator has not typed them yet (never overwrites a value
 * already in the form).
 */
export function pickedContactPatch(
  c: PickerContact,
  current: { counterparty_name?: string | null; counterparty_email?: string | null },
): {
  counterparty_contact_id: string
  counterparty_name?: string
  counterparty_email?: string
} {
  const patch: {
    counterparty_contact_id: string
    counterparty_name?: string
    counterparty_email?: string
  } = { counterparty_contact_id: c.id }
  if (!current.counterparty_name?.trim()) {
    const name = c.company?.trim() || c.name?.trim()
    if (name) patch.counterparty_name = name
  }
  if (!current.counterparty_email?.trim() && c.email?.trim()) {
    patch.counterparty_email = c.email.trim()
  }
  return patch
}

const SEARCH_LIMIT = 8

async function searchContacts(query: string): Promise<PickerContact[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const params = new URLSearchParams({ query: q, limit: String(SEARCH_LIMIT), mode: "people" })
  const rows = await hostFetch<PickerContact[]>(`/api/contacts?${params.toString()}`)
  return Array.isArray(rows) ? rows : []
}

export async function loadContact(id: string): Promise<PickerContact | null> {
  try {
    return await hostFetch<PickerContact>(`/api/contacts/${encodeURIComponent(id)}`)
  } catch {
    // Deleted, merged away or not shared with this user.
    return null
  }
}

export const ContactPicker: Component<{
  contactId: string | null
  disabled?: boolean
  /** The customer must be chosen: the search box does not say "Optional". */
  required?: boolean
  onPick: (c: PickerContact) => void
  onClear: () => void
}> = (props) => {
  const [query, setQuery] = createSignal("")
  const [open, setOpen] = createSignal(false)
  const [linked] = createResource(() => props.contactId || undefined, loadContact)
  const [results] = createResource(
    () => (open() ? query() : undefined),
    (q) => searchContacts(q).catch(() => [] as PickerContact[]),
  )

  const pick = (c: PickerContact) => {
    props.onPick(c)
    setQuery("")
    setOpen(false)
  }

  return (
    <Show
      when={props.contactId}
      fallback={
        <div class="relative">
          <input
            data-testid="editor-field-contact-search"
            disabled={props.disabled}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            // Let a click on a result land before the list closes.
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false)
              if (e.key === "Enter") {
                const first = results()?.[0]
                if (first) {
                  e.preventDefault()
                  pick(first)
                }
              }
            }}
            placeholder={props.required ? tr("Search a contact") : tr("Optional: search a contact")}
            class={inputClass}
          />
          <Show when={open() && query().trim().length >= 2 && !results.loading}>
            <ul
              data-testid="editor-contact-results"
              class="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border-subtle bg-elevated py-1 shadow-lg"
            >
              <For
                each={results() ?? []}
                fallback={
                  <li class="px-3 py-2 text-[12px] text-text-tertiary">
                    {tr("No matching contact.")}
                  </li>
                }
              >
                {(c) => (
                  <li>
                    <button
                      type="button"
                      data-testid="editor-contact-result"
                      class="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-hover"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(c)}
                    >
                      <span class="text-[12.5px] text-text">{contactLabel(c)}</span>
                      <Show when={c.email && c.email !== contactLabel(c) ? c.email : null}>
                        {(email) => <span class="text-[11px] text-text-tertiary">{email()}</span>}
                      </Show>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      }
    >
      {(id) => (
        <div
          data-testid="editor-field-contact-linked"
          class={cx(inputClass, "flex items-center gap-2")}
        >
          <a
            class="min-w-0 flex-1 cursor-pointer truncate text-accent hover:underline"
            href={`/contacts/${encodeURIComponent(id())}`}
            onClick={(e) => {
              e.preventDefault()
              navigate(`/contacts/${encodeURIComponent(id())}`)
            }}
          >
            {linked.loading
              ? tr("Loading…")
              : linked()
                ? contactLabel(linked()!)
                : tr("Contact not available")}
          </a>
          <Show when={!props.disabled}>
            <button
              type="button"
              data-testid="editor-field-contact-clear"
              class="shrink-0 text-[11.5px] text-text-tertiary hover:text-text"
              onClick={(e) => {
                e.preventDefault()
                props.onClear()
              }}
            >
              {tr("Unlink")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
