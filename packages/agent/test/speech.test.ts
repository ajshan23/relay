import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSpeaker,
  defaultCartesiaVoice,
  speechCostMicros,
  speechLanguage,
  speechText,
  systemPrompt,
  voiceNoteLine,
} from "../src";

describe("voice replies", () => {
  it("picks the language from the script, and skips scripts the voice can't speak", () => {
    assert.equal(speechLanguage("Yes, we have it in black."), "en");
    assert.equal(speechLanguage("نعم، عندنا باللون الأسود"), "ar");
    assert.equal(speechLanguage("जी हाँ, काले रंग में है"), "hi");
    assert.equal(speechLanguage("ഉണ്ട്, കറുപ്പിൽ"), "ml");
    assert.equal(speechLanguage("是的，我们有黑色的"), null);
    assert.equal(speechLanguage("👍 4,999"), null);
  });

  it("speaks the reply without formatting, and keeps links and long numbers in text too", () => {
    assert.equal(speechText("It's in stock 😊 It's AED 4,999.").say, "It's in stock. It's AED 4,999.");
    assert.equal(speechText("Great choice! 👍 Want one?").say, "Great choice! Want one?");
    assert.deepEqual(speechText("*Yes!* It's AED 4,999 😊"), {
      say: "Yes! It's AED 4,999",
      alsoAsText: false,
    });
    const link = speechText("Pay here: https://pay.example.com/abc");
    assert.equal(link.say, "Pay here: the link below");
    assert.equal(link.alsoAsText, true);
    assert.equal(speechText("Call us on 050 123 4567").alsoAsText, true);
  });

  it("prices speech per character, and remembers what the agent said in its own voice notes", () => {
    assert.equal(speechCostMicros(150), 7500, "150 characters ≈ $0.0075");
    assert.equal(
      voiceNoteLine({ transcript: "It's in stock." }, "us"),
      "[voice note you sent] It's in stock.",
    );
  });

  it("asks the agent to write replies the way they'd be said, only when voice replies are on", () => {
    const base = {
      name: "Mira",
      role: "",
      businessName: "Lumen",
      instructions: "",
      tone: "friendly",
      languages: [],
      handoffWhen: "",
    };
    assert.match(systemPrompt({ ...base, repliesByVoice: true }), /sent as voice notes/);
    assert.doesNotMatch(systemPrompt(base), /sent as voice notes/);
  });

  it("calls Cartesia with the chosen voice and language, and stops at once on a bad key", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;
    const out = await createSpeaker({ CARTESIA_KEY: "k" }, ok)("Hello there", "en");
    assert.deepEqual([...out.audio], [1, 2, 3]);
    assert.equal(out.characters, 11);
    assert.equal(sent[0]?.url, "https://api.cartesia.ai/tts/bytes");
    const body = JSON.parse(String(sent[0]?.init.body));
    assert.equal(body.voice.id, defaultCartesiaVoice);
    assert.equal(body.language, "en");
    assert.equal(body.model_id, "sonic-3");

    let calls = 0;
    const bad = (async () => {
      calls++;
      return new Response("invalid key", { status: 401 });
    }) as unknown as typeof fetch;
    await assert.rejects(createSpeaker({ CARTESIA_KEY: "x" }, bad)("Hi", "en"), /401/);
    assert.equal(calls, 1);
  });
});
