// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The opt-out page a commercial mail's link opens: one question, one button,
 * the result. Server-rendered, no script, no cookie, no login, no field, nothing
 * loaded from elsewhere. It never names the recipient (the link row holds only
 * the address's fingerprint), and its footer is the sender's legal name and
 * postal address. English, or French for a French browser.
 */
import { escapeHtml } from "~/lib/html-page"

export type OptOutState = "confirm" | "done" | "already" | "invalid" | "too_many" | "unavailable"

export const OPT_OUT_STATUS: Record<OptOutState, number> = {
  confirm: 200,
  done: 200,
  already: 200,
  invalid: 404,
  too_many: 429,
  unavailable: 503,
}

type Lang = "en" | "fr"

interface Texts {
  heading: (name: string) => string
  body: string
  button?: string
  retry?: string
}

const TEXTS: Record<OptOutState, Record<Lang, Texts>> = {
  confirm: {
    en: {
      heading: (n) => `Stop commercial messages from ${n}?`,
      body: "This stops follow-ups and offers to this address. Invoices and messages about your account still reach you.",
      button: "Stop these messages",
    },
    fr: {
      heading: (n) => `Ne plus recevoir de messages commerciaux de ${n} ?`,
      body: "Vous ne recevrez plus de relances ni d'offres à cette adresse. Les factures et messages liés à votre compte continuent d'arriver.",
      button: "Ne plus recevoir",
    },
  },
  done: {
    en: {
      heading: (n) => `Done. You will not get commercial messages from ${n}.`,
      body: "To hear from them again, write to them.",
    },
    fr: {
      heading: (n) => `C'est fait. Vous ne recevrez plus de messages commerciaux de ${n}.`,
      body: "Pour les recevoir à nouveau, écrivez-leur.",
    },
  },
  already: {
    en: {
      heading: (n) => `You already opted out of commercial messages from ${n}.`,
      body: "To hear from them again, write to them.",
    },
    fr: {
      heading: (n) => `Vous êtes déjà désinscrit des messages commerciaux de ${n}.`,
      body: "Pour les recevoir à nouveau, écrivez-leur.",
    },
  },
  invalid: {
    en: {
      heading: () => "This link is not valid.",
      body: "To stop these messages, reply to the message with the word stop.",
    },
    fr: {
      heading: () => "Ce lien n'est pas valide.",
      body: "Pour ne plus les recevoir, répondez au message avec le mot stop.",
    },
  },
  too_many: {
    en: {
      heading: () => "Too many attempts.",
      body: "Try again in a few minutes, or reply to the message with the word stop.",
    },
    fr: {
      heading: () => "Trop de tentatives.",
      body: "Réessayez dans quelques minutes, ou répondez au message avec le mot stop.",
    },
  },
  unavailable: {
    en: {
      heading: () => "This page is not available right now.",
      body: "Your request was not recorded. Try again in a moment, or reply to the message with the word stop.",
      retry: "Try again",
    },
    fr: {
      heading: () => "Cette page n'est pas disponible pour le moment.",
      body: "Votre demande n'a pas été enregistrée. Réessayez dans un instant, ou répondez au message avec le mot stop.",
      retry: "Réessayer",
    },
  },
}

/** The page's one stylesheet, pinned by hash in its Content-Security-Policy. */
export const OPT_OUT_STYLE =
  ":root{color-scheme:light dark}body{margin:0;font-family:system-ui,-apple-system,sans-serif;" +
  "line-height:1.5;background:#fff;color:#1a1a1a}main{max-width:32rem;margin:0 auto;" +
  "padding:48px 16px}h1{font-size:1.35rem;margin:0 0 12px}p{margin:0 0 16px}" +
  "button,a.retry{font:inherit;padding:12px 20px;min-height:44px;border-radius:6px;" +
  "border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer;display:inline-block;" +
  "text-decoration:none}footer{margin-top:40px;font-size:.85rem;color:#666;overflow-wrap:anywhere}" +
  "@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}" +
  "button,a.retry{background:#eee;color:#141414;border-color:#eee}footer{color:#aaa}}"

export interface OptOutPageInput {
  state: OptOutState
  lang: Lang
  /** The sender's identity; absent when the link is unknown or the database is down. */
  identity?: { legalName: string; postalAddress: string } | null
  /** The page's own path, for the form and the retry link. */
  path: string
}

/** The HTML of one state. The footer shows only on Confirm, Done and Already. */
export function renderOptOutPage(input: OptOutPageInput): string {
  const t = TEXTS[input.state][input.lang]
  const name = input.identity?.legalName ?? (input.lang === "fr" ? "cet expéditeur" : "this sender")
  const path = escapeHtml(input.path)
  const control = t.button
    ? `<form method="post" action="${path}"><button type="submit">${escapeHtml(t.button)}</button></form>`
    : t.retry
      ? `<a class="retry" href="${path}">${escapeHtml(t.retry)}</a>`
      : ""
  const withFooter =
    input.identity &&
    (input.state === "confirm" || input.state === "done" || input.state === "already")
  const footer = withFooter
    ? `<footer>${escapeHtml(`${input.identity?.legalName}, ${input.identity?.postalAddress}`)}</footer>`
    : ""
  return (
    `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">` +
    `<title>${escapeHtml(t.heading(name))}</title><style>${OPT_OUT_STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(t.heading(name))}</h1><p>${escapeHtml(t.body)}</p>` +
    `${control}${footer}</main></body></html>`
  )
}
