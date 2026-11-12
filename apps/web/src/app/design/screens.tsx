import {
  ArrowUp,
  BookOpen,
  CalendarCheck,
  Camera,
  CircleAlert,
  CornerDownRight,
  Globe,
  HandHelping,
  MessageCircle,
  Paperclip,
  Play,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { AgentFace, Avatar, type NavGroup, type ScreenId, Shell } from "./shell";

type ScreenProps = { onNavigate: (screen: ScreenId) => void };

/* ---------------------------------- Home ---------------------------------- */

const needsYou = [
  {
    icon: <HandHelping size={18} />,
    title: "Daniel is asking for a refund",
    detail: "Mira handed this chat to the team 4 minutes ago.",
    action: "Open chat",
  },
  {
    icon: <BookOpen size={18} />,
    title: "Mira couldn't answer “Do you take Aetna insurance?”",
    detail: "Customers asked this 3 times this week.",
    action: "Teach Mira",
  },
  {
    icon: <CircleAlert size={18} />,
    title: "WhatsApp rejected your appointment reminder",
    detail: "The message reads like marketing. A small rewording fixes it.",
    action: "Fix message",
  },
];

const suggestions = [
  "What did customers ask most this week?",
  "Offer 10% off cleanings until Sunday",
  "Why were chats handed to the team?",
];

export function HomeScreen({ onNavigate }: ScreenProps) {
  return (
    <Shell screen="home" onNavigate={onNavigate} title="Home">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-10 px-5 py-12 sm:py-16">
        <section className="flex flex-col items-center gap-4 text-center">
          <AgentFace size={64} />
          <div className="flex flex-col gap-2">
            <h1 className="d-head text-3xl sm:text-4xl">Good morning, Priya</h1>
            <p className="d-muted text-base">Mira answered 42 chats at Marina today. 3 things need you.</p>
          </div>
        </section>

        <section aria-label="Ask Mira" className="flex flex-col gap-3">
          <div
            className="d-card flex flex-col gap-3 p-3"
            style={{ borderColor: "var(--primary)", borderWidth: 1.5 }}
          >
            <label>
              <span className="sr-only">Message Mira</span>
              <textarea
                rows={2}
                placeholder="Ask anything, or tell Mira what to change"
                className="w-full resize-none bg-transparent px-1 pt-1 text-base outline-none"
              />
            </label>
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Attach a file"
                className="d-btn-quiet inline-flex size-9 items-center justify-center"
              >
                <Paperclip size={16} />
              </button>
              <button
                type="button"
                aria-label="Send"
                className="d-btn inline-flex size-9 items-center justify-center"
              >
                <ArrowUp size={17} strokeWidth={2.4} />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="d-line d-muted d-row rounded-full border px-3 py-1.5 text-sm"
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="d-card overflow-hidden">
          <h2 className="d-line border-b px-4 py-3 text-sm font-semibold">Needs you</h2>
          <ul>
            {needsYou.map((item) => (
              <li
                key={item.title}
                className="d-line flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0"
              >
                <span
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: "var(--ai-bg)", color: "var(--ai-ink)" }}
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.title}</span>
                  <span className="d-muted block text-sm">{item.detail}</span>
                </span>
                <button type="button" className="d-btn-quiet h-9 shrink-0 px-3 text-sm">
                  {item.action}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Today at Marina" className="grid gap-3 sm:grid-cols-3">
          {[
            ["42", "chats answered by Mira"],
            ["9", "appointments booked"],
            ["5", "chats handled by your team"],
          ].map(([value, label]) => (
            <div key={label} className="d-card flex items-baseline gap-2 px-4 py-3 sm:flex-col sm:gap-0.5">
              <span className="d-head text-2xl">{value}</span>
              <span className="d-muted text-sm">{label}</span>
            </div>
          ))}
        </section>
      </div>
    </Shell>
  );
}

/* ---------------------------------- Inbox --------------------------------- */

const inboxGroups: NavGroup[] = [
  {
    title: "Conversations",
    items: [
      { label: "Needs you", count: 2 },
      { label: "Mira is handling", count: 3, current: true },
      { label: "With your team", count: 1 },
      { label: "Closed" },
    ],
  },
  {
    title: "Channels",
    items: [{ label: "WhatsApp" }, { label: "Instagram" }, { label: "Website chat" }],
  },
];

type Channel = "whatsapp" | "instagram" | "web";
const channelIcon: Record<Channel, ReactNode> = {
  whatsapp: <MessageCircle size={12} />,
  instagram: <Camera size={12} />,
  web: <Globe size={12} />,
};
const channelName: Record<Channel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  web: "Website chat",
};

