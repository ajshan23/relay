import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AutomationDefinition,
  type AutomationNode,
  askLayout,
  describeRun,
  emptyDefinition,
  migrateDefinition,
  nodeSpecs,
  optionOfReply,
  optionReplyId,
  parseStepKey,
  pickAutomation,
  resolveText,
  starters,
  type Trigger,
  tapTarget,
  triggerMatches,
  triggersOverlap,
  typingPauseMs,
  validateDefinition,
  variablesUsed,
} from "../src/automations/index";

const node = (
  id: string,
  type: keyof typeof nodeSpecs,
  config?: Record<string, unknown>,
): AutomationNode => ({
  id,
  type,
  version: 1,
  config: config ?? (nodeSpecs[type].defaults() as Record<string, unknown>),
});
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  sourceHandle,
  target,
});
const codes = (def: AutomationDefinition, ctx = {}) =>
  validateDefinition(def, ctx).map((i) => `${i.level}:${i.code}`);

/** Welcome menu: ask with two buttons, every exit wired. */
function welcome(): AutomationDefinition {
  const def = emptyDefinition({
    type: "message_received",
    mode: "keyword",
    keywords: ["hi"],
    match: "exact",
  });
  def.nodes = [
    node("ask", "ask_question", {
      text: "Hi {{contact.first_name|there}}! What do you need?",
      answer: {
        type: "buttons",
        options: [
          { id: "a1", title: "Prices" },
          { id: "a2", title: "Talk to us" },
        ],
      },
      saveAs: "need",
      retries: 2,
      retryText: "Please tap a button.",
      timeoutMinutes: 60,
    }),
    node("prices", "send_message", { text: "Here you go, {{answers.need}}", media: null }),
    node("human", "handoff", { userId: null, note: "" }),
    node("bye", "end", {}),
  ];
  def.edges = [
    edge("trigger", "next", "ask"),
    edge("ask", "opt:a1", "prices"),
    edge("ask", "opt:a2", "human"),
    edge("ask", "invalid", "human"),
    edge("ask", "no_reply", "bye"),
  ];
  return def;
}

