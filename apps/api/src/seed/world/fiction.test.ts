// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo instance is public and this tree ships as source, so every
// literal here is fictional by construction: reserved domains, zero VAT and
// IBAN bodies, the RAL- SKU prefix. The scan for real company, dealer and
// person names runs from the private operator tooling, because a list of those
// names would itself be a disclosure if it shipped here.
import { describe, expect, it } from "bun:test"
import {
  DEMO_CATALOG,
  DEMO_COMPANY,
  DEMO_CUSTOMERS,
  DEMO_DEALERS,
  DEMO_EMAIL_DOMAIN,
  DEMO_ROLE_AGENTS,
  DEMO_TEAM,
  DEMO_WORLD,
} from "~/seed/world/fiction"

/** Reserved TLDs that can never route to a live mailbox (RFC 2606 / 6761). */
const RESERVED_DOMAIN = /@[a-z0-9.-]+\.(example|test|invalid|localhost)$/

const SERIALIZED = JSON.stringify(DEMO_WORLD) + JSON.stringify(DEMO_ROLE_AGENTS)

/** The mod 97 residue of an IBAN. Exactly 1 for a valid one, anything else is not. */
function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  const digits = rearranged
    .split("")
    .map((ch) => (/[0-9]/.test(ch) ? ch : String(ch.toUpperCase().charCodeAt(0) - 55)))
    .join("")
  let remainder = 0
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97
  return remainder
}

/**
 * Evaluate `world.ts` in a CHILD process and serialize it there. Module
 * evaluation is what has to be deterministic; a re-import inside this process
 * only re-reads a cached object.
 */
