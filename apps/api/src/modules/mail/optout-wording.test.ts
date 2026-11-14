// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which inbound text asks to stop receiving mail. Matching is code: a short
// reply proposes on the phrase anywhere in its new text, a long one only when
// the phrase has a line of its own, and quoted history never counts.

import { describe, expect, it } from "bun:test"
import { OPT_OUT_MAX_WORDS, OPT_OUT_PHRASES, optOutPhraseIn } from "~/modules/mail/optout-wording"

/** `n` words of ordinary reply text, none of them asking anything. */
const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => ["thanks", "for", "the", "update", "on", "it"][i % 6]).join(
    " ",
  )

describe("opt-out wording", () => {
  const asks: Array<[string, string]> = [
    ["en", "Please unsubscribe me."],
    ["en", "STOP"],
    ["en", "Kindly remove me from this list"],
    ["en", "I want to opt out of these emails"],
    ["en", "Take me off your mailing list, thanks"],
    ["fr", "Je souhaite ne plus recevoir vos messages."],
    ["fr", "Merci de me désinscrire"],
    ["fr", "Désinscrivez-moi s'il vous plaît"],
    ["fr", "Je veux me désabonner"],
    ["fr", "Ne me contactez plus."],
    ["de", "Bitte abmelden"],
    ["de", "Ich möchte das abbestellen."],
    ["de", "Keine E-Mails mehr, danke"],
    ["es", "Quiero darme de baja"],
    ["es", "No quiero recibir más correos"],
    ["it", "Per favore cancellami"],
    ["it", "Disiscrivimi dalla lista"],
    ["it", "Non voglio più ricevere queste email"],
  ]

  it("the list holds at least 15 phrases across English, French, German, Spanish and Italian", () => {
    expect(Object.keys(OPT_OUT_PHRASES).sort()).toEqual(["de", "en", "es", "fr", "it"])
    expect(Object.values(OPT_OUT_PHRASES).flat().length).toBeGreaterThanOrEqual(15)
  })

  for (const [lang, text] of asks) {
    it(`a short reply asking to stop in ${lang} is an opt-out request: ${text}`, () => {
      expect(optOutPhraseIn(text)).not.toBeNull()
    })
  }

  it("a reply of 59 words with stop in it proposes; 60 and 61 words do not", () => {
    // Mutation caught: a word bound of `<=` (60 proposes) or no bound at all (61 proposes).
    const at = (n: number) => `${filler(n - 1)} stop`
    expect(OPT_OUT_MAX_WORDS).toBe(60)
    expect(optOutPhraseIn(at(59))).toBe("stop")
    expect(optOutPhraseIn(at(60))).toBeNull()
    expect(optOutPhraseIn(at(61))).toBeNull()
  })

  it("a long reply proposes when the phrase stands on a line of its own", () => {
    expect(optOutPhraseIn(`${filler(80)}\n\nUnsubscribe, please.\n\n${filler(20)}`)).toBe(
      "unsubscrib*",
    )
    expect(optOutPhraseIn(`${filler(80)} please do not stop the delivery ${filler(10)}`)).toBeNull()
  })

  it("stop quoted from an earlier message proposes nothing", () => {
    const body = [
      "Sounds good, see you Tuesday.",
      "",
      "On Mon, 3 Nov 2026 at 10:00, Sales <sales@org.test> wrote:",
      "> Reply STOP to unsubscribe.",
    ].join("\n")
    expect(optOutPhraseIn(body)).toBeNull()
    expect(optOutPhraseIn("> unsubscribe\n> stop")).toBeNull()
  })

  it("a word that only contains a phrase is not one", () => {
    expect(optOutPhraseIn("The shipment stopped at customs, nonstop delays.")).toBeNull()
    expect(optOutPhraseIn("")).toBeNull()
    expect(optOutPhraseIn(null)).toBeNull()
  })
})