describe("validation", () => {
  it("accepts a complete welcome menu", () => {
    assert.deepEqual(
      validateDefinition(welcome()).filter((i) => i.level === "error"),
      [],
    );
  });

  it("refuses a question without its no-reply and didn't-understand exits", () => {
    const def = welcome();
    def.edges = def.edges.filter((e) => e.sourceHandle !== "no_reply" && e.sourceHandle !== "invalid");
    const c = codes(def);
    assert.ok(c.includes("error:NO_REPLY_PATH"));
    assert.ok(c.includes("error:INVALID_PATH"));
  });

  it("checks WhatsApp's limits on options: 20 characters for buttons, 24 for a list, at most 10", () => {
    const def = welcome();
    const ask = def.nodes[0] as AutomationNode;
    (ask.config.answer as { options: { id: string; title: string }[] }).options[0] = {
      id: "a1",
      title: "Twenty-one characters",
    };
    assert.ok(codes(def).includes("error:OPTION_TOO_LONG"));
    // As a list (4 options) the same title fits.
    (ask.config.answer as { options: { id: string; title: string }[] }).options.push(
      { id: "a3", title: "Three" },
      { id: "a4", title: "Four" },
    );
    assert.ok(!codes(def).includes("error:OPTION_TOO_LONG"));
    assert.equal(askLayout(3), "buttons");
    assert.equal(askLayout(4), "list");
    (ask.config.answer as { options: unknown[] }).options = Array.from({ length: 11 }, (_, i) => ({
      id: `o${i}`,
      title: `Option ${i}`,
    }));
    assert.ok(codes(def).includes("error:STEP_SETTINGS"));
  });

  it("counts an emoji as two characters in an option", () => {
    const def = welcome();
    const opts = (def.nodes[0] as AutomationNode).config.answer as {
      options: { id: string; title: string }[];
    };
    opts.options[0] = { id: "a1", title: "Prices and offers 🎉" }; // 18 letters + 2 = 20: fits
    assert.ok(!codes(def).includes("error:OPTION_TOO_LONG"));
    opts.options[0] = { id: "a1", title: "Prices and offers! 🎉" }; // 21
    assert.ok(codes(def).includes("error:OPTION_TOO_LONG"));
  });

  it("knows answers by name and flags unknown variables", () => {
    const def = welcome();
    (def.nodes[1] as AutomationNode).config.text = "You said {{answers.city}} and {{secret.thing}}";
    const c = codes(def);
    assert.ok(c.includes("error:ANSWER_MISSING"));
    assert.ok(c.includes("error:VARIABLE_UNKNOWN"));
  });

  it("refuses a loop that never waits, allows one that asks", () => {
    const def = emptyDefinition();
    def.nodes = [node("a", "add_tag", { tagId: "t1" }), node("b", "remove_tag", { tagId: "t1" })];
    def.edges = [edge("trigger", "next", "a"), edge("a", "next", "b"), edge("b", "next", "a")];
    assert.ok(codes(def).includes("error:LOOP_WITHOUT_PAUSE"));
    def.nodes.push(node("w", "wait", { mode: "delay", amount: 1, unit: "hours" }));
    def.edges = [
      edge("trigger", "next", "a"),
      edge("a", "next", "w"),
      edge("w", "next", "b"),
      edge("b", "next", "a"),
    ];
    assert.ok(!codes(def).includes("error:LOOP_WITHOUT_PAUSE"));
  });

  it("caps the number of steps", () => {
    const def = emptyDefinition();
    def.nodes = Array.from({ length: 151 }, (_, i) => node(`n${i}`, "end", {}));
    assert.ok(codes(def).includes("error:TOO_MANY_STEPS"));
  });

  it("warns when free text could go out after the 24-hour window", () => {
    // Message trigger, then a 2-day wait, then free text: risky.
    const def = emptyDefinition();
    def.nodes = [
      node("w", "wait", { mode: "delay", amount: 2, unit: "days" }),
      node("m", "send_message", { text: "Still interested?", media: null }),
      node("t", "send_template", { templateId: "tpl_1", values: {} }),
    ];
    def.edges = [edge("trigger", "next", "w"), edge("w", "next", "m")];
    assert.ok(validateDefinition(def).some((i) => i.code === "WINDOW" && i.nodeId === "m"));
    // A template there is fine.
    def.edges = [edge("trigger", "next", "w"), edge("w", "next", "t")];
    assert.ok(!codes(def).includes("warning:WINDOW"));
    // A tag trigger doesn't know when they last wrote: free text right away is flagged…
    const tag = emptyDefinition({ type: "tag_added", tagId: "t1" });
    tag.nodes = [
      node("m", "send_message", { text: "Hello", media: null }),
      node("c", "condition", { match: "all", rules: [{ kind: "window_open" }] }),
    ];
    tag.edges = [edge("trigger", "next", "m")];
    assert.ok(codes(tag).includes("warning:WINDOW"));
    // …unless a "window is open" condition guards it.
    tag.edges = [edge("trigger", "next", "c"), edge("c", "yes", "m")];
    assert.ok(!codes(tag).includes("warning:WINDOW"));
  });

  it("checks references against the business's tags, fields and templates", () => {
    const def = emptyDefinition();
    def.nodes = [
      node("tag", "add_tag", { tagId: "gone" }),
      node("tpl", "send_template", { templateId: "tpl_1", values: {} }),
    ];
    def.edges = [edge("trigger", "next", "tag"), edge("tag", "next", "tpl")];
    const c = codes(def, {
      tags: new Set(["t1"]),
      templates: new Map([["tpl_1", { name: "order_update", status: "in_review", variables: ["order"] }]]),
    });
    assert.ok(c.includes("error:TAG_MISSING"));
    assert.ok(c.includes("error:TEMPLATE_NOT_READY"));
    assert.ok(c.includes("error:TEMPLATE_VALUES"));
  });

  it("rejects connections from exits a step doesn't have", () => {
    const def = welcome();
    def.edges.push(edge("ask", "opt:zz", "bye"));
    assert.ok(codes(def).includes("error:EDGE_HANDLE"));
  });
});

describe("triggers", () => {
  const msg = (text: string, extra: Partial<{ isFirstMessage: boolean; adId: string }> = {}) => ({
    text,
    isFirstMessage: false,
    ...extra,
  });

  it("matches keywords exactly or as whole words", () => {
    const exact: Trigger = { type: "message_received", mode: "keyword", keywords: ["Price"], match: "exact" };
    const contains: Trigger = { ...exact, match: "contains" };
    assert.equal(triggerMatches(exact, msg("  price ")), true);
    assert.equal(triggerMatches(exact, msg("price list")), false);
    assert.equal(triggerMatches(contains, msg("send the price list")), true);
    assert.equal(triggerMatches(contains, msg("priceless")), false);
    assert.equal(triggerMatches(contains, msg("What's the PRICE?")), true);
  });

  it("starts only the most specific automation", () => {
    const candidates = [
      { id: "any", trigger: { type: "message_received", mode: "any" } as Trigger, updatedAt: "2026-11-15" },
      {
        id: "kw",
        trigger: { type: "message_received", mode: "keyword", keywords: ["hi"] } as Trigger,
        updatedAt: "2026-11-01",
      },
      { id: "ad", trigger: { type: "ad_click", adIds: ["ad9"] } as Trigger, updatedAt: "2026-10-01" },
    ];
    assert.equal(pickAutomation(candidates, msg("hi"))?.id, "kw");
    assert.equal(pickAutomation(candidates, msg("hi", { adId: "ad9" }))?.id, "ad");
    assert.equal(pickAutomation(candidates, msg("hello"))?.id, "any");
    assert.equal(pickAutomation(candidates.slice(1), msg("hello")), null);
  });

  it("explains overlaps between live automations", () => {
    const kw = (k: string): Trigger => ({ type: "message_received", mode: "keyword", keywords: [k] });
    assert.match(triggersOverlap(kw("Hi"), kw("hi ")) ?? "", /keyword/);
    assert.equal(triggersOverlap(kw("hi"), kw("price")), null);
    assert.match(triggersOverlap(kw("hi"), { type: "message_received", mode: "any" }) ?? "", /any message/);
    assert.equal(triggersOverlap({ type: "tag_added", tagId: "a" }, { type: "tag_added", tagId: "b" }), null);
  });
});

