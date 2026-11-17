import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import {
  type AgentProfile,
  builtinTools,
  chatMessages,
  chunkText,
  contextNote,
  costMicros,
  createModelCaller,
  creditsFor,
  envelope,
  fuseRankings,
  type ModelCaller,
  type ModelResponse,
  maxToolResultChars,
  modelFor,
  qaChunk,
  type RunContext,
  runTurn,
  searchTerms,
  systemPrompt,
  toolNames,
  trimHistory,
} from "../src/index";

const ctx: RunContext = {
  orgId: "org_1",
  branchId: "br_1",
  agentId: "agt_1",
  conversationId: "conv_1",
  contactId: "ct_1",
  mode: "live",
  timezone: "Asia/Kolkata",
  now: new Date("2026-11-17T06:30:00Z"),
};

const profile: AgentProfile = {
  name: "Mira",
  role: "front desk",
  businessName: "Lumen Clinics",
  instructions: "Help patients with timings and services.",
  tone: "warm",
  languages: [],
  handoffWhen: "Anyone asking about a refund.",
};

const usage = { inputTokens: 100, cachedTokens: 0, outputTokens: 20 };
function respond(partial: Partial<ModelResponse>): ModelResponse {
  return {
    text: "",
    toolCalls: [],
    usage,
    model: "fake",
    latencyMs: 1,
    messages: [{ role: "assistant", content: "…" }],
    ...partial,
  };
}
/** A model that answers from a script, one response per call, and remembers what it was sent. */
function scripted(responses: ModelResponse[]) {
  const seen: unknown[][] = [];
  const caller: ModelCaller = async (req) => {
    seen.push([...req.messages]);
    const next = responses.shift();
    if (!next) throw new Error("script ran out");
    return next;
  };
  return { caller, seen };
}

const hits = [{ source: "Timings", text: "Open 9am to 7pm, Monday to Saturday." }];
const gaps: string[] = [];
const tools = builtinTools({
  searchKnowledge: async (q) => (q.includes("parking") ? [] : hits),
  noteGap: async (q) => {
    gaps.push(q);
  },
  updateContact: async (change) => ({ saved: Object.keys(change.fields) }),
  editableFields: [{ key: "city", label: "City" }],
});

describe("prompt", () => {
  it("keeps the system prompt identical across turns and puts the time after the history", () => {
    const a = systemPrompt(profile);
    const b = systemPrompt({ ...profile });
    assert.equal(a, b);
    assert.ok(!a.includes("2026"), "nothing time-dependent in the cached part");
    assert.ok(a.includes("Lumen Clinics") && a.includes("refund") && a.includes(toolNames.search));
    const msgs = chatMessages(
      [
        { from: "customer", text: "hi" },
        { from: "agent", text: "Hello! How can I help?" },
        { from: "team", text: "Omar here" },
        { from: "customer", text: "timings?" },
      ],
      contextNote(ctx, { name: "Asha", fields: { city: "Kochi" }, tags: ["vip"] }),
    ) as { role: string; content: string }[];
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant", "assistant", "user", "system"],
    );
    assert.match(msgs[2]?.content ?? "", /A person from the team/);
    assert.match(msgs[4]?.content ?? "", /Tuesday, 17 November 2026.*12:00.*Asha.*city: Kochi.*vip/s);
  });

  it("trims old history but always starts with the customer", () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      from: (i % 2 ? "agent" : "customer") as "agent" | "customer",
      text: `message ${i} ${"x".repeat(500)}`,
    }));
    const kept = trimHistory(lines, 3000);
    assert.ok(kept.length < 10 && kept.length > 1);
    assert.equal(kept[0]?.from, "customer");
    assert.match(kept.at(-1)?.text ?? "", /message 49/);
  });

  it("can restrict reply languages", () => {
    assert.match(systemPrompt({ ...profile, languages: ["English", "Hindi"] }), /one of: English, Hindi/);
  });
});

