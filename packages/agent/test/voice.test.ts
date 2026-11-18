import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
  });

  it("prices by the minute", () => {
    assert.equal(transcribeCostMicros("gpt-4o-mini-transcribe", 60), 3000);
    assert.equal(transcribeCostMicros("gpt-4o-transcribe", 30), 3000);
    assert.equal(transcribeCostMicros("unknown", 60), 0);
  });

  it("reads a voice note as what was said, or why it wasn't heard", () => {
    assert.equal(
      voiceNoteLine({ transcript: " price of the S25? " }, "customer"),
      "[voice note] price of the S25?",
    );
    assert.equal(
      voiceNoteLine({ transcriptSkipped: "too_long" }, "customer"),
      "[voice note, not heard: longer than 3 minutes]",
    );
    assert.equal(voiceNoteLine({ transcriptSkipped: "failed" }, "customer"), "[voice note, not heard]");
    assert.match(voiceNoteLine({}, "customer"), /can't listen/);
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
    assert.match(p, /Never say you only read text/);
  });
});