describe("variables", () => {
  const scope = {
    contact: { name: "Asha Rao", phone: "919847000000", city: "Kochi" },
    trigger: { text: "hi" },
    answers: { need: "Prices" },
    chat: {},
    business: { name: "Lumen" },
  };
  it("fills paths, first names and fallbacks; never runs code", () => {
    assert.equal(resolveText("Hi {{contact.first_name}} from {{contact.city}}", scope), "Hi Asha from Kochi");
    assert.equal(
      resolveText("{{answers.need}} / {{answers.missing|none}} / {{chat.assignee}}", scope),
      "Prices / none / ",
    );
    assert.equal(resolveText("{{constructor.name}}{{contact.__proto__}}", scope), "");
    assert.deepEqual(variablesUsed("{{ contact.name }} {{answers.x|y}}"), ["contact.name", "answers.x"]);
  });
});

describe("definitions", () => {
  it("migrates (and validates) stored drafts, refusing unknown versions", () => {
    const raw = JSON.parse(JSON.stringify(welcome()));
    delete raw.rules;
    assert.equal(migrateDefinition(raw).rules.reentry, "every_time");
    assert.throws(() => migrateDefinition({ ...raw, schemaVersion: 99 }));
  });
});

describe("starters", () => {
  it("are valid automations with no errors", () => {
    for (const s of starters) {
      const issues = validateDefinition(s.build({ timezone: "Asia/Kolkata" })).filter(
        (i) => i.level === "error",
      );
      assert.deepEqual(issues, [], s.id);
    }
  });
});

describe("wait for a reply on send steps", () => {
  it("needs a No reply exit, saves the reply by name, and reopens the window", () => {
    const def = emptyDefinition({ type: "tag_added", tagId: "t1" });
    def.nodes = [
      node("tpl", "send_template", {
        templateId: "tpl_1",
        values: {},
        replyButtons: [{ index: 0, title: "Yes, book me" }],
        waitForReply: true,
        saveAs: "choice",
        timeoutMinutes: 1440,
      }),
      node("thanks", "send_message", { text: "Great, {{answers.choice}}!", media: null }),
    ];
    def.edges = [
      edge("trigger", "next", "tpl"),
      edge("tpl", "btn:0", "thanks"),
      edge("tpl", "replied", "thanks"),
    ];
    let c = codes(def);
    assert.ok(c.includes("error:NO_REPLY_PATH"));
    assert.ok(!c.includes("error:ANSWER_MISSING"), "the saved reply counts as an answer");
    // After a reply the window is open, so the free text that follows isn't flagged.
    assert.ok(!c.includes("warning:WINDOW"));
    def.nodes.push(node("bye", "end", {}));
    def.edges.push(edge("tpl", "no_reply", "bye"));
    c = codes(def);
    assert.ok(!c.includes("error:NO_REPLY_PATH"));
    assert.deepEqual(
      nodeSpecs.send_template
        .handles(nodeSpecs.send_template.config.parse(def.nodes[0]?.config))
        .map((h) => h.id),
      ["btn:0", "replied", "no_reply", "failed"],
    );
  });

  it("keeps steps saved before the option working as they did", () => {
    const old = nodeSpecs.send_message.config.parse({ text: "Hi", media: null });
    assert.equal(old.waitForReply, false);
    assert.deepEqual(
      nodeSpecs.send_message.handles(old).map((h) => h.id),
      ["next", "failed"],
    );
  });
});

describe("typing pause", () => {
  it("grows with the message, between 1.2 s and 4 s", () => {
    assert.equal(typingPauseMs(""), 1_500);
    assert.equal(typingPauseMs("Hi"), 1_200);
    assert.equal(typingPauseMs("x".repeat(40)), 2_000);
    assert.equal(typingPauseMs("x".repeat(500)), 4_000);
  });
});