const chats: { name: string; preview: string; time: string; channel: Channel; current?: boolean }[] = [
  {
    name: "Asha Menon",
    preview: "Saturday 11 works. Do I need to bring my old reports?",
    time: "2 min",
    channel: "whatsapp",
    current: true,
  },
  { name: "Website visitor", preview: "Do you open on Sundays?", time: "14 min", channel: "web" },
  {
    name: "Rahul Verma",
    preview: "Can I move my appointment to Monday?",
    time: "31 min",
    channel: "instagram",
  },
];

function Bubble({ from, children }: { from: "customer" | "mira"; children: ReactNode }) {
  const mine = from === "mira";
  return (
    <div className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : ""}`}>
      {mine ? <AgentFace size={24} /> : <Avatar name="Asha Menon" size={24} />}
      <p
        className="max-w-[75%] px-3.5 py-2.5 text-sm leading-relaxed"
        style={{
          borderRadius: 14,
          background: mine ? "var(--ai-bg)" : "var(--surface-2)",
          color: mine ? "var(--ai-ink)" : "var(--ink)",
        }}
      >
        {children}
      </p>
    </div>
  );
}

export function InboxScreen({ onNavigate }: ScreenProps) {
  return (
    <Shell screen="inbox" onNavigate={onNavigate} title="Inbox" groups={inboxGroups}>
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Mira is handling"
          className="d-line flex w-full shrink-0 flex-col border-r md:w-80"
        >
          <h1 className="px-4 pt-4 pb-2 text-sm font-semibold">Mira is handling</h1>
          <ul className="flex flex-col gap-0.5 px-2">
            {chats.map((chat) => (
              <li key={chat.name}>
                <button
                  type="button"
                  aria-current={chat.current ? "page" : undefined}
                  className="d-nav flex w-full items-start gap-3 rounded-[10px] p-2.5 text-left"
                >
                  <Avatar name={chat.name} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{chat.name}</span>
                      <span className="d-muted shrink-0 text-xs">{chat.time}</span>
                    </span>
                    <span className="d-muted block truncate text-sm">{chat.preview}</span>
                    <span className="d-muted mt-1 inline-flex items-center gap-1 text-xs">
                      {channelIcon[chat.channel]} {channelName[chat.channel]}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Chat with Asha Menon" className="hidden min-w-0 flex-1 flex-col md:flex">
          <header className="d-line flex items-center gap-3 border-b px-5 py-3">
            <Avatar name="Asha Menon" size={36} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Asha Menon</h2>
              <p className="d-muted truncate text-xs">
                WhatsApp, returning patient, next visit Saturday 11:00
              </p>
            </div>
            <button type="button" className="d-btn ml-auto h-9 shrink-0 px-3.5 text-sm">
              Take over from Mira
            </button>
          </header>

          <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-5 py-6">
            <Bubble from="customer">Hi, can I book a cleaning for this Saturday?</Bubble>
            <Bubble from="mira">
              Of course, Asha. Marina has 11:00 and 3:30 free on Saturday. Which suits you?
            </Bubble>
            <Bubble from="customer">Saturday 11 works. Do I need to bring my old reports?</Bubble>
            <p className="d-muted flex items-center justify-center gap-1.5 text-xs">
              <CalendarCheck size={13} /> Mira booked Saturday 11:00 with Dr. Rao
            </p>
            <Bubble from="mira">
              You're booked for Saturday at 11:00 with Dr. Rao. Please bring any X-rays from the last two
              years.
            </Bubble>
          </div>

          <footer className="mx-auto w-full max-w-2xl px-5 pb-5">
            <div className="d-card flex items-center gap-3 px-4 py-3">
              <AgentFace size={24} />
              <p className="d-muted flex-1 text-sm">
                Mira is replying in this chat. You can reply freely for 21 more hours.
              </p>
              <button type="button" className="d-btn-quiet h-9 px-3 text-sm">
                Add a note
              </button>
            </div>
          </footer>
        </section>
      </div>
    </Shell>
  );
}

/* ---------------------------------- Agent --------------------------------- */

const agentGroups: NavGroup[] = [
  { title: "Agents", items: [{ label: "Mira", current: true }, { label: "New agent" }] },
  { title: "What Mira knows", items: [{ label: "Knowledge" }, { label: "Questions to answer", count: 3 }] },
  { title: "What Mira can do", items: [{ label: "Skills" }, { label: "Workers" }] },
];

const tabs = ["Personality", "Instructions", "Procedures", "Channels"];

const procedures = [
  {
    name: "Book an appointment",
    when: "When a customer wants to come in",
    steps: [
      "Ask which service they need",
      "Offer the two nearest free slots at this branch",
      "Book the slot and confirm the time",
      "Send a reminder the day before",
    ],
    open: true,
  },
  {
    name: "Refund request",
    when: "When a customer asks for money back",
    steps: ["Ask for the visit date", "Hand the chat to the Marina front desk"],
  },
  {
    name: "Price question",
    when: "When a customer asks what something costs",
    steps: ["Answer from the price list", "Offer to book"],
  },
];

export function AgentScreen({ onNavigate }: ScreenProps) {
  return (
    <Shell
      screen="agent"
      onNavigate={onNavigate}
      groups={agentGroups}
      title={
        <>
          <AgentFace size={26} />
          <span>Mira</span>
          <span className="d-muted inline-flex items-center gap-1.5 text-xs font-medium">
            <span className="size-1.5 rounded-full" style={{ background: "var(--good)" }} />
            Live, version 3
          </span>
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="d-btn-quiet hidden h-9 px-3 text-sm sm:inline-flex sm:items-center"
          >
            Save draft
          </button>
          <button type="button" className="d-btn h-9 px-3.5 text-sm">
            Save and go live
          </button>
        </>
      }
    >
      <div className="grid min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6 px-5 py-6 sm:px-8">
          <div role="tablist" aria-label="Agent settings" className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={tab === "Procedures"}
                className="d-muted shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium"
                style={
                  tab === "Procedures" ? { background: "var(--surface-2)", color: "var(--ink)" } : undefined
                }
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="flex max-w-2xl flex-col gap-2">
            <h1 className="d-head text-2xl">Procedures</h1>
            <p className="d-muted text-sm leading-relaxed">
              Write the steps Mira should follow, the way you'd explain them to a new team member. Mira
              follows them in order and hands over when a step says so.
            </p>
          </div>

          <ul className="flex max-w-2xl flex-col gap-3">
            {procedures.map((p) => (
              <li key={p.name} className="d-card">
                <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{p.name}</h2>
                    <p className="d-muted text-sm">{p.when}</p>
                  </div>
                  <span className="d-muted shrink-0 text-xs">{p.steps.length} steps</span>
                </div>
                {p.open ? (
                  <ol className="d-line flex flex-col gap-2.5 border-t px-4 py-4">
                    {p.steps.map((step, index) => (
                      <li key={step} className="flex items-start gap-3 text-sm">
                        <span
                          className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                          style={{ background: "var(--surface-2)" }}
                        >
                          {index + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                    <li>
                      <button type="button" className="d-muted inline-flex items-center gap-2 pl-8 text-sm">
                        <Plus size={14} /> Add a step
                      </button>
                    </li>
                  </ol>
                ) : null}
              </li>
            ))}
            <li>
              <button
                type="button"
                className="d-line d-muted d-row flex w-full items-center justify-center gap-2 rounded-xl border border-dashed py-3 text-sm"
              >
                <Plus size={15} /> New procedure
              </button>
            </li>
          </ul>
        </div>

        <aside aria-label="Try Mira" className="d-line hidden flex-col border-l xl:flex">
          <div className="d-line flex items-center justify-between border-b px-4 py-3">
            <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
              <Play size={14} /> Try your draft
            </h2>
            <span className="d-muted text-xs">as a WhatsApp customer</span>
          </div>
          <div className="flex flex-1 flex-col gap-3 px-4 py-4 text-sm">
            <p
              className="max-w-[85%] self-end px-3.5 py-2.5"
              style={{ borderRadius: 14, background: "var(--you-bg)", color: "var(--you-ink)" }}
            >
              I want a cleaning this weekend
            </p>
            <p
              className="max-w-[85%] self-start px-3.5 py-2.5"
              style={{ borderRadius: 14, background: "var(--ai-bg)", color: "var(--ai-ink)" }}
            >
              Happy to help. Saturday has 11:00 and 3:30 free at Marina. Which would you like?
            </p>
            <p className="d-muted inline-flex items-center gap-1.5 text-xs">
              <CornerDownRight size={13} /> Followed "Book an appointment", step 2
            </p>
          </div>
          <div className="p-3">
            <label className="d-card flex items-center gap-2 px-3 py-2">
              <span className="sr-only">Test message</span>
              <input
                placeholder="Write as a customer"
                className="h-8 w-full bg-transparent text-sm outline-none"
              />
              <span className="d-btn inline-flex size-8 shrink-0 items-center justify-center">
                <ArrowUp size={15} strokeWidth={2.4} />
              </span>
            </label>
          </div>
        </aside>
      </div>
    </Shell>
  );
}
