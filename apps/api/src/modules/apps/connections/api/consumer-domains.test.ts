// SPDX-License-Identifier: FSL-1.1-ALv2
// The consumer-mail list the customer resolver never falls back to: a free
// mail domain says nothing about which company a sender works for.
import { describe, expect, it } from "bun:test"
import { isConsumerMailDomain } from "./consumer-domains"

describe("isConsumerMailDomain (P2-SK2)", () => {
  it("covers the committed list", () => {
    for (const d of [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "msn.com",
      "yahoo.com",
      "yahoo.fr",
      "yahoo.co.uk",
      "icloud.com",
      "me.com",
      "proton.me",
      "protonmail.com",
      "gmx.de",
      "gmx.net",
      "web.de",
      "orange.fr",
      "free.fr",
      "laposte.net",
      "wanadoo.fr",
      "sfr.fr",
      "aol.com",
      "yandex.ru",
      "yandex.com",
      "mail.ru",
      "qq.com",
      "163.com",
    ]) {
      expect({ d, consumer: isConsumerMailDomain(d) }).toEqual({ d, consumer: true })
    }
  })

  it("covers the common national providers", () => {
    for (const d of [
      "hotmail.fr",
      "hotmail.co.uk",
      "hotmail.de",
      "outlook.fr",
      "outlook.de",
      "live.fr",
      "live.co.uk",
      "msn.com",
      "orange.fr",
      "free.fr",
      "sfr.fr",
      "neuf.fr",
      "bbox.fr",
      "laposte.net",
      "wanadoo.fr",
      "t-online.de",
      "gmx.de",
      "gmx.at",
      "web.de",
      "bluewin.ch",
      "skynet.be",
      "libero.it",
      "btinternet.com",
      "comcast.net",
      "yahoo.de",
      "yahoo.com.br",
      "ymail.com",
      "icloud.com",
      "me.com",
      "mac.com",
      "proton.me",
      "pm.me",
      "aol.fr",
    ]) {
      expect({ d, consumer: isConsumerMailDomain(d) }).toEqual({ d, consumer: true })
    }
  })

  it("is case-insensitive and never matches a company domain", () => {
    expect(isConsumerMailDomain("GMail.COM")).toBe(true)
    for (const d of [
      "acme.test",
      "gmail.com.acme.test",
      "notgmail.com",
      "yahoofinance.example",
      "orange.com",
      "outlookfinance.test",
      "live-music.fr",
      "hotmail.acme.example",
    ]) {
      expect({ d, consumer: isConsumerMailDomain(d) }).toEqual({ d, consumer: false })
    }
  })
})