describe("older button taps", () => {
  it("reads the step and option back from what a button carries", () => {
    assert.deepEqual(parseStepKey("run_ab12:menu#2"), { runId: "run_ab12", nodeId: "menu" });
    assert.deepEqual(parseStepKey("run_ab12:menu#1:re1"), { runId: "run_ab12", nodeId: "menu" });
    assert.equal(parseStepKey("nonsense"), null);
    assert.equal(optionOfReply(optionReplyId("run_ab12:menu#1", "a3")), "a3");
    assert.equal(optionOfReply("not-ours"), null);
  });

  it("finds where an option leads, and nothing for a step or option that's gone", () => {
    const def = emptyDefinition({ type: "message_received", mode: "any" });
    def.nodes = [
      {
        id: "menu",
        type: "ask_question",
        version: 1,
        config: {
          text: "Pick",
          answer: { type: "buttons", options: [{ id: "a1", title: "Prices" }] },
          saveAs: "choice",
        },
      },
    ];
    assert.deepEqual(tapTarget(def, "menu", "a1"), {
      node: "menu",
      handle: "opt:a1",
      value: "Prices",
      saveAs: "choice",
    });
    assert.equal(tapTarget(def, "menu", "a9"), null);
    assert.equal(tapTarget(def, "gone", "a1"), null);
  });
});

describe("run history", () => {
  it("tells Book, then an earlier Talk button, as it happened", () => {
    const def = emptyDefinition({
      type: "message_received",
      mode: "keyword",
      keywords: ["hi"],
      match: "exact",
    });
    def.nodes = [
      {
        id: "menu",
        type: "ask_question",
        version: 1,
        config: {
          text: "How can we help?",
          answer: {
            type: "buttons",
            options: [
              { id: "a1", title: "Book" },
              { id: "a2", title: "Talk" },
            ],
          },
          saveAs: "choice",
        },
      },
      {
        id: "book",
        type: "send_message",
        version: 1,
        config: { text: "Book here", media: null, waitForReply: true, timeoutMinutes: 5 },
      },
      { id: "human", type: "handoff", version: 1, config: { note: "", userId: null } },
    ];
    def.edges = [
      { id: "1", source: "trigger", sourceHandle: "next", target: "menu" },
      { id: "2", source: "menu", sourceHandle: "opt:a1", target: "book" },
      { id: "3", source: "menu", sourceHandle: "opt:a2", target: "human" },
    ];
    const t = (s: number) => new Date(Date.UTC(2026, 10, 15, 16, 0, s)).toISOString();
    const step = (name: string, kind: string, result: unknown, s: number) => ({
      name,
      kind,
      status: "completed",
      result,
      error: null,
      startedAt: t(s),
      completedAt: t(s),
      wakeAt: null,
    });
    const reply = (text: string) => ({ event: { payload: { text } }, timedOut: false });
    const history = describeRun({
      def,
      input: {
        automationId: "a",
        versionId: "v",
        organizationId: "o",
        branchId: "b",
        channelAccountId: "c",
        conversationId: "cv",
        contactId: "ct",
        trigger: { kind: "message", text: "Hi" },
      },
      steps: [
        step("ask_question:menu#1:typing", "step", true, 1),
        step("ask_question:menu#1:pause", "sleep", null, 2),
        step("ask_question:menu#1:ask", "step", { ok: true, messageId: "m1" }, 3),
        step("ask_question:menu#1:deadline", "step", 0, 3),
        step("ask_question:menu#1:answer0", "wait", reply("Book"), 5),
        step("send_message:book#1", "step", { ok: true, messageId: "m2" }, 6),
        step("send_message:book#1:reply", "wait", reply("Talk"), 9),
        step(
          "send_message:book#1:older_button",
          "step",
          { node: "menu", handle: "opt:a2", value: "Talk", saveAs: "choice" },
          9,
        ),
        step("handoff:human#1", "step", null, 10),
        step("release chat", "step", null, 10),
      ],
      messages: {
        m1: { type: "interactive", text: "Hi Asha! How can we help?" },
        m2: { type: "image", text: "Book here" },
      },
      status: "completed",
      error: null,
      createdAt: t(0),
      finishedAt: t(10),
    });
    assert.deepEqual(
      history.map((h) => h.text),
      [
        "Started: Message “Hi”",
        "Asked “Hi Asha! How can we help?”",
        "Replied “Book”",
        "Sent a photo: “Book here”",
        "Tapped “Talk” on an earlier message → Hand to a human",
        "Handed the chat to a person",
        "Finished",
      ],
    );
    assert.deepEqual(
      history.filter((h) => h.saved).map((h) => h.saved?.value),
      ["Book", "Talk"],
    );
  });
});
