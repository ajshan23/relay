import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { builtinTools, openFollowUpsNote, systemPrompt, taskToolNames } from "../src";

const profile = {
  name: "Mira",
  role: "",
  businessName: "Lumen",
  instructions: "",
  tone: "friendly",
  languages: [],
  handoffWhen: "",
};

describe("follow-up tasks", () => {
  it("are offered only when the branch connected Google Tasks", () => {
    const base = { searchKnowledge: async () => [], editableFields: [] };
    assert.ok(!builtinTools(base).some((t) => t.name === taskToolNames.add));
    const tools = builtinTools({ ...base, tasks: { add: async () => ({ added: true }) } });
    const tool = tools.find((t) => t.name === taskToolNames.add);
    assert.equal(tool?.kind, "write");
    assert.ok(tool?.input.safeParse({ title: "Call back Sam", details: "", due: "tomorrow" }).success);
    assert.ok(!tool?.input.safeParse({ title: "x", details: "" }).success, "a real title is needed");
  });

  it("are explained in the prompt, and the chat's open ones are listed for the agent", () => {
    assert.doesNotMatch(systemPrompt(profile), /Follow-ups for the team/);
    assert.match(
      systemPrompt({ ...profile, followUps: true }),
      /## Follow-ups for the team[\s\S]*add_follow_up_task/,
    );
    assert.equal(openFollowUpsNote([]), null);
    assert.equal(
      openFollowUpsNote([
        { title: "Call back Sam", due: "Sun 22 Nov" },
        { title: "Send the quote", due: null },
      ]),
      "Follow-ups already added for the team in this chat and not done yet:\n- Call back Sam (due Sun 22 Nov)\n- Send the quote",
    );
  });
});
