import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentPatchSchema, agentSettingsSchema, withinAgentHours } from "../src/agents";

describe("agent settings", () => {
  it("fills defaults for a new agent but never for a partial save", () => {
    const fresh = agentSettingsSchema.parse({ name: "Mira", handoff: {} });
    assert.equal(fresh.tone, "friendly");
    assert.equal(fresh.answerUnclaimed, false);
    assert.equal(fresh.handoff.message.length > 0, true);
    // A Go live switch sends one setting: nothing else may come back reset.
    assert.deepEqual(agentPatchSchema.parse({ answerUnclaimed: true }), { answerUnclaimed: true });
    assert.deepEqual(agentPatchSchema.parse({ tone: "warm" }), { tone: "warm" });
    assert.equal(agentPatchSchema.safeParse({ name: "" }).success, false);
  });

  it("knows its working hours in the branch's time zone, including overnight hours", () => {
    const hours = { timezone: "Asia/Dubai", days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };
    // Tuesday 17 Nov 2026, 10:00 in Dubai = 06:00 UTC.
    assert.equal(withinAgentHours(hours, new Date("2026-11-17T06:00:00Z")), true);
    assert.equal(withinAgentHours(hours, new Date("2026-11-17T15:00:00Z")), false); // 19:00 Dubai
    assert.equal(withinAgentHours(hours, new Date("2026-11-21T06:00:00Z")), false); // Saturday
    const night = { timezone: "Asia/Kolkata", days: [0, 1, 2, 3, 4, 5, 6], from: "20:00", to: "08:00" };
    assert.equal(withinAgentHours(night, new Date("2026-11-17T17:00:00Z")), true); // 22:30 IST
    assert.equal(withinAgentHours(night, new Date("2026-11-17T06:30:00Z")), false); // 12:00 IST
    assert.equal(withinAgentHours(null), true);
  });
});
