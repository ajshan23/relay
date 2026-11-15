import {
  type AutomationDefinition,
  type AutomationEdge,
  type AutomationNode,
  emptyDefinition,
} from "./definition";

/*
 * Ready-made automations offered when creating one. Each is a complete, valid definition the business
 * then edits (texts, options, hours). Keep them short: they're examples to adapt, not finished bots.
 */

export type Starter = {
  id: string;
  name: string;
  description: string;
  build: (opts: { timezone: string }) => AutomationDefinition;
};

const n = (id: string, type: string, config: Record<string, unknown>): AutomationNode => ({
  id,
  type,
  version: 1,
  config,
});
let edgeSeq = 0;
const e = (source: string, sourceHandle: string, target: string): AutomationEdge => ({
  id: `e${++edgeSeq}`,
  source,
  sourceHandle,
  target,
});
const ask = (
  text: string,
  saveAs: string,
  options: string[] | null,
  extra: Partial<{ timeoutMinutes: number; format: string; retryText: string }> = {},
) => ({
  text,
  answer: options
    ? { type: "buttons", options: options.map((title, i) => ({ id: `a${i + 1}`, title })) }
    : { type: "text", format: extra.format ?? "any" },
  saveAs,
  retries: 2,
  retryText: extra.retryText ?? (options ? "Please pick one of the options." : "Sorry, I didn't get that."),
  timeoutMinutes: extra.timeoutMinutes ?? 1440,
});

export const starters: Starter[] = [
  {
    id: "welcome_menu",
    name: "Welcome menu",
    description: "Greets people who say hi and offers a menu: prices, booking or a person.",
    build: () => {
      const def = emptyDefinition({
        type: "message_received",
        mode: "keyword",
        keywords: ["hi", "hello", "menu"],
        match: "exact",
      });
      def.nodes = [
        n(
          "menu",
          "ask_question",
          ask("Hi {{contact.first_name|there}}! 👋 How can we help?", "choice", [
            "See prices",
            "Book a visit",
            "Talk to someone",
          ]),
        ),
        n("prices", "send_message", { text: "Here are our prices: …", media: null }),
        n("book", "send_message", { text: "You can book here: …", media: null }),
        n("human", "handoff", { userId: null, note: "Asked for a person from the welcome menu." }),
        n("end", "end", {}),
      ];
      def.edges = [
        e("trigger", "next", "menu"),
        e("menu", "opt:a1", "prices"),
        e("menu", "opt:a2", "book"),
        e("menu", "opt:a3", "human"),
        e("menu", "invalid", "human"),
        e("menu", "no_reply", "end"),
      ];
      return def;
    },
  },
  {
    id: "ad_lead",
    name: "Ad lead qualifier",
    description: "People who message from a click-to-WhatsApp ad: what they want and when to call.",
    build: () => {
      const def = emptyDefinition({ type: "ad_click" });
      def.nodes = [
        n(
          "interest",
          "ask_question",
          ask("Thanks for your interest! What are you looking for?", "interest", [
            "Product A",
            "Product B",
            "Something else",
          ]),
        ),
        n(
          "when",
          "ask_question",
          ask("When is a good time for a quick call?", "call_time", ["Morning", "Afternoon", "Evening"]),
        ),
        n("note", "add_note", {
          text: "Ad lead: wants {{answers.interest}}, call in the {{answers.call_time}}.",
        }),
        n("thanks", "send_message", {
          text: "Perfect, we'll call you in the {{answers.call_time}}. 🙌",
          media: null,
        }),
        n("human", "handoff", { userId: null, note: "" }),
        n("end", "end", {}),
      ];
      def.edges = [
        e("trigger", "next", "interest"),
        ...["opt:a1", "opt:a2", "opt:a3"].map((h) => e("interest", h, "when")),
        e("interest", "invalid", "human"),
        e("interest", "no_reply", "end"),
        ...["opt:a1", "opt:a2", "opt:a3"].map((h) => e("when", h, "note")),
        e("when", "invalid", "note"),
        e("when", "no_reply", "note"),
        e("note", "next", "thanks"),
        e("thanks", "next", "human"),
      ];
      return def;
    },
  },
  {
    id: "after_hours",
    name: "After-hours reply",
    description: "Outside business hours, tells people when you'll be back.",
    build: ({ timezone }) => {
      const def = emptyDefinition({ type: "message_received", mode: "any" });
      def.rules = { ...def.rules, reentry: "cooldown", cooldownHours: 12 };
      def.nodes = [
        n("open", "condition", {
          match: "all",
          rules: [{ kind: "business_hours", days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00", timezone }],
        }),
        n("closed", "send_message", {
          text: "Thanks for your message! We're closed right now and will reply from 9:00 on the next working day.",
          media: null,
        }),
        n("end", "end", {}),
      ];
      def.edges = [e("trigger", "next", "open"), e("open", "yes", "end"), e("open", "no", "closed")];
      return def;
    },
  },
  {
    id: "feedback",
    name: "Feedback ask",
    description: "Run it from a chat after helping someone: a rating, and what to improve.",
    build: () => {
      const def = emptyDefinition({ type: "run_from_chat" });
      def.rules = { ...def.rules, skipIfAssigned: false, stopOnAgentReply: false };
      def.nodes = [
        n(
          "rate",
          "ask_question",
          ask("How did we do today?", "rating", ["😊 Great", "😐 Okay", "🙁 Not good"], {
            timeoutMinutes: 720,
          }),
        ),
        n("thanks", "send_message", { text: "Thank you, that made our day! 🙏", media: null }),
        n(
          "why",
          "ask_question",
          ask("Sorry to hear that. What could we do better?", "improve", null, { timeoutMinutes: 720 }),
        ),
        n("note", "add_note", { text: "Feedback: {{answers.rating}}. {{answers.improve}}" }),
        n("end", "end", {}),
      ];
      def.edges = [
        e("trigger", "next", "rate"),
        e("rate", "opt:a1", "thanks"),
        e("rate", "opt:a2", "why"),
        e("rate", "opt:a3", "why"),
        e("rate", "invalid", "end"),
        e("rate", "no_reply", "end"),
        e("why", "next", "note"),
        e("why", "invalid", "note"),
        e("why", "no_reply", "note"),
        e("thanks", "next", "end"),
      ];
      return def;
    },
  },
];