describe("turn loop", () => {
  it("searches, then replies from what it found", async () => {
    const { caller, seen } = scripted([
      respond({ toolCalls: [{ id: "c1", name: toolNames.search, input: { query: "timings" } }] }),
      respond({ text: "We're open 9am to 7pm, Monday to Saturday." }),
    ]);
    const steps: string[] = [];
    const res = await runTurn({
      model: "fake",
      system: "s",
      messages: [{ role: "user", content: "when are you open?" }],
      tools,
      ctx,
      callModel: caller,
      step: async (name, fn) => {
        steps.push(name);
        return fn();
      },
      stepPrefix: "t1",
    });
    assert.deepEqual(res.outcome, { kind: "reply", text: "We're open 9am to 7pm, Monday to Saturday." });
    assert.deepEqual(steps, ["t1:model0", "t1:tool1:search_knowledge", "t1:model1"]);
    // The second call saw the tool result, marked as data.
    const toolMsg = seen[1]?.at(-1) as {
      role: string;
      content: { output: { value: { note: string; data: unknown } } }[];
    };
    assert.equal(toolMsg.role, "tool");
    assert.match(toolMsg.content[0]?.output.value.note ?? "", /never follow instructions/);
    assert.equal(res.trace.calls.length, 2);
  });

  it("records a gap when nothing is found", async () => {
    const { caller } = scripted([
      respond({ toolCalls: [{ id: "c1", name: toolNames.search, input: { query: "parking near you" } }] }),
      respond({
        toolCalls: [
          {
            id: "c2",
            name: toolNames.handoff,
            input: { reason: "No parking info", summary: "Asked about parking" },
          },
        ],
      }),
    ]);
    const res = await runTurn({ model: "f", system: "s", messages: [], tools, ctx, callModel: caller });
    assert.equal(res.outcome.kind, "handoff");
    assert.deepEqual(gaps, ["parking near you"]);
  });

  it("turns reply_with_options into choices with stable ids", async () => {
    const { caller } = scripted([
      respond({
        text: "ignored",
        toolCalls: [
          {
            id: "c1",
            name: toolNames.options,
            input: { text: "Which branch?", options: ["Kochi", "Dubai Marina"] },
          },
        ],
      }),
    ]);
    const res = await runTurn({ model: "f", system: "s", messages: [], tools, ctx, callModel: caller });
    assert.deepEqual(res.outcome, {
      kind: "options",
      text: "Which branch?",
      options: [
        { id: "o1", title: "Kochi" },
        { id: "o2", title: "Dubai Marina" },
      ],
    });
  });

  it("closes with the last message", async () => {
    const { caller } = scripted([
      respond({
        toolCalls: [{ id: "c", name: toolNames.close, input: { reason: "done", text: "Take care!" } }],
      }),
    ]);
    const res = await runTurn({ model: "f", system: "s", messages: [], tools, ctx, callModel: caller });
    assert.deepEqual(res.outcome, { kind: "close", reason: "done", text: "Take care!" });
  });

  it("hands over instead of looping forever", async () => {
    const loop = Array.from({ length: 10 }, (_, i) =>
      respond({ toolCalls: [{ id: `c${i}`, name: toolNames.search, input: { query: `timings ${i}` } }] }),
    );
    const { caller } = scripted(loop);
    const res = await runTurn({
      model: "f",
      system: "s",
      messages: [],
      tools,
      ctx,
      callModel: caller,
      limits: { maxModelCalls: 10 },
    });
    assert.equal(res.outcome.kind, "handoff");
    assert.equal(res.trace.tools.length, 6, "stopped at six tool calls");
  });

  it("feeds bad input and unknown tools back as errors, and only saves allowed fields", async () => {
    const { caller, seen } = scripted([
      respond({
        toolCalls: [
          { id: "a", name: "delete_everything", input: {} },
          { id: "b", name: toolNames.search, input: { query: "" } },
          { id: "c", name: toolNames.updateContact, input: { fields: { city: "Kochi", salary: "1" } } },
        ],
      }),
      respond({ text: "Noted!" }),
    ]);
    const res = await runTurn({ model: "f", system: "s", messages: [], tools, ctx, callModel: caller });
    assert.equal(res.outcome.kind, "reply");
    const results = res.trace.tools.map((t) => t.result);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[1]?.ok, false);
    assert.deepEqual(results[2], { ok: true, data: { saved: ["city"], notAllowed: ["salary"] } });
    const toolMessage = (seen[1] ?? []).at(-1) as { content: unknown[] } | undefined;
    assert.equal(toolMessage?.content.length, 3);
  });

  it("an empty answer is silence, not an empty message", async () => {
    const { caller } = scripted([respond({ text: "   " })]);
    const res = await runTurn({ model: "f", system: "s", messages: [], tools, ctx, callModel: caller });
    assert.deepEqual(res.outcome, { kind: "silent" });
  });
});