function serializeWorldInFreshProcess(): string {
  const worldPath = new URL("./fiction.ts", import.meta.url).pathname
  const script = [
    `const w = await import(${JSON.stringify(worldPath)})`,
    `process.stdout.write(JSON.stringify(w.DEMO_WORLD) + JSON.stringify(w.DEMO_ROLE_AGENTS))`,
  ].join("\n")
  const proc = Bun.spawnSync({ cmd: [process.execPath, "--eval", script] })
  if (proc.exitCode !== 0) {
    throw new Error(`world.ts failed to evaluate in a child process: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

describe("demo world: anonymized fictional source of truth", () => {
  it("declares the company identity and the detail a visitor sees", () => {
    expect(DEMO_COMPANY.name).toBe("Resonant Audio Labs")
    expect(DEMO_COMPANY.legalName).toBe("Resonant Audio Labs SAS")
    expect(DEMO_COMPANY.country).toBe("FR")
    expect(DEMO_COMPANY.iban).toMatch(/^FR[0-9]{2}[0-9A-Z]{10,30}$/)
    expect(DEMO_COMPANY.supportEmail).toMatch(RESERVED_DOMAIN)
    expect(DEMO_COMPANY.billingEmail).toMatch(RESERVED_DOMAIN)
    expect(DEMO_COMPANY.about.length).toBeGreaterThan(40)
  })

  it("the company VAT body is all zeros, so it can never read as a live registration", () => {
    // The same assertion the dealers get, on the company itself: two letters
    // then nothing but zeros. A body with any non-zero digit is a number that
    // reads as a registration, whatever its checksum happens to do.
    expect(DEMO_COMPANY.vat).toMatch(/^[A-Z]{2}0+$/)
    expect(DEMO_COMPANY.vat).toBe("FR00000000000")
  })

  it("the IBAN is unmistakably synthetic: all-zero body, and mod 97 refuses it", () => {
    expect(DEMO_COMPANY.iban).toMatch(/^FR0+$/)
    expect(DEMO_COMPANY.iban.length).toBe(27)
    // Check digits are the two characters after the country code, and "00" is
    // outside the 02..98 an IBAN check can ever produce.
    expect(DEMO_COMPANY.iban.slice(2, 4)).toBe("00")
    expect(ibanMod97(DEMO_COMPANY.iban)).not.toBe(1)
  })

  it("CATALOG is showroom sized, RAL prefixed, unique and priced", () => {
    expect(DEMO_CATALOG.length).toBeGreaterThanOrEqual(8)
    expect(DEMO_CATALOG.length).toBeLessThanOrEqual(12)
    expect(DEMO_CATALOG.some((s) => s.tier === "flagship")).toBe(true)
    expect(DEMO_CATALOG.some((s) => s.tier === "accessory")).toBe(true)
    for (const sku of DEMO_CATALOG) {
      expect(sku.sku).toMatch(/^RAL-/)
      expect(sku.variantId).toMatch(/^RAL-/)
      expect(sku.priceMinor).toBeGreaterThan(0)
      expect(sku.weightKg).toBeGreaterThan(0)
      expect(sku.description.length).toBeGreaterThan(10)
    }
    const skus = DEMO_CATALOG.map((s) => s.sku)
    expect(new Set(skus).size).toBe(skus.length)
    const variants = DEMO_CATALOG.map((s) => s.variantId)
    expect(new Set(variants).size).toBe(variants.length)
  })

  it("TEAM is 6 to 8 people, one founder, unique keys and unique emails on the company domain", () => {
    expect(DEMO_TEAM.length).toBeGreaterThanOrEqual(6)
    expect(DEMO_TEAM.length).toBeLessThanOrEqual(8)
    expect(DEMO_TEAM.filter((p) => p.role === "founder_admin").length).toBe(1)
    for (const person of DEMO_TEAM) {
      expect(person.email).toBe(`${person.key}@${DEMO_EMAIL_DOMAIN}`)
      expect(person.email).toMatch(RESERVED_DOMAIN)
      expect(person.jobTitle.length).toBeGreaterThan(3)
      expect(person.bio.length).toBeGreaterThan(20)
    }
    const emails = DEMO_TEAM.map((p) => p.email)
    expect(new Set(emails).size).toBe(emails.length)
    const keys = DEMO_TEAM.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("DEALERS cover six territories, every declared VAT body all zeros", () => {
    expect(DEMO_DEALERS.length).toBeGreaterThanOrEqual(6)
    const countries = new Set(DEMO_DEALERS.map((d) => d.country))
    for (const expected of ["DE", "US", "GB", "JP", "NL", "FR"]) {
      expect(countries.has(expected)).toBe(true)
    }
    for (const dealer of DEMO_DEALERS) {
      if (dealer.vat) expect(dealer.vat).toMatch(/^[A-Z]{2}0+$/)
    }
    const keys = DEMO_DEALERS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("CUSTOMERS are about twenty, all on reserved domains, a few VIP", () => {
    expect(DEMO_CUSTOMERS.length).toBeGreaterThanOrEqual(18)
    for (const customer of DEMO_CUSTOMERS) {
      expect(customer.email).toMatch(RESERVED_DOMAIN)
      expect(customer.country).toMatch(/^[A-Z]{2}$/)
    }
    const vips = DEMO_CUSTOMERS.filter((c) => c.isVip)
    expect(vips.length).toBeGreaterThanOrEqual(2)
    expect(vips.length).toBeLessThan(DEMO_CUSTOMERS.length)
    const emails = DEMO_CUSTOMERS.map((c) => c.email)
    expect(new Set(emails).size).toBe(emails.length)
  })

  it("ROLE AGENTS each carry a handle, a purpose and a company grounded prompt", () => {
    expect(DEMO_ROLE_AGENTS.length).toBeGreaterThanOrEqual(3)
    for (const agent of DEMO_ROLE_AGENTS) {
      expect(agent.handle).toMatch(/^@[a-z0-9_-]+$/)
      expect(agent.purpose.length).toBeGreaterThan(10)
      expect(agent.systemPrompt).toContain("Resonant Audio Labs")
    }
    const handles = DEMO_ROLE_AGENTS.map((a) => a.handle)
    expect(new Set(handles).size).toBe(handles.length)
  })

  it("is deterministic: two FRESH processes serialize the world identically", () => {
    // A second `await import("~/seed/world/fiction")` in this process returns the cached
    // module object and can never disagree with the first, so the module is
    // evaluated again in two child processes instead: that is what actually
    // catches a `Math.random()` or a `Date.now()` at module scope, which is
    // what would make a re-seed produce different rows.
    const first = serializeWorldInFreshProcess()
    const second = serializeWorldInFreshProcess()
    expect(first).toBe(second)
    expect(first).toBe(SERIALIZED)
  }, 60_000)
})

/**
 * Every other world's pack under the same rules, read from its own fiction
 * module: the company's VAT and IBAN bodies are all zero, every address and
 * site is on a reserved domain, every declared VAT body is zero, and the
 * module evaluates to the same pack in two fresh processes.
 */
const PACK_FICTIONS = [
  { world: "saas", file: "../worlds/saas/fiction.ts", exports: ["SAAS_WORLD", "SAAS_ROLE_AGENTS"] },
  {
    world: "studio",
    file: "../worlds/studio/fiction.ts",
    exports: ["STUDIO_WORLD", "STUDIO_CLIENTS"],
  },
] as const

const RESERVED_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+\.(example|test|invalid|localhost)$/

function serializePackInFreshProcess(file: string, names: readonly string[]): string {
  const modulePath = new URL(file, import.meta.url).pathname
  const script = [
    `const m = await import(${JSON.stringify(modulePath)})`,
    `process.stdout.write(${names.map((n) => `JSON.stringify(m.${n})`).join(" + ")})`,
  ].join("\n")
  const proc = Bun.spawnSync({ cmd: [process.execPath, "--eval", script] })
  if (proc.exitCode !== 0) {
    throw new Error(`${file} failed to evaluate in a child process: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

for (const pack of PACK_FICTIONS) {
  describe(`the ${pack.world} world's fiction, under the same rules`, () => {
    let text = ""
    let world: {
      company: Record<string, string>
      customers: Array<{ email: string; vat?: string }>
    }

    it("is deterministic: two fresh processes serialize it identically", () => {
      text = serializePackInFreshProcess(pack.file, pack.exports)
      expect(serializePackInFreshProcess(pack.file, pack.exports)).toBe(text)
      world = JSON.parse(text.slice(0, text.indexOf("}[") + 1)) as typeof world
    }, 60_000)

    it("the company's VAT and IBAN bodies are all zero, and mod 97 refuses the IBAN", () => {
      expect(world.company.vat).toMatch(/^[A-Z]{2}0+$/)
      expect(world.company.iban).toMatch(/^[A-Z]{2}0+$/)
      expect(ibanMod97(world.company.iban as string)).not.toBe(1)
    })

    it("every address and site it names is on a reserved domain", () => {
      const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? []
      expect(emails.length).toBeGreaterThan(0)
      for (const email of emails) expect(`@${email.split("@")[1]}`).toMatch(RESERVED_DOMAIN)
      for (const url of text.match(/https?:\/\/[^\s"/]+/g) ?? []) {
        expect(new URL(url).hostname).toMatch(RESERVED_HOST)
      }
    })

    it("every declared VAT body is all zero", () => {
      for (const vat of text.match(/"vat(?:Number)?":"([^"]*)"/g) ?? []) {
        expect(vat.split(":")[1]).toMatch(/^"[A-Z]{2}0+"$/)
      }
    })
  })
}
