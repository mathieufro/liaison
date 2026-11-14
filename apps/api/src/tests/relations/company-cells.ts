// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cells of a customer's links (company-world.ts): a company renamed, merged or deleted, a
// person merged or deleted, the account manager leaving, a deal moved where it cannot live, and the
// data subject exports that must carry each link.

import { expect } from "bun:test"
import type { CellImpl, Worlds } from "./cells"
import { CrmCase, type CrmLink } from "./company-world"

const SEE = ["admin", "seller"]

function crm(link: CrmLink) {
  return async (worlds: Worlds) => new CrmCase(worlds.approvals, link).build()
}

function cell(c: CellImpl<CrmCase>): CellImpl {
  return c
}

/** Every string under `key` anywhere in a bundle. */
function valuesAt(bundle: unknown, key: string): string[] {
  const out: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) walk(x)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === key && typeof x === "string") out.push(x)
        else walk(x)
      }
    }
  }
  walk(bundle)
  return out
}

const companyMerge = (link: string, name: CrmLink): CellImpl =>
  cell({
    link,
    event: "Mg",
    says: "its company merged into another",
    build: crm(name),
    mustSee: SEE,
    act: (w) => w.mergeCompany(),
    took: async (w) => expect(await w.companyRow()).toBeNull(),
    facts: () => ({ survivor: "otherCompany", goneId: "company" }),
  })

const companyDelete = (link: string, name: CrmLink): CellImpl =>
  cell({
    link,
    event: "Dl",
    says: "its company deleted",
    build: crm(name),
    mustSee: SEE,
    act: (w) => w.deleteCompany(),
    took: async (w) => expect(await w.companyRow()).toBeNull(),
    facts: () => ({ goneId: "company" }),
  })

const contactMerge = (link: string, name: CrmLink): CellImpl =>
  cell({
    link,
    event: "Mg",
    says: "its person merged into another",
    build: crm(name),
    mustSee: SEE,
    act: (w) => w.mergeContact(),
    took: async (w) => expect(await w.contactExists()).toBe(false),
    facts: () => ({ survivor: "otherContact", goneId: "contact" }),
  })

const contactDelete = (link: string, name: CrmLink): CellImpl =>
  cell({
    link,
    event: "Dl",
    says: "its person deleted",
    build: crm(name),
    mustSee: SEE,
    act: (w) => w.deleteContact(),
    took: async (w) => expect(await w.contactExists()).toBe(false),
    facts: () => ({ goneId: "contact" }),
  })

export function companyCells(): CellImpl[] {
  return [
    // ── contact-company ───────────────────────────────────────────────────────
    cell({
      link: "contact-company",
      event: "Rn",
      says: "its company renamed",
      build: crm("contactCompany"),
      mustSee: SEE,
      act: (w) => w.renameCompany(),
      took: async (w) => expect((await w.companyRow())?.name).toBe(`${w.companyName} renamed`),
      facts: (w) => ({ newName: `${w.companyName} renamed`, oldName: w.companyName }),
    }),
    companyMerge("contact-company", "contactCompany"),
    cell({
      link: "contact-company",
      event: "Ex",
      says: "the person's data subject export",
      build: crm("contactCompany"),
      mustSee: SEE,
      act: async (w) => {
        w.exported = valuesAt(await w.exportOf("contact"), "companyId")
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.companyId }),
    }),

    // ── company-account-manager ───────────────────────────────────────────────
    cell({
      link: "company-account-manager",
      event: "Dx",
      says: "the account manager deactivated, their companies left unowned",
      build: crm("companyManager"),
      mustSee: SEE,
      whoIsTold: ["admin"],
      act: (w) => w.sellerLeaves(),
      took: async (w) => expect(await w.sellerStatus()).toBe("deactivated"),
      facts: () => ({ goneId: "seller" }),
    }),
    cell({
      link: "company-account-manager",
      event: "Ex",
      says: "the account manager exporting their own data",
      build: crm("companyManager"),
      mustSee: SEE,
      act: async (w) => {
        const bundle = (await w.exportOf("seller")) as {
          records?: Record<string, { rows?: Array<Record<string, unknown>> }>
        }
        w.exported = (bundle.records?.companiesManaged?.rows ?? []).map((r) => String(r.id))
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.companyId }),
    }),

    // ── company-main-contact ──────────────────────────────────────────────────
    contactMerge("company-main-contact", "mainContact"),
    contactDelete("company-main-contact", "mainContact"),

    // ── deal-company ──────────────────────────────────────────────────────────
    companyMerge("deal-company", "dealCompany"),
    companyDelete("deal-company", "dealCompany"),

    // ── deal-contact ──────────────────────────────────────────────────────────
    contactMerge("deal-contact", "dealContact"),
    contactDelete("deal-contact", "dealContact"),
    cell({
      link: "deal-contact",
      event: "Ex",
      says: "the person's data subject export",
      build: crm("dealContact"),
      mustSee: SEE,
      act: async (w) => {
        w.exported = valuesAt(await w.exportOf("contact"), "taskId")
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.dealId }),
    }),

    // ── deal-owner ────────────────────────────────────────────────────────────
    cell({
      link: "deal-owner",
      event: "Ex",
      says: "the owner exporting their own data",
      build: crm("dealOwner"),
      mustSee: SEE,
      act: async (w) => {
        const bundle = (await w.exportOf("seller")) as {
          records?: Record<string, { rows?: Array<Record<string, unknown>> }>
        }
        w.exported = (bundle.records?.deals?.rows ?? []).map((r) => String(r.task_id))
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: (w) => ({ exported: w.exported, linkRowId: w.dealId }),
    }),

    // ── deal-pipeline-project ─────────────────────────────────────────────────
    cell({
      link: "deal-pipeline-project",
      event: "Mv",
      says: "the deal moved to a work project",
      build: crm("dealPipeline"),
      mustSee: SEE,
      act: (w) => w.moveDealToWork(),
      took: async (w) => {
        expect(w.refusal).not.toBeNull()
        expect(await w.dealProject()).toBe(w.pipelineId)
      },
      facts: (w) => ({ refusal: w.refusal }),
    }),

    // ── project-company ───────────────────────────────────────────────────────
    companyMerge("project-company", "projectCompany"),
    companyDelete("project-company", "projectCompany"),

    // ── suppression-contact ───────────────────────────────────────────────────
    cell({
      link: "suppression-contact",
      event: "Dl",
      says: "the person deleted after opting out",
      build: crm("suppressionContact"),
      mustSee: ["admin", "seller"],
      act: (w) => w.deleteContact(),
      took: async (w) => expect(await w.contactExists()).toBe(false),
      facts: () => ({}),
    }),
    cell({
      link: "suppression-contact",
      event: "Ex",
      says: "the person's data subject export",
      build: crm("suppressionContact"),
      mustSee: ["admin", "seller"],
      mark: (w) => w.suppressionAt(),
      act: async (w) => {
        const bundle = await w.exportOf("contact")
        w.exported = valuesAt(bundle, "at").map((a) => new Date(a).toISOString())
      },
      took: async (w) => expect(w.exportFileId).not.toBeNull(),
      facts: async (w) => ({ exported: w.exported, linkRowId: (await w.suppressionAt()) ?? "" }),
    }),
  ]
}
