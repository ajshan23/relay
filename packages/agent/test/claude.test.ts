import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentTool, RunContext } from "../src";
import {
  anthropicKey,
  costMicros,
  createClaudeCaller,
  createModelCaller,
  defaultChatModel,
  defaultClaudeModel,
  modelFor,
  runTurn,
  toAnthropicMessages,
} from "../src";

const ctx: RunContext = {
  orgId: "org",
  branchId: "br",
  agentId: "agt",
  conversationId: null,
  contactId: null,
  mode: "test",
  timezone: "Asia/Dubai",
  now: new Date("2026-11-21T10:00:00Z"),
};

/** A fake Anthropic client: hands back the scripted replies in order and keeps every request. */
function fakeClient(replies: Partial<Anthropic.Message>[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = {
    messages: {
      create: async (body: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(JSON.parse(JSON.stringify(body)));
        const next = replies.shift();
        if (!next) throw new Error("no more scripted replies");
        return {
          model: "claude-haiku-5-5",
          stop_reason: "end_turn",
          stop_details: null,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
          },
          ...next,
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, requests };
}

const searchTool: AgentTool<unknown> = {
  name: "search_knowledge",
  description: "Search the business's knowledge.",
  kind: "read",
  input: z.object({ query: z.string() }),
  run: async () => ({ ok: true, data: { results: [{ text: "Basic is $35 a month." }] } }),
} as unknown as AgentTool<unknown>;

describe("Claude for chat replies", () => {
  it("picks Claude Haiku 5.5 when the agent's AI model is Claude, GPT otherwise", () => {
    assert.equal(modelFor("fast", {}, "claude"), defaultClaudeModel);
    assert.equal(modelFor("smart", {}, "claude"), "claude-haiku-5-5");
    assert.equal(modelFor("fast", {}, "gpt"), defaultChatModel);
    assert.equal(modelFor("fast", {}), defaultChatModel);
    assert.equal(modelFor("fast", { AI_CLAUDE_MODEL: "claude-sonnet-5-5" }, "claude"), "claude-sonnet-5-5");
  });

  it("reads the key from ANTHROPIC_API_KEY or CLOUD_APIKEY", () => {
    assert.equal(anthropicKey({ ANTHROPIC_API_KEY: "a", CLOUD_APIKEY: "b" }), "a");
    assert.equal(anthropicKey({ CLOUD_APIKEY: "b" }), "b");
    assert.equal(anthropicKey({}), undefined);
  });

  it("prices Haiku 5.5 per token", () => {
    // 100k fresh input at $0.10/M = 10,000 micros; 1M cached at $0.01/M = 10,000; 10k output at $0.50/M = 5,000.
    assert.equal(
      costMicros("claude-haiku-5-5", {
        inputTokens: 1_100_000,
        cachedTokens: 1_000_000,
        outputTokens: 10_000,
      }),
      25_000,
    );
  });

  it("turns the harness's messages into Anthropic's", () => {
    const out = toAnthropicMessages([
      { role: "assistant", content: "Hi, I'm Mira from Lumen." },
      { role: "user", content: "how much is basic?" },
      { role: "system", content: "Today is Saturday." },
      {
        role: "assistant",
        content: "",
        _anthropic: [{ type: "tool_use", id: "t1", name: "search_knowledge", input: { query: "basic" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "search_knowledge",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      { role: "assistant", content: "Basic is $35.", _anthropic: [{ type: "text", text: "Basic is $35." }] },
      { role: "system", content: "That message was not sent." },
    ]);
    // A chat that opens with our message gets a customer turn in front; a system note after a reply
    // becomes a marked user message; one after a user turn stays a system message.
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "assistant", "user", "system", "assistant", "user", "assistant", "user"],
    );
    assert.deepEqual(out[5]?.content, [{ type: "tool_result", tool_use_id: "t1", content: '{"ok":true}' }]);
    assert.match(
      String(out[7]?.content),
      /^\[Note from the system, not the customer:\] That message was not sent/,
    );
  });

  it("never puts a system message right before a customer's message (the 400 from the Operium support chat)", () => {
    const out = toAnthropicMessages([
      { role: "user", content: "Can someone call me back tomorrow?" },
      { role: "system", content: "Follow-up added to Google Tasks: Call back Ajmal." },
      { role: "assistant", content: "I'm passing you to someone from the team." },
      { role: "system", content: "Mira handed this chat over: wants a callback." },
      { role: "system", content: "Follow-up added to Google Tasks: Reply on WhatsApp." },
      { role: "user", content: "Can someone call me today itself?" },
      { role: "system", content: "Follow-ups already added for the team in this chat." },
    ]);
    assert.deepEqual(
      out.map((m) => m.role),
      ["user", "system", "assistant", "user", "user", "user", "system"],
    );
    // The rule Claude checks: every system message comes after a user turn, and before an assistant
    // turn or at the end.
    out.forEach((m, i) => {
      if (m.role !== "system") return;
      assert.equal(out[i - 1]?.role, "user");
      assert.ok(i === out.length - 1 || out[i + 1]?.role === "assistant");
    });
  });

  it("runs a whole turn: a tool call, its result, then the reply, with Claude's blocks sent back unchanged", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
    const { client, requests } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          thinking,
          { type: "tool_use", id: "tu_1", name: "search_knowledge", input: { query: "basic price" } },
        ] as never,
      },
      { content: [{ type: "text", text: "Basic is $35 a month." }] as never },
    ]);
    const result = await runTurn({
      model: "claude-haiku-5-5",
      system: "You are Mira.",
      messages: [
        { role: "user", content: "how much is basic?" },
        { role: "system", content: "Today is Saturday." },
      ],
      tools: [searchTool],
      ctx,
      callModel: createClaudeCaller({}, { client }),
    });
    assert.deepEqual(result.outcome, { kind: "reply", text: "Basic is $35 a month." });
    assert.equal(requests.length, 2);
    const first = requests[0] as Anthropic.MessageCreateParamsNonStreaming;
    assert.equal(first.model, "claude-haiku-5-5");
    assert.deepEqual(first.output_config, { effort: "low" });
    assert.deepEqual(first.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.equal((first.tools?.[0] as Anthropic.Tool | undefined)?.name, "search_knowledge");
    const second = (requests[1] as Anthropic.MessageCreateParamsNonStreaming).messages;
    // The thinking block and tool call go back exactly as Claude sent them, then the tool's result.
    assert.deepEqual(second.at(-2)?.content, [
      thinking,
      { type: "tool_use", id: "tu_1", name: "search_knowledge", input: { query: "basic price" } },
    ]);
    const toolResult = ((second.at(-1)?.content ?? []) as { type: string; tool_use_id: string }[])[0];
    assert.equal(toolResult?.type, "tool_result");
    assert.equal(toolResult?.tool_use_id, "tu_1");
    // Usage counts cached tokens inside input, as the price table expects.
    assert.deepEqual(result.trace.calls[0]?.usage, {
      inputTokens: 1000,
      cachedTokens: 900,
      outputTokens: 20,
    });
  });

  it("fails clearly without a key, and a refusal is an error (the chat goes to the team)", async () => {
    const caller = createModelCaller({ OPENAI_API_KEY: "sk-test" });
    await assert.rejects(
      caller({
        model: "claude-haiku-5-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
      /ANTHROPIC_API_KEY is not set/,
    );
    const { client } = fakeClient([
      { stop_reason: "refusal", stop_details: { category: "cyber" } as never, content: [] },
    ]);
    await assert.rejects(
      createClaudeCaller(
        {},
        { client },
      )({ model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }),
      /declined/,
    );
  });
});
