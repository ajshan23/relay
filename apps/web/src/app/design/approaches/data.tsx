import type { ReactNode } from "react";
import {
  WireAgentFirst,
  WireBoard,
  WireCanvas,
  WireChatApp,
  WireCommand,
  WireConsole,
  WireConversational,
  WireDualMode,
  WirePhone,
  WireToday,
  WireTriage,
  WireWorkspace,
} from "./wires";

export type Fit = "Strong" | "Partial" | "Weak";

export type Approach = {
  id: string;
  name: string;
  idea: string;
  firstScreen: string;
  wire: ReactNode;
  examples: { name: string; url: string; note: string }[];
  strengths: string[];
  weaknesses: string[];
  fit: { owner: Fit; team: Fit; summary: string };
};

/* Source: research/05-app-structure-approaches.md (researched 2026-11-12). */
export const approaches: Approach[] = [
  {
    id: "console",
    name: "Operator console",
    idea: "Three panels side by side: a list of chats, the open chat, and the customer's details.",
    firstScreen: "The inbox, with the newest chat selected.",
    wire: <WireConsole />,
    examples: [
      {
        name: "Intercom",
        url: "https://www.intercom.com/helpdesk/inbox",
        note: "the reference three-pane helpdesk",
      },
      {
        name: "Front",
        url: "https://front.com/blog/the-new-front-inbox",
        note: "shared inbox that borrows from email",
      },
      {
        name: "Chatwoot",
        url: "https://www.chatwoot.com/blog/a-clearer-chatlist-and-a-faster-help-center",
        note: "the open-source version of the same layout",
      },
    ],
    strengths: [
      "Trained staff reply fast; everything is one click away",
      "Familiar to anyone who has used a helpdesk",
    ],
    weaknesses: [
      "An owner sees a queue of threads, not whether the business is fine",
      "Bots, flows and campaigns end up looking like admin screens",
      "Gets heavy as features are added; reviewers report a learning curve",
    ],
    fit: {
      owner: "Weak",
      team: "Strong",
      summary: "This is what you rejected first. It still wins for people replying all day.",
    },
  },
  {
    id: "agent-first",
    name: "Agent-first workspace",
    idea: "The AI agent is the centre. Navigation follows its life: teach it, try it, put it live, improve it.",
    firstScreen: "Your agent, what it handled, and what it needs from you.",
    wire: <WireAgentFirst />,
    examples: [
      {
        name: "Intercom Fin",
        url: "https://www.intercom.com/help/en/articles/7120684",
        note: "train, test, deploy, analyse",
      },
      {
        name: "Sierra",
        url: "https://sierra.ai/product/agent-studio",
        note: "an agent studio with simulations",
      },
      {
        name: "Decagon",
        url: "https://decagon.ai/product/aop",
        note: "procedures written in plain language",
      },
      {
        name: "Cloodot",
        url: "https://chats.cloodot.com",
        note: "the named-persona version, seen in your trial account",
      },
    ],
    strengths: [
      "Matches what owners want to know: is it handling things, and what does it need from me",
      "Test and improve loop lets non-engineers fix the agent without flowcharts",
    ],
    weaknesses: [
      "The face, name and ask box are now a recognisable template, so copying it looks derivative",
      "Poor for front-desk staff, whose job is replying, not supervising",
      "Complex cases still need code, by the vendors' own admission",
    ],
    fit: {
      owner: "Strong",
      team: "Weak",
      summary: "This is what the second mock copied. Good idea, but no longer distinctive on its own.",
    },
  },
  {
    id: "chat-app",
    name: "Messenger-native",
    idea: "It looks and behaves like a messaging app. One list of chats, the conversation, and little else.",
    firstScreen: "Your chats, exactly like opening WhatsApp.",
    wire: <WireChatApp />,
    examples: [
      {
        name: "WhatsApp Business",
        url: "https://whatsappbusiness.com/products/business-app/",
        note: "what owners already use",
      },
      {
        name: "Telegram Business",
        url: "https://telegram.org/blog/telegram-business",
        note: "business tools inside the chat app",
      },
      { name: "Beeper", url: "https://www.beeper.com/", note: "every network in one chat list" },
    ],
    strengths: [
      "Nothing to learn for owners and staff in WhatsApp-heavy markets",
      "Calm; nobody would call it an admin panel",
    ],
    weaknesses: [
      "No natural place for assignment, branches or who owns a chat",
      "Agent setup, automation and campaigns get hidden behind menus",
    ],
    fit: {
      owner: "Strong",
      team: "Partial",
      summary: "Great feel for the conversation itself; too thin to hold the rest of the product.",
    },
  },
  {
    id: "command",
    name: "Keyboard-first minimal",
    idea: "One calm, dense list and a command bar. More a style than a structure of its own.",
    firstScreen: "A single list, with a command palette one keystroke away.",
    wire: <WireCommand />,
    examples: [
      {
        name: "Linear",
        url: "https://linear.app/now/how-we-redesigned-the-linear-ui",
        note: "the model everyone copies",
      },
      { name: "Superhuman", url: "https://superhuman.com/", note: "email driven entirely from the keyboard" },
      {
        name: "Plain",
        url: "https://plain.support.site/article/what-is-plain",
        note: "support tool for technical teams",
      },
    ],
    strengths: ["Power users love it and need little onboarding", "Dense without feeling busy"],
    weaknesses: [
      "Keyboard habits don't carry to phones, where owners often are",
      "Search-first suits people who know what they want, not owners scanning for problems",
      "Reads as intimidating to non-technical users",
    ],
    fit: {
      owner: "Weak",
      team: "Strong",
      summary: "Worth borrowing the command bar; wrong as the whole product.",
    },
  },
  {
    id: "triage",
    name: "Triage queue",
    idea: "The first screen holds only things that need a decision. You work it down to empty.",
    firstScreen: "A short stack of decisions, each with fixed actions like approve, edit or reject.",
    wire: <WireTriage />,
    examples: [
      {
        name: "Linear Triage",
        url: "https://linear.app/docs/triage",
        note: "accept, decline or snooze each item",
      },
      { name: "HEY", url: "https://www.hey.com/features/", note: "screen new senders before they reach you" },
      {
        name: "Zapier Agents",
        url: "https://zapier.com/blog/zapier-agents-pods-dashboards",
        note: "agent work waiting for human review",
      },
    ],
    strengths: [
      "Best fit for 'the AI does most of it, a person approves the rest'",
      "A clear finish line: empty means nothing needs you",
      "Fast on a phone",
    ],
    weaknesses: [
      "Hides the bigger picture; finding a customer or a trend needs another screen",
      "A plain 'needs you' list is now common, so it isn't distinctive alone",
    ],
    fit: {
      owner: "Strong",
      team: "Partial",
      summary: "A strong top block for an owner's home, not a whole app.",
    },
  },
  {
    id: "today",
    name: "Today briefing",
    idea: "A home page that tells you what happened and what to do next, in ranked plain sentences.",
    firstScreen: "A personal summary of today with the next actions on top.",
    wire: <WireToday />,
    examples: [
      {
        name: "Shopify",
        url: "https://www.shopify.com/news/winter-26-edition-renaissance",
        note: "home feed plus the Sidekick assistant",
      },
      {
        name: "Square",
        url: "https://squareup.com/us/en/press/square-releases-ai",
        note: "an AI briefing for shop owners",
      },
      {
        name: "Stripe",
        url: "https://support.stripe.com/questions/customize-your-dashboard-home-page-charts-for-better-business-insights",
        note: "a home you arrange yourself",
      },
    ],
    strengths: [
      "Best for owners who check in a few times a day",
      "Proven with small businesses, and doesn't look like a helpdesk",
    ],
    weaknesses: [
      "Not a place to work; staff replying all day pass straight through it",
      "Turns into a cluttered dashboard if every team adds a widget",
    ],
    fit: { owner: "Strong", team: "Weak", summary: "The strongest owner home in the research." },
  },
  {
    id: "canvas",
    name: "Canvas-first builder",
    idea: "The builder is the product. You draw how conversations should go and everything hangs off that.",
    firstScreen: "Your flows, opening straight into a canvas.",
    wire: <WireCanvas />,
    examples: [
      {
        name: "n8n",
        url: "https://docs.n8n.io/advanced-ai/ai-workflow-builder",
        note: "canvas with prompt-to-build",
      },
      {
        name: "Zapier Canvas",
        url: "https://zapier.com/blog/zapier-canvas-guide/",
        note: "diagram first, automation second",
      },
      { name: "Voiceflow", url: "https://www.voiceflow.com/", note: "conversation design on a canvas" },
    ],
    strengths: ["The logic is visible", "Best surface for debugging a branching flow"],
    weaknesses: [
      "As the home of the app it says 'tool for builders'; owners don't return after setup",
      "Non-developers struggle with what each step receives and sends",
      "Plain-language procedures make the canvas optional for many cases",
    ],
    fit: {
      owner: "Weak",
      team: "Weak",
      summary: "Keep it as one area of the product. FlowFlex today is close to this.",
    },
  },
  {
    id: "conversational",
    name: "Conversational shell",
    idea: "The whole app is one chat with an assistant that builds and runs things for you.",
    firstScreen: "An empty chat asking what you want to do.",
    wire: <WireConversational />,
    examples: [
      { name: "v0", url: "https://v0.app/", note: "describe it, get it built" },
      { name: "Manus", url: "https://manus.im/", note: "an agent that carries out tasks" },
      {
        name: "Agentforce Builder",
        url: "https://www.salesforce.com/agentforce/agent-builder/",
        note: "build an agent by conversation",
      },
    ],
    strengths: [
      "Lowest barrier to start: describe your business, get a working agent",
      "Excellent for setup and one-off requests",
    ],
    weaknesses: [
      "A blank box hides what the product can do",
      "Slow for repeated work, and there's nowhere to see 200 conversations at once",
    ],
    fit: {
      owner: "Partial",
      team: "Weak",
      summary: "Good as an ask box inside another structure, not as the product.",
    },
  },
  {
    id: "board",
    name: "Board and pipeline",
    idea: "Customers are cards moving through stages. The chat lives inside the card.",
    firstScreen: "Columns such as new enquiry, talking, booked, visited.",
    wire: <WireBoard />,
    examples: [
      { name: "Kommo", url: "https://www.kommo.com/", note: "messaging-first sales pipeline" },
      {
        name: "Attio",
        url: "https://attio.com/help/reference/managing-your-data/views",
        note: "the same records as table or board",
      },
      {
        name: "Trengo Boards",
        url: "https://trengo.com/blog/trengos-2025-year-in-review",
        note: "boards added to a team inbox",
      },
    ],
    strengths: [
      "Owners understand it instantly",
      "Suits businesses that turn enquiries into bookings: clinics, salons, property",
    ],
    weaknesses: ["Shows where things are, not what to do next", "Poor for high volumes of support replies"],
    fit: {
      owner: "Partial",
      team: "Partial",
      summary: "A good second view of contacts, not a first screen.",
    },
  },
  {
    id: "workspace",
    name: "Workspace and pages",
    idea: "Everything is a page you write. You teach the agent by writing how your business works.",
    firstScreen: "A page tree, like a notebook.",
    wire: <WireWorkspace />,
    examples: [
      {
        name: "Notion",
        url: "https://www.notion.com/releases/2025-09-18",
        note: "agents working inside your pages",
      },
      { name: "Notion Mail", url: "https://www.notion.com/product/mail", note: "an inbox built from views" },
      {
        name: "Decagon procedures",
        url: "https://decagon.ai/product/aop",
        note: "agent behaviour as written documents",
      },
    ],
    strengths: ["Natural for owners who already keep written procedures", "Very flexible"],
    weaknesses: ["Starts blank, and organising it becomes the owner's job", "Weak for live queues of chats"],
    fit: {
      owner: "Partial",
      team: "Weak",
      summary: "The right feel for teaching the agent, not for the whole app.",
    },
  },
  {
    id: "phone",
    name: "Phone-first cards",
    idea: "Designed for the phone first: bottom tabs and a stack of cards. The web app is the same thing, wider.",
    firstScreen: "A card stack with the most urgent item on top.",
    wire: <WirePhone />,
    examples: [
      {
        name: "WhatsApp Business",
        url: "https://whatsappbusiness.com/products/business-app/",
        note: "phone is the main device",
      },
      {
        name: "Square",
        url: "https://squareup.com/us/en/press/square-releases-ai",
        note: "run the shop from the app",
      },
      {
        name: "Shopify Sidekick",
        url: "https://www.shopify.com/sidekick",
        note: "assistant-led mobile home",
      },
    ],
    strengths: ["Owners really do check on their phones", "Forces ruthless prioritising"],
    weaknesses: [
      "Setup work such as teaching the agent is painful on a phone",
      "Team features are hard to fit",
    ],
    fit: {
      owner: "Strong",
      team: "Weak",
      summary: "A constraint to design within more than a structure to choose.",
    },
  },
  {
    id: "dual",
    name: "Different home per role",
    idea: "One set of conversations and customers, with a different home and menu for owner and team.",
    firstScreen: "For the owner, a short briefing. For the team, the chat queue.",
    wire: <WireDualMode />,
    examples: [
      {
        name: "Intercom",
        url: "https://www.intercom.com/helpdesk/inbox",
        note: "inbox for staff, Fin workspace for managers",
      },
      {
        name: "Zendesk",
        url: "https://www.zendesk.com/service/agent-workspace/",
        note: "agent workspace separate from admin",
      },
      {
        name: "Square",
        url: "https://squareup.com/us/en/press/square-releases-ai",
        note: "owner dashboard versus point of sale",
      },
    ],
    strengths: [
      "Each person gets a structure that fits their job",
      "It's how the products that serve both audiences do it",
    ],
    weaknesses: ["More to design and keep consistent", "Owners who wander into the team view can feel lost"],
    fit: {
      owner: "Strong",
      team: "Strong",
      summary: "The only option that scores well for both. It is a way to combine the others.",
    },
  },
];

export const recommendation = {
  title: "What the research points to",
  summary:
    "No single first screen serves an owner who checks in and a team that replies all day. The products that serve both give each role its own home over one shared set of conversations.",
  parts: [
    {
      who: "Owner",
      what: "A Today briefing whose top block is a short triage queue, with an ask box for one-off requests. Built for the phone first.",
      from: "Today briefing + Triage queue + Phone-first",
    },
    {
      who: "Team",
      what: "A slim two-pane chat screen that feels like a messaging app, with customer details in a slide-over and the AI agent shown as a teammate.",
      from: "Messenger-native + Operator console",
    },
    {
      who: "Agent area",
      what: "Four plain steps: Teach, Try, Go live, Improve. Draft and live versions, and fixes suggested from chats the agent couldn't handle.",
      from: "Agent-first workspace + Workspace and pages",
    },
  ],
  note: "Each piece has precedent. The research found no small-business WhatsApp product that combines them, and branches fit naturally as a filter across all three.",
};
