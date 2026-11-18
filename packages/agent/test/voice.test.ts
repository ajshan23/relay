import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudflareWhisper,
  createTranscriber,
  systemPrompt,
  transcribeCostMicros,
  transcribeCredits,
  transcribeModelFor,
  voiceNoteLine,
} from "../src";

describe("voice notes", () => {
  it("charges per started minute, twice for more accurate", () => {
    assert.equal(transcribeCredits("accurate", 5), 1);
    assert.equal(transcribeCredits("accurate", 60), 1);
    assert.equal(transcribeCredits("accurate", 61), 2);
    assert.equal(transcribeCredits("best", 20), 2);
    assert.equal(transcribeCredits("best", 150), 6);
  });

  it("picks the model from the choice, overridable by env", () => {
    assert.equal(transcribeModelFor("accurate", {}), "gpt-4o-mini-transcribe");
    assert.equal(transcribeModelFor("best", {}), "gpt-4o-transcribe");
    assert.equal(transcribeModelFor("best", { AI_TRANSCRIBE_MODEL_BEST: "x" }), "x");
    const cf = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_AI_TOKEN: "tok" };
    assert.equal(transcribeModelFor("accurate", cf), cloudflareWhisper, "Cloudflare when set up");
    assert.equal(transcribeModelFor("best", cf), "gpt-4o-transcribe", "More accurate stays on OpenAI");
  });

  it("prices by the minute", () => {
    assert.equal(transcribeCostMicros("gpt-4o-mini-transcribe", 60), 3000);
    assert.equal(transcribeCostMicros("gpt-4o-transcribe", 30), 3000);
    assert.equal(transcribeCostMicros("unknown", 60), 0);
  });

  it("reads a voice note as what was said, or why it wasn't heard", () => {
    assert.equal(
      voiceNoteLine({ transcript: " price of the S25? " }, "customer"),
      "[voice note you listened to] price of the S25?",
    );
    assert.equal(
      voiceNoteLine({ transcriptSkipped: "too_long" }, "customer"),
      "[voice note, not heard: longer than 3 minutes]",
    );
    assert.equal(voiceNoteLine({ transcriptSkipped: "failed" }, "customer"), "[voice note, not heard]");
    assert.equal(
      voiceNoteLine({ transcript: "" }, "customer"),
      "[voice note you listened to: no words in it]",
    );
    assert.equal(voiceNoteLine({}, "customer"), "[older voice note, not heard]");
    assert.equal(voiceNoteLine({}, "customer", false), "[voice note]");
    assert.equal(voiceNoteLine({}, "us"), "[voice note]");
  });

  it("tells the agent how to treat voice notes", () => {
    const p = systemPrompt({
      name: "Mira",
      role: "",
      businessName: "Lumen",
      instructions: "",
      tone: "friendly",
      languages: [],
      handoffWhen: "",
    });
    assert.match(p, /You can't listen to voice notes/);
    const hears = systemPrompt({
      name: "Mira",
      role: "",
      businessName: "Lumen",
      instructions: "",
      tone: "friendly",
      languages: [],
      handoffWhen: "",
      hearsVoiceNotes: true,
    });
    assert.match(hears, /You can listen to voice notes/);
    assert.match(hears, /say yes/);
  });

  it("sends Accurate to Cloudflare as base64 and reads the text back", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            text: " مرحبا، هل الهاتف متوفر؟ ",
            transcription_info: { language: "ar", duration: 3.2 },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const t = createTranscriber({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_AI_TOKEN: "tok" }, fakeFetch);
    const out = await t(new Uint8Array([1, 2, 3]), cloudflareWhisper);
    assert.deepEqual(out, { text: "مرحبا، هل الهاتف متوفر؟", language: "ar", seconds: 3.2 });
    assert.equal(
      sent[0]?.url,
      `https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${cloudflareWhisper}`,
    );
    assert.equal((sent[0]?.init.headers as Record<string, string> | undefined)?.Authorization, "Bearer tok");
    assert.equal(JSON.parse(String(sent[0]?.init.body)).audio, "AQID");
  });

  it("gives up at once on a bad Cloudflare token", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), {
        status: 401,
      });
    }) as unknown as typeof fetch;
    const t = createTranscriber({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_AI_TOKEN: "bad" }, fakeFetch);
    await assert.rejects(t(new Uint8Array([1]), cloudflareWhisper), /401.*Authentication error/);
    assert.equal(calls, 1);
  });
});
