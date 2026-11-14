// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Consumer (free) mail domains: an address there says nothing about the company
 * its owner works for. The one list every domain judgement reads: the customer
 * resolver never falls back from such an address to a domain lookup (every
 * gmail.com sender would otherwise match whichever CRM record carries
 * gmail.com), no company takes such a domain, company proposals never group by
 * one, an inbound sender is never linked to a company by one, and the
 * commercial send check never reads a business from one. Families with a
 * domain per market (yahoo.*, hotmail.*, outlook.*, live.*, aol.*, gmx.*,
 * yandex.*) match by their first label.
 */

const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Global providers
  "gmail.com",
  "googlemail.com",
  "msn.com",
  "windowslive.com",
  "passport.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "protonmail.ch",
  "pm.me",
  "tutanota.com",
  "tutanota.de",
  "tuta.io",
  "tuta.com",
  "ymail.com",
  "rocketmail.com",
  "aim.com",
  "mail.com",
  "email.com",
  "zoho.com",
  "zohomail.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "mailbox.org",
  "posteo.de",
  "posteo.net",
  "gmx.com",
  "gmx.net",
  // France
  "orange.fr",
  "wanadoo.fr",
  "free.fr",
  "sfr.fr",
  "neuf.fr",
  "cegetel.net",
  "club-internet.fr",
  "aliceadsl.fr",
  "bbox.fr",
  "numericable.fr",
  "noos.fr",
  "laposte.net",
  "voila.fr",
  // Germany, Austria, Switzerland
  "web.de",
  "t-online.de",
  "freenet.de",
  "arcor.de",
  "online.de",
  "bluewin.ch",
  "hispeed.ch",
  "sunrise.ch",
  "chello.at",
  "aon.at",
  // Benelux
  "skynet.be",
  "telenet.be",
  "scarlet.be",
  "proximus.be",
  "ziggo.nl",
  "kpnmail.nl",
  "planet.nl",
  "home.nl",
  "hetnet.nl",
  "casema.nl",
  // Italy, Spain, Portugal
  "libero.it",
  "virgilio.it",
  "tiscali.it",
  "alice.it",
  "tin.it",
  "email.it",
  "fastwebnet.it",
  "telefonica.net",
  "terra.es",
  "sapo.pt",
  // United Kingdom, Ireland
  "btinternet.com",
  "btopenworld.com",
  "sky.com",
  "virginmedia.com",
  "ntlworld.com",
  "talktalk.net",
  "blueyonder.co.uk",
  "eircom.net",
  // North America
  "comcast.net",
  "verizon.net",
  "att.net",
  "sbcglobal.net",
  "bellsouth.net",
  "cox.net",
  "charter.net",
  "earthlink.net",
  "optonline.net",
  "juno.com",
  "shaw.ca",
  "rogers.com",
  "sympatico.ca",
  "videotron.ca",
  // Nordics, Central and Eastern Europe
  "telia.com",
  "seznam.cz",
  "centrum.cz",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
  "mail.ru",
  "inbox.ru",
  "list.ru",
  "bk.ru",
  "rambler.ru",
  "ukr.net",
  // Elsewhere
  "bigpond.com",
  "optusnet.com.au",
  "xtra.co.nz",
  "uol.com.br",
  "bol.com.br",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
  "naver.com",
  "daum.net",
  "hanmail.net",
  "rediffmail.com",
])

/**
 * `yahoo.fr`, `hotmail.co.uk`, `outlook.de`, `live.fr`, `gmx.de`, `yandex.ru`,
 * `aol.com`: the family label, then a country or generic suffix.
 */
const CONSUMER_MAIL_FAMILIES = [
  "yahoo",
  "hotmail",
  "outlook",
  "live",
  "aol",
  "gmx",
  "yandex",
] as const

export function isConsumerMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase()
  if (CONSUMER_MAIL_DOMAINS.has(d)) return true
  const [first, ...rest] = d.split(".")
  if (!first || rest.length === 0 || rest.length > 2) return false
  return (
    (CONSUMER_MAIL_FAMILIES as readonly string[]).includes(first) &&
    rest.every((label) => /^[a-z]{2,3}$/.test(label))
  )
}