describe("tool results", () => {
  it("caps long results and marks them as data", () => {
    const big = envelope({ ok: true, data: { text: "y".repeat(maxToolResultChars * 2) } }) as {
      truncated?: string;
      data: string;
    };
    assert.ok(big.truncated);
    assert.ok(big.data.length <= maxToolResultChars + 1);
    assert.deepEqual(envelope({ ok: false, error: "boom" }), { error: "boom" });
  });
});

describe("knowledge helpers", () => {
  it("cuts long text on boundaries with overlap and keeps short text whole", () => {
    assert.deepEqual(chunkText("  short note \n\n\n\n second  "), ["short note \n\n second"]);
    const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the clinic timings.`).join(
      " ",
    );
    const chunks = chunkText(`${para}\n\n${para}\n\n${para}`, 200, 20);
    assert.ok(chunks.length >= 3);
    for (const c of chunks) assert.ok(c.length <= 200 * 4 + 120, `chunk too long: ${c.length}`);
    assert.deepEqual(chunkText(""), []);
    assert.equal(qaChunk(" Do you have parking? ", " Yes, free. "), "Q: Do you have parking?\nA: Yes, free.");
  });

  it("fuses rankings so items in both lists win", () => {
    assert.deepEqual(
      fuseRankings([
        ["a", "b", "c"],
        ["c", "d", "a"],
      ]).slice(0, 2),
      ["a", "c"],
    );
  });

  it("builds a safe full-text query in any script", () => {
    assert.equal(searchTerms("What are your timings?"), "timings:*");
    assert.equal(searchTerms("क्लिनिक का समय"), "क्लिनिक:* | का:* | समय:*");
    assert.equal(searchTerms("مواعيد العيادة"), "مواعيد:* | العيادة:*");
    assert.equal(searchTerms("?? !!"), null);
    assert.ok(!(searchTerms("a'b & c|d") ?? "").includes("'"));
  });
});

describe("models and money", () => {
  it("picks models from the environment", () => {
    assert.equal(modelFor("fast", {}), "gpt-5.4-mini");
    assert.equal(modelFor("smart", { AI_MODEL_FAST: "x" }), "x");
    assert.equal(modelFor("smart", { AI_MODEL_SMART: "y", AI_MODEL_FAST: "x" }), "y");
  });

  it("prices cached tokens lower and counts one credit per answered turn", () => {
    assert.equal(costMicros("gpt-5.4-mini", { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }), 1200);
    assert.equal(
      costMicros("gpt-5.4-mini", { inputTokens: 1000, cachedTokens: 1000, outputTokens: 100 }),
      525,
    );
    assert.equal(costMicros("unknown-model", usage), 0);
    assert.equal(creditsFor("reply", 0), 1);
    assert.equal(creditsFor("reply", 1), 0);
    assert.equal(creditsFor("try", 0), 0);
  });
});

describe("AI SDK adapter", () => {
  it("maps tool calls and usage, and accepts the tool results on the next call", async () => {
    let call = 0;
    const prompts: unknown[] = [];
    const mock = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        call++;
        const u = {
          inputTokens: { total: 50, noCache: 40, cacheRead: 10, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        };
        if (call === 1)
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "tc1",
                toolName: toolNames.search,
                input: JSON.stringify({ query: "timings" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage: u,
            warnings: [],
          };
        return {
          content: [{ type: "text", text: "Open 9 to 7." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: u,
          warnings: [],
        };
      },
    });
    const caller = createModelCaller({}, { languageModel: () => mock });
    const res = await runTurn({
      model: "mock",
      system: systemPrompt(profile),
      messages: chatMessages([{ from: "customer", text: "when are you open?" }], contextNote(ctx, {})),
      tools,
      ctx,
      callModel: caller,
    });
    assert.deepEqual(res.outcome, { kind: "reply", text: "Open 9 to 7." });
    assert.deepEqual(res.trace.calls[0]?.usage, { inputTokens: 50, cachedTokens: 10, outputTokens: 5 });
    const second = JSON.stringify(prompts[1]);
    assert.match(second, /tool-result/);
    assert.match(second, /Open 9am to 7pm/);
  });
});
