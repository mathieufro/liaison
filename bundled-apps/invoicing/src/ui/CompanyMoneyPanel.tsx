// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CompanyMoneyPanel — the Money section of the kernel's company page
// (`slots.company_detail`, group `money`). Lists the documents made out to the
// company's people, read with `documents_search({ company_id })` as the
// viewer: the kernel lists the panel only for a viewer holding
// `invoicing:documents:read`, and the read returns only what they may see.

import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { app, navigate } from "@liaison/host"
import { type Component, createResource, Show } from "solid-js"
import { type DocumentRow, displayTotal } from "./ContactDocumentsPanel"
import { tr } from "./i18n"

export interface CompanyMoneyPanelProps {
  /** The company id: the slot host mounts every panel with it as `entityId`. */
  entityId?: string
}

export const COMPANY_MONEY_LIMIT = 20

/** The company's documents, newest first; none when the read fails. */
export async function loadCompanyMoney(companyId: string): Promise<DocumentRow[]> {
  const rows = await app
    .invokeTool<DocumentRow[]>("documents_search", {
      company_id: companyId,
      limit: COMPANY_MONEY_LIMIT,
    })
    .catch(() => [] as DocumentRow[])
  return Array.isArray(rows) ? rows : []
}

function fmtDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "-"
}

export const CompanyMoneyPanel: Component<CompanyMoneyPanelProps> = (props) => {
  const [docs] = createResource(() => props.entityId || undefined, loadCompanyMoney)
  return (
    <section data-testid="company-money-panel" class="flex flex-col gap-2 text-[12.5px]">
      <Show
        when={(docs()?.length ?? 0) > 0}
        fallback={
          <div data-testid="company-money-panel-empty" class="text-text-tertiary">
            {tr("No invoices or quotes for this company yet.")}
          </div>
        }
      >
        <CardTable
          rows={docs() ?? []}
          rowKey={(row) => row.id}
          rowTestid={(row) => `company-money-panel-row-${row.id}`}
          onRowClick={(row) => navigate(`/invoicing/document/${row.id}`)}
          columns={
            [
              {
                key: "number",
                header: "#",
                role: "anchor",
                cell: (row) => <span class="font-mono">{row.number ?? tr("Draft")}</span>,
              },
              { key: "type", header: tr("Type"), role: "secondary", cell: (row) => row.type },
              {
                key: "date",
                header: tr("Date"),
                role: "meta",
                cell: (row) => fmtDate(row.issued_at),
              },
              { key: "status", header: tr("Status"), role: "meta", cell: (row) => row.status },
              {
                key: "total",
                header: tr("Total"),
                role: "meta",
                numeric: true,
                align: "right",
                cell: (row) => displayTotal(row),
              },
            ] as Array<CardTableColumn<DocumentRow>>
          }
        />
      </Show>
    </section>
  )
}
