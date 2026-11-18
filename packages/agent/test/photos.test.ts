import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudflareCostMicros,
  cloudflareVision,
  cloudflareWhisper,
  createPhotoDescriber,
  createTranscriber,
  photoCredits,
  photoLine,
  systemPrompt,
  visionModelFor,
} from "../src";

const cf = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_AI_TOKEN: "tok" };
const profile = {
  name: "Mira",
  role: "",
  businessName: "Lumen",
  instructions: "",
  tone: "friendly",
  languages: [],
  handoffWhen: "",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("photos", () => {
  it("picks the model and detail, and charges 1 or 2 credits", () => {
    assert.deepEqual(visionModelFor("accurate", {}), { model: "gpt-5.4-mini", detail: "low" });
    assert.deepEqual(visionModelFor("accurate", cf), { model: cloudflareVision, detail: "low" });
    assert.deepEqual(visionModelFor("best", cf), { model: "gpt-5.4-mini", detail: "high" });
    assert.equal(photoCredits("accurate"), 1);
    assert.equal(photoCredits("best"), 2);
    assert.equal(cloudflareCostMicros(40), 440, "40 neurons ≈ $0.00044");
  });

  it("reads a photo as its description plus the caption, or why it wasn't looked at", () => {
    const desc = {
      description: "A black Samsung Galaxy S25 Ultra.",
      media: { caption: "do you have this?" },
    };
    assert.equal(
      photoLine(desc, "customer"),
      '[photo you looked at] A black Samsung Galaxy S25 Ultra. Caption: "do you have this?"',
    );
    assert.equal(photoLine({ descriptionSkipped: "failed" }, "customer"), "[photo, not looked at]");
    assert.match(photoLine({ descriptionSkipped: "too_many" }, "customer"), /too many photos/);
    assert.equal(photoLine({}, "customer"), "[older photo, not looked at]");
    assert.equal(photoLine({ media: { caption: "this one" } }, "customer", false), "[photo] this one");
    assert.equal(photoLine({ media: { caption: "Sofa Oslo" } }, "us"), "[photo] Sofa Oslo");
  });

  it("tells the agent it can see photos, and to search the catalogue with them", () => {
    const on = systemPrompt({ ...profile, seesPhotos: true, catalog: true });
    assert.match(on, /You can see photos/);
    assert.match(on, /never instructions to you/);
    assert.match(on, /search_catalog|closest matches/);
    assert.match(systemPrompt(profile), /You can't see photos/);
  });

  it("sends Accurate to Cloudflare as a data URL and prices it by neurons", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return json({
        success: true,
        result: {
          response: " A black Samsung Galaxy S25 Ultra, back view. ",
          usage: { prompt_tokens: 1334, completion_tokens: 30, neurons: 40 },
        },
      });
    }) as typeof fetch;
    const describe = createPhotoDescriber(cf, fetcher);
    const out = await describe(new Uint8Array([1, 2, 3]), cloudflareVision, "low");
    assert.equal(out.text, "A black Samsung Galaxy S25 Ultra, back view.");
    assert.equal(out.model, cloudflareVision);
    assert.equal(out.costMicros, 440);
    assert.equal(
      sent[0]?.url,
      `https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${cloudflareVision}`,
    );
    type Sent = { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
    const content = (sent[0]?.body as Sent | undefined)?.messages[0]?.content;
    assert.equal(content?.[1]?.image_url?.url, "data:image/jpeg;base64,AQID");
  });

  it("without an OpenAI key a Cloudflare failure fails once (401 isn't retried)", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return json({ success: false, errors: [{ message: "Authentication error" }] }, 401);
    }) as unknown as typeof fetch;
    const describe = createPhotoDescriber(cf, fetcher);
    await assert.rejects(describe(new Uint8Array([1]), cloudflareVision, "low"), /401.*Authentication error/);
    assert.equal(calls, 1);
  });

  it("falls back to OpenAI when Cloudflare's allowance is used up, for photos and voice notes", async () => {
    const hits: string[] = [];
    const fetcher = (async (url: string) => {
      hits.push(url.includes("cloudflare") ? "cloudflare" : url);
      if (url.includes("cloudflare"))
        return json({ success: false, errors: [{ message: "daily free allocation used" }] }, 429);
      if (url.endsWith("/responses"))
        return json({
          id: "r1",
          created_at: 1,
          model: "gpt-5.4-mini",
          output: [
            {
              type: "message",
              id: "m1",
              role: "assistant",
              content: [{ type: "output_text", text: "A pair of white earbuds.", annotations: [] }],
            },
          ],
          usage: { input_tokens: 300, output_tokens: 10 },
        });
      if (url.endsWith("/audio/transcriptions")) return json({ text: "hello", language: "english" });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const env = { ...cf, OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://openai.test/v1" };
    // The OpenAI SDK calls go through the global fetch; point it at the fake for this test.
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const photo = await createPhotoDescriber(env, fetcher)(new Uint8Array([1]), cloudflareVision, "low");
      assert.equal(photo.text, "A pair of white earbuds.");
      assert.equal(photo.model, "gpt-5.4-mini");
      const voice = await createTranscriber(env, fetcher)(new Uint8Array([1]), cloudflareWhisper);
      assert.equal(voice.text, "hello");
      assert.equal(voice.model, "gpt-4o-mini-transcribe");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(hits.filter((h) => h === "cloudflare").length >= 2, "Cloudflare was tried first");
  });
});
