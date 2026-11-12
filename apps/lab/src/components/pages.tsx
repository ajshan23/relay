"use client";

import {
  Check,
  ChevronRight,
  CircleAlert,
  CornerDownRight,
  FileText,
  Globe,
  HelpCircle,
  Lightbulb,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  PlusCircle,
  Search,
  Send,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Bubble,
  ChannelTag,
  LiveDot,
  Mira,
  PageHeader,
  Person,
  StageTag,
  StatTiles,
  Tag,
  WhoTag,
} from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { campaigns, customers, draftReply, handovers, week } from "@/lib/data";
import { useLab } from "@/lib/store";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- Inbox */

function ChatList({ wide }: { wide?: boolean }) {
  const { chats, chatId, openChat, branch } = useLab();
  const count = (who: string) => chats.filter((c) => c.who === who).length;
  const filters: [string, number][] = [
    ["All", chats.length],
    ["Needs a person", count("Needs a person")],
    ["Mira", count("Mira")],
    ["Mine", count("Priya")],
  ];
  return (
    <section
      aria-label="Chats"
      className={cn("flex w-full shrink-0 flex-col border-r bg-card", wide ? "md:w-[400px]" : "md:w-[330px]")}
    >
      <div className="flex items-center justify-between px-4 pt-5 pb-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Inbox</h1>
        <span className="text-sm text-muted-foreground">{branch}</span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto px-4 pb-3 text-sm">
        {filters.map(([label, n], i) => (
          <button
            key={label}
            type="button"
            className={cn(
              "shrink-0 rounded-full px-3 py-1 font-medium",
              i === 0 ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
            )}
          >
            {label} <span className="opacity-70">{n}</span>
          </button>
        ))}
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-2">
        {chats.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-current={c.id === chatId}
            onClick={() => openChat(c.id)}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg p-2.5 text-left",
              c.id === chatId ? "bg-accent" : "hover:bg-muted",
            )}
          >
            <Person name={c.name} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold">{c.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.time}</span>
              </span>
              <span className={cn("block truncate text-sm", c.unread ? "" : "text-muted-foreground")}>
                {c.preview}
              </span>
              <span className="mt-1.5 flex items-center justify-between">
                <ChannelTag channel={c.channel} />
                <span className="flex items-center gap-1.5">
                  <WhoTag who={c.who} />
                  {c.unread ? (
                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                      {c.unread}
                    </span>
                  ) : null}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CustomerFacts({ name, channel }: { name: string; channel: string }) {
  const rows = [
    ["Branch", "Marina"],
    ["Reached on", channel],
    ["Last visit", "Sat 9 Nov"],
    ["Spent", "AED 1,350"],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <Person name={name} className="size-12" />
        <div>
          <p className="font-semibold">{name}</p>
          <p className="text-sm text-muted-foreground">Customer since March</p>
        </div>
      </div>
      <dl className="flex flex-col divide-y text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 py-2.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="mb-1.5 text-sm font-semibold">Notes</p>
        <p className="text-sm text-muted-foreground">Prefers evening appointments. Paid by card.</p>
      </div>
    </div>
  );
}

export function ChatThread({ wallpaper, onDetails }: { wallpaper?: boolean; onDetails?: () => void }) {
  const { chats, chatId, reply, takeOver, markDone, draftUsed, applyDraft, pendingDraft } = useLab();
  const chat = chats.find((c) => c.id === chatId);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lineCount = chat?.lines.length ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the open chat or its length changes
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [chatId, lineCount]);
  useEffect(() => {
    if (pendingDraft && input.current) {
      input.current.value = draftReply;
      input.current.focus();
    }
  }, [pendingDraft]);

  if (!chat) {
    return (
      <div className="hidden flex-1 flex-col items-center justify-center gap-2 p-8 text-center md:flex">
        <span className="inline-flex size-12 items-center justify-center rounded-full bg-good-soft text-good">
          <Check className="size-6" />
        </span>
        <p className="font-display text-2xl font-semibold tracking-tight">Inbox clear</p>
        <p className="text-muted-foreground">Every chat is handled.</p>
      </div>
    );
  }
  const first = chat.name.split(" ")[0];
  const status =
    chat.who === "Mira"
      ? "Mira is replying"
      : chat.who === "Needs a person"
        ? "Waiting for a person"
        : `Handled by ${chat.who}`;
  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const field = e.currentTarget.elements.namedItem("m") as HTMLInputElement;
    if (!field.value.trim()) return;
    reply(field.value.trim());
    field.value = "";
  }

  return (
    <section aria-label={`Chat with ${chat.name}`} className="hidden min-w-0 flex-1 flex-col md:flex">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-card px-5">
        <Person name={chat.name} />
        <div className="min-w-0">
          <h2 className="truncate font-semibold">{chat.name}</h2>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {chat.who === "Mira" ? <LiveDot /> : null}
            {chat.channel}. {status}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {onDetails ? (
            <Button variant="outline" size="sm" onClick={onDetails}>
              <User />
              Details
            </Button>
          ) : null}
          {chat.who === "Mira" ? (
            <Button size="sm" onClick={takeOver}>
              Take over
            </Button>
          ) : (
            <Button size="sm" onClick={markDone}>
              <Check />
              Mark done
            </Button>
          )}
        </div>
      </header>
      <div
        className="scroll-thin flex-1 overflow-y-auto"
        style={
          wallpaper
            ? {
                backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
                backgroundSize: "18px 18px",
              }
            : undefined
        }
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-5">
          {chat.lines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines are append-only
            <Bubble key={i} line={line} />
          ))}
          <div ref={end} />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 pb-5">
        {chat.id === "daniel" && !draftUsed ? (
          <div className="flex items-start gap-3 rounded-xl bg-ai p-3.5 text-ai-foreground">
            <Mira className="size-8 text-xs" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">Mira drafted a reply</p>
              <p className="mt-0.5">{draftReply}</p>
            </div>
            <Button
              size="sm"
              onClick={applyDraft}
              className="bg-ai-strong text-ai-strong-foreground hover:bg-ai-strong/90"
            >
              Use draft
            </Button>
          </div>
        ) : null}
        {chat.who === "Mira" ? (
          <div className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
            <Mira className="size-7 text-xs" />
            <p className="flex-1 text-muted-foreground">
              Mira is replying in this chat. Take over to write yourself.
            </p>
          </div>
        ) : (
          <form
            onSubmit={send}
            className="flex items-center gap-2 rounded-xl border bg-card px-2 py-1.5 shadow-soft focus-within:border-primary"
          >
            <Button type="button" variant="ghost" size="icon" aria-label="Attach a file">
              <Paperclip />
            </Button>
            <label className="sr-only" htmlFor="reply">
              Reply
            </label>
            <Input
              ref={input}
              id="reply"
              name="m"
              autoComplete="off"
              placeholder={`Write a reply to ${first}`}
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <Button type="submit" size="sm">
              <Send />
              Send
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}

/** `panes` 3 keeps customer details always visible; 2 opens them in a slide-over. */
export function InboxPage({
  panes = 2,
  wallpaper,
  wide,
}: {
  panes?: 2 | 3;
  wallpaper?: boolean;
  wide?: boolean;
}) {
  const { chats, chatId } = useLab();
  const [details, setDetails] = useState(false);
  const chat = chats.find((c) => c.id === chatId);
  return (
    <div className="flex min-h-0 flex-1">
      <ChatList wide={wide} />
      <ChatThread wallpaper={wallpaper} onDetails={panes === 2 ? () => setDetails(true) : undefined} />
      {panes === 3 && chat ? (
        <aside
          aria-label="Customer details"
          className="scroll-thin hidden w-[300px] shrink-0 overflow-y-auto border-l bg-card p-5 xl:block"
        >
          <CustomerFacts name={chat.name} channel={chat.channel} />
        </aside>
      ) : null}
      <Sheet open={details} onOpenChange={setDetails}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Customer details</SheetTitle>
            <SheetDescription>What we know about this customer.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {chat ? <CustomerFacts name={chat.name} channel={chat.channel} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ------------------------------------------------------------ Customers */

export function CustomersPage() {
  const { go } = useLab();
  const [open, setOpen] = useState<number | null>(null);
  const sel = open === null ? null : customers[open];
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <PageHeader title="Customers" sub="1,284 people across both branches">
        <Button variant="outline">Import</Button>
        <Button>
          <Plus />
          Add customer
        </Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-4 sm:px-8">
        <div className="relative w-full sm:w-72">
          <label htmlFor="customer-search" className="sr-only">
            Search customers
          </label>
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input id="customer-search" placeholder="Search by name or phone" className="bg-card pl-9" />
        </div>
        {["Everyone", "New this week", "Booked", "Not seen in 6 months"].map((s, i) => (
          <button
            key={s}
            type="button"
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium",
              i === 0 ? "bg-foreground text-background" : "border bg-card text-muted-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="px-5 pb-8 sm:px-8">
        <div className="overflow-hidden rounded-xl border bg-card shadow-soft">
          <Table>
            <TableHeader>
              <TableRow>
                {["Name", "Branch", "Reached on", "Stage", "Latest", "Handled by"].map((h) => (
                  <TableHead key={h} className="px-4">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c, i) => (
                <TableRow
                  key={c.name}
                  tabIndex={0}
                  onClick={() => setOpen(i)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(i)}
                  className="cursor-pointer"
                >
                  <TableCell className="px-4">
                    <span className="flex items-center gap-2.5">
                      <Person name={c.name} className="size-7" />
                      <span className="font-semibold">{c.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">{c.branch}</TableCell>
                  <TableCell className="px-4">
                    <ChannelTag channel={c.channel} />
                  </TableCell>
                  <TableCell className="px-4">
                    <StageTag stage={c.stage} />
                  </TableCell>
                  <TableCell className="px-4 text-muted-foreground">{c.latest}</TableCell>
                  <TableCell className="px-4">
                    <WhoTag who={c.who} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      <Sheet open={sel !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent>
          {sel ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-display text-xl">{sel.name}</SheetTitle>
                <SheetDescription>
                  {sel.branch}, reached on {sel.channel}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-5 px-4 pb-4">
                <div className="flex gap-1.5">
                  <StageTag stage={sel.stage} />
                  <WhoTag who={sel.who} />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setOpen(null);
                      go("inbox");
                    }}
                  >
                    Message
                  </Button>
                  <Button variant="outline">Book a visit</Button>
                </div>
                <div>
                  <p className="mb-2 text-sm font-semibold">History</p>
                  <ol className="flex flex-col gap-3 border-l-2 pl-4 text-sm">
                    {[
                      ["Today", `Chatted with Mira on ${sel.channel}`],
                      ["9 Nov", `Visited ${sel.branch}`],
                      ["2 Nov", "Received the Winter check-up campaign"],
                    ].map(([d, t]) => (
                      <li key={d}>
                        <span className="text-muted-foreground">{d}</span>
                        <br />
                        {t}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* --------------------------------------------------------------- Agents */

const knowledge = [
  { icon: Globe, title: "lumenclinics.example", sub: "Website, 24 pages, checked daily" },
  { icon: FileText, title: "Price list 2026.pdf", sub: "Uploaded 3 Nov" },
  { icon: HelpCircle, title: "Questions and answers", sub: "38 answers, 3 waiting for you" },
];
const bookingSteps = [
  "Ask which service they need",
  "Offer the two nearest free slots at this branch",
  "Book the slot and confirm the time",
  "Send a reminder the day before",
];
const improvements = [
  ["Answer “Do you open on Sundays?”", "8 customers asked this week and Mira wasn't sure.", "Add answer"],
  ["Offer Downtown when Marina is full", "Mira turned away 4 customers on Saturday.", "Add to procedure"],
  ["Shorten the booking confirmation", "Customers reply faster to messages under 2 lines.", "See example"],
];

export function AgentsPage() {
  const { branch, notify } = useLab();
  const [tab, setTab] = useState("teach");
  const [lines, setLines] = useState<string[]>([]);
  const box = "rounded-xl border bg-card shadow-soft";
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <header className="flex flex-wrap items-center gap-4 px-5 pt-7 pb-4 sm:px-8">
        <Mira className="size-14 text-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">Mira</h1>
          <p className="flex items-center gap-2 text-muted-foreground">
            <LiveDot className="bg-good" />
            Live at {branch}. Answered 42 chats today.
          </p>
        </div>
        <Button variant="outline" onClick={() => notify("Draft saved")}>
          Save draft
        </Button>
        <Button onClick={() => notify("Version 4 is now live")}>Make the draft live</Button>
      </header>
      <Tabs value={tab} onValueChange={setTab} className="px-5 pb-8 sm:px-8">
        <TabsList>
          {["Teach", "Try", "Go live", "Improve"].map((t, i) => (
            <TabsTrigger key={t} value={t.toLowerCase().replace(" ", "-")}>
              <span className="text-xs opacity-60">{i + 1}</span>
              {t}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="teach" className="grid gap-5 pt-4 lg:grid-cols-2">
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">What Mira knows</h2>
            {knowledge.map((k) => (
              <div key={k.title} className={cn(box, "flex items-center gap-3 p-3.5")}>
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted">
                  <k.icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{k.title}</p>
                  <p className="text-sm text-muted-foreground">{k.sub}</p>
                </div>
                <ChevronRight className="size-4 text-muted-foreground" />
              </div>
            ))}
            <Button variant="outline" className="self-start">
              <Plus />
              Add knowledge
            </Button>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="font-semibold">How Mira handles things</h2>
            <div className={cn(box, "p-4")}>
              <div className="flex items-center justify-between">
                <h3 className="font-medium">Book an appointment</h3>
                <span className="text-xs text-muted-foreground">4 steps</span>
              </div>
              <ol className="mt-3 flex flex-col gap-2 text-sm">
                {bookingSteps.map((s, i) => (
                  <li key={s} className="flex gap-2.5">
                    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold">
                      {i + 1}
                    </span>
                    {s}
                  </li>
                ))}
              </ol>
            </div>
            {[
              ["Refund request", "Ask for the visit date, then hand to the front desk"],
              ["Price question", "Answer from the price list, then offer to book"],
            ].map(([t, s]) => (
              <div key={t} className={cn(box, "p-4")}>
                <h3 className="font-medium">{t}</h3>
                <p className="mt-0.5 text-sm text-muted-foreground">{s}</p>
              </div>
            ))}
          </section>
        </TabsContent>

        <TabsContent value="try" className="max-w-2xl pt-4">
          <div className={cn(box, "overflow-hidden")}>
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm">
              <span className="font-semibold">You are the customer</span>
              <span className="text-muted-foreground">on WhatsApp, Marina, Saturday 10:00</span>
            </div>
            <div className="flex flex-col gap-3 bg-background p-4">
              <Bubble line={{ by: "you", text: "I want a cleaning this weekend" }} />
              <Bubble
                line={{
                  by: "customer",
                  text: "Happy to help. Saturday has 11:00 and 3:30 free at Marina. Which would you like?",
                }}
              />
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CornerDownRight className="size-3.5" />
                Followed “Book an appointment”, step 2. Used the Marina calendar.
              </p>
              {lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: test lines are append-only
                <div key={i} className="flex flex-col gap-3">
                  <Bubble line={{ by: "you", text: l }} />
                  <Bubble
                    line={{
                      by: "customer",
                      text: "Done. You're booked, and I'll send a reminder the day before.",
                    }}
                  />
                </div>
              ))}
            </div>
            <form
              className="flex gap-2 border-t p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = e.currentTarget.elements.namedItem("t") as HTMLInputElement;
                if (f.value.trim()) setLines((x) => [...x, f.value.trim()]);
                f.value = "";
              }}
            >
              <label className="sr-only" htmlFor="try">
                Test message
              </label>
              <Input id="try" name="t" autoComplete="off" placeholder="Write as a customer" />
              <Button type="submit">Send</Button>
            </form>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Nothing here reaches real customers. You're testing your draft.
          </p>
        </TabsContent>

        <TabsContent value="go-live" className="flex max-w-2xl flex-col gap-4 pt-4">
          <div className={cn(box, "flex items-center gap-3 p-4")}>
            <span className="size-2.5 rounded-full bg-good" />
            <div className="flex-1">
              <p className="font-semibold">Version 3 is live</p>
              <p className="text-sm text-muted-foreground">
                Since 4 Nov. Answering on WhatsApp, Instagram and the website.
              </p>
            </div>
          </div>
          <div className={cn(box, "p-4")}>
            <h2 className="font-semibold">Your draft changes 2 things</h2>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              <li className="flex gap-2.5">
                <PlusCircle className="mt-0.5 size-4 text-good" />
                New answer: “We accept Aetna and Daman insurance.”
              </li>
              <li className="flex gap-2.5">
                <Pencil className="mt-0.5 size-4 text-primary" />
                Book an appointment: never offer Fridays
              </li>
            </ul>
            <div className="mt-4 flex gap-2">
              <Button onClick={() => notify("Version 4 is now live")}>Make the draft live</Button>
              <Button variant="outline" onClick={() => setTab("try")}>
                Try it first
              </Button>
            </div>
          </div>
          <div className={cn(box, "p-4")}>
            <h2 className="mb-2 font-semibold">Where Mira answers</h2>
            {[
              ["WhatsApp", true],
              ["Instagram", true],
              ["Website chat", true],
              ["Messenger", false],
            ].map(([c, on]) => (
              <div
                key={String(c)}
                className="flex items-center justify-between border-b py-2.5 text-sm last:border-0"
              >
                <label htmlFor={`answers-${c}`}>{c}</label>
                <Switch id={`answers-${c}`} defaultChecked={Boolean(on)} />
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="improve" className="flex max-w-2xl flex-col gap-3 pt-4">
          <p className="text-muted-foreground">
            Each night Mira reviews the day's chats and suggests changes. Nothing changes until you accept.
          </p>
          {improvements.map(([t, s, a]) => (
            <div key={t} className={cn(box, "flex items-center gap-3.5 p-4")}>
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-ai text-ai-foreground">
                <Lightbulb className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{t}</p>
                <p className="text-sm text-muted-foreground">{s}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => notify("Added to your draft")}>
                {a}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
                <X />
              </Button>
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------ Campaigns */

export function CampaignsPage() {
  const { ask, notify } = useLab();
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <PageHeader title="Campaigns" sub="Messages you send to many customers at once">
        <Button variant="outline" onClick={() => ask("Offer 10% off cleanings to lapsed patients")}>
          <Sparkles />
          Ask the assistant
        </Button>
        <Button onClick={() => ask("Offer 10% off cleanings to lapsed patients")}>
          <Plus />
          New campaign
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-3 px-5 pb-8 sm:px-8">
        <div className="flex items-center gap-3.5 rounded-xl border border-destructive bg-card p-4 shadow-soft">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-destructive">
            <CircleAlert className="size-5" />
          </span>
          <div className="flex-1">
            <p className="font-semibold">WhatsApp rejected “Appointment reminder”</p>
            <p className="text-sm text-muted-foreground">
              It reads like marketing. Removing “special offer” should get it approved.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => notify("Sent to WhatsApp for review again")}>
            Fix message
          </Button>
        </div>
        {campaigns.map((c) => (
          <div
            key={c.name}
            className="grid items-center gap-4 rounded-xl border bg-card p-4 shadow-soft md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate font-semibold">{c.name}</h2>
                <Tag tone={c.status === "Sent" ? "good" : c.status === "Sending" ? "primary" : "plain"}>
                  {c.status}
                </Tag>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {c.audience.toLocaleString()} customers. {c.when}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {(
                [
                  ["Delivered", c.delivered],
                  ["Read", c.read],
                  ["Replied", c.replied],
                ] as const
              ).map(([label, pct]) => (
                <div key={label}>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-semibold">{pct}%</span>
                  </div>
                  <Progress value={pct} aria-label={`${label} ${pct}%`} className="mt-1.5 h-1.5" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Insights */

export function WeekChart({ className }: { className?: string }) {
  const max = Math.max(...week.map((d) => d.mira + d.team));
  return (
    <div
      className={cn("flex h-48 items-end gap-3", className)}
      role="img"
      aria-label="Chats per day for the last 7 days. Saturday was the busiest with 61 chats."
    >
      {week.map((d) => (
        <div key={d.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
          <span className="text-xs text-muted-foreground">{d.mira + d.team}</span>
          <div
            className="flex w-full max-w-12 flex-col gap-0.5"
            style={{ height: `${((d.mira + d.team) / max) * 80}%` }}
          >
            <div className="rounded-t-md bg-primary" style={{ flex: d.team }} />
            <div className="rounded-b-md bg-ai-strong" style={{ flex: d.mira }} />
          </div>
          <span className="text-xs text-muted-foreground">{d.day}</span>
        </div>
      ))}
    </div>
  );
}

export function HandoverBars() {
  const max = Math.max(...handovers.map((h) => h.count));
  return (
    <ul className="flex flex-col gap-3.5 text-sm">
      {handovers.map((h) => (
        <li key={h.reason}>
          <div className="flex justify-between">
            <span>{h.reason}</span>
            <span className="font-semibold">{h.count}</span>
          </div>
          <Progress
            value={(h.count / max) * 100}
            aria-label={`${h.reason}: ${h.count}`}
            className="mt-1.5 h-1.5"
          />
        </li>
      ))}
    </ul>
  );
}

export function InsightsPage() {
  const { branch, go } = useLab();
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <PageHeader title="Insights" sub={`${branch}, last 7 days`} />
      <div className="flex flex-col gap-5 px-5 pb-8 sm:px-8">
        <StatTiles className="sm:grid-cols-2 xl:grid-cols-4" />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="rounded-xl border bg-card p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Chats per day</h2>
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-ai-strong" />
                  Mira
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm bg-primary" />
                  Your team
                </span>
              </div>
            </div>
            <WeekChart className="mt-5" />
          </div>
          <div className="rounded-xl border bg-card p-5 shadow-soft">
            <h2 className="mb-4 font-semibold">Why Mira handed chats to the team</h2>
            <HandoverBars />
            <Button variant="outline" size="sm" className="mt-5" onClick={() => go("agents")}>
              See suggested fixes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------- Folio: the list folds away */

/** The chat list folds to a strip of faces once a chat is open, so the conversation gets the room. */
export function FolioInbox() {
  const { chats, chatId, openChat } = useLab();
  const [listOpen, setListOpen] = useState(false);
  const chat = chats.find((c) => c.id === chatId);
  const dot = (who: string) =>
    who === "Needs a person" ? "bg-destructive" : who === "Mira" ? "bg-ai-strong" : "bg-border";
  return (
    <div className="flex min-h-0 flex-1">
      {listOpen ? (
        <div className="relative flex min-h-0">
          <ChatList />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fold the chat list"
            onClick={() => setListOpen(false)}
            className="absolute top-5 right-24 text-muted-foreground"
          >
            <PanelLeftClose />
          </Button>
        </div>
      ) : (
        <nav
          aria-label="Chats"
          className="scroll-thin hidden w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r py-4 md:flex"
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Show the full chat list"
                onClick={() => setListOpen(true)}
                className="mb-1 text-muted-foreground"
              >
                <PanelLeftOpen />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Show all chats</TooltipContent>
          </Tooltip>
          {chats.map((c) => (
            <Tooltip key={c.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${c.name}, ${c.who}`}
                  aria-current={c.id === chatId}
                  onClick={() => openChat(c.id)}
                  className={cn(
                    "relative rounded-full p-0.5 ring-2",
                    c.id === chatId ? "ring-primary" : "ring-transparent hover:ring-border",
                  )}
                >
                  <Person name={c.name} />
                  <span
                    className={cn(
                      "absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-card",
                      dot(c.who),
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {c.name}: {c.who}
              </TooltipContent>
            </Tooltip>
          ))}
        </nav>
      )}
      <ChatThread />
      {chat ? (
        <aside
          aria-label="Customer details"
          className="scroll-thin hidden w-[296px] shrink-0 overflow-y-auto border-l p-6 xl:block"
        >
          <CustomerFacts name={chat.name} channel={chat.channel} />
        </aside>
      ) : null}
    </div>
  );
}
