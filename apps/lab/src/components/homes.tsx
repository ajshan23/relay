"use client";

import { ArrowUp, ChevronDown, ChevronRight, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { useState } from "react";
import { AskBox, Bubble, LiveDot, Mira, NeedsList, Person, StatTiles, Tag } from "@/components/bits";
import { HandoverBars, WeekChart } from "@/components/pages";
import { Button } from "@/components/ui/button";
import {
  answers,
  branches,
  channelIcon,
  draftReply,
  handledToday,
  rightNow,
  suggestions,
  todayStats,
} from "@/lib/data";
import { useLab } from "@/lib/store";
import { cn } from "@/lib/utils";

const card = "rounded-xl border bg-card shadow-soft";

export function Greeting({ big }: { big?: boolean }) {
  const { branch, needs } = useLab();
  const where = branch === "All branches" ? "Both branches" : branch;
  const left = [
    "Nothing needs you.",
    "One thing needs a decision.",
    "Two things need a decision.",
    "Three things need a decision.",
  ][needs.length];
  return (
    <div className="flex flex-col gap-2.5">
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <LiveDot />
        Mira is replying to 3 customers right now
      </p>
      <h1
        className={cn(
          "font-display leading-[1.08] font-semibold tracking-tight",
          big ? "text-[34px] sm:text-[42px]" : "text-[28px]",
        )}
      >
        Good morning, Priya
      </h1>
      <p className="text-[17px] text-muted-foreground">
        {where} answered 42 of 47 chats without you. {left}
      </p>
    </div>
  );
}

export function Suggestions() {
  const { ask } = useLab();
  return (
    <div className="flex flex-wrap gap-2">
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => ask(s)}
          className="rounded-full border bg-card px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-foreground"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function RightNow() {
  const { go } = useLab();
  return (
    <div className={cn(card, "p-4")}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Right now</h2>
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => go("inbox")}>
          Open inbox
        </Button>
      </div>
      <ul className="mt-3 flex flex-col gap-3">
        {rightNow.map((r) => {
          const Icon = channelIcon[r.channel];
          return (
            <li key={r.name} className="flex items-center gap-3">
              <Person name={r.name} className="size-8" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{r.name}</p>
                <p className="truncate text-xs text-muted-foreground">Mira is {r.what}</p>
              </div>
              <Icon className="size-3.5 text-muted-foreground" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BranchStatus() {
  const { setBranch } = useLab();
  return (
    <div className={cn(card, "p-4")}>
      <h2 className="font-semibold">Branches</h2>
      <ul className="mt-3 flex flex-col gap-2.5 text-sm">
        {(
          [
            ["Marina", "All handled", "good"],
            ["Downtown", "1 chat waiting 12 min", "danger"],
          ] as const
        ).map(([b, status, tone]) => (
          <li key={b} className="flex items-center justify-between gap-3">
            <button type="button" className="font-medium hover:text-primary" onClick={() => setBranch(b)}>
              {b}
            </button>
            <Tag tone={tone}>{status}</Tag>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodayCompact() {
  const { go } = useLab();
  return (
    <div className={cn(card, "p-4")}>
      <h2 className="font-semibold">Today</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        {todayStats.map((s) => (
          <div key={s.label}>
            <dd className="font-display text-2xl font-semibold tracking-tight">{s.value}</dd>
            <dt className="text-sm text-muted-foreground">{s.label}</dt>
          </div>
        ))}
      </dl>
      <Button variant="link" size="sm" className="mt-3 h-auto p-0" onClick={() => go("insights")}>
        See insights
      </Button>
    </div>
  );
}

/* ----------------------------------------- Assistant: ask first, panel beside */

function AnswerBody() {
  const { thread } = useLab();
  if (!thread) return null;
  if (thread.kind === "numbers") {
    return (
      <>
        <dl className="grid grid-cols-2 gap-3">
          {[
            ["297", "chats"],
            ["87%", "answered by Mira"],
            ["1m 40s", "to first reply"],
            ["61", "bookings"],
          ].map(([n, l]) => (
            <div key={l} className="rounded-lg bg-background p-3.5">
              <dd className="font-display text-2xl font-semibold tracking-tight">{n}</dd>
              <dt className="text-sm text-muted-foreground">{l}</dt>
            </div>
          ))}
        </dl>
        <div>
          <p className="mb-3 text-sm font-semibold">Chats per day</p>
          <WeekChart className="h-36" />
        </div>
      </>
    );
  }
  if (thread.kind === "handover") {
    return (
      <>
        <HandoverBars />
        <div className="rounded-lg bg-ai p-3.5 text-sm text-ai-foreground">
          <p className="font-semibold">Most asked, not yet answered</p>
          <p className="mt-1">“Do you open on Sundays?” was asked 8 times.</p>
        </div>
      </>
    );
  }
  const facts = [
    ["Audience", "412 patients, last visit before 12 May"],
    ["Pace", "100 a day, about 5 days"],
    ["Replies handled by", "Mira, then front desk"],
    ["Estimated cost", "AED 62 in WhatsApp fees"],
  ];
  return (
    <>
      <div className="flex flex-col gap-2 rounded-lg bg-background p-4">
        <p className="text-xs font-semibold text-muted-foreground">What customers receive</p>
        <div className="max-w-[90%] self-start rounded-2xl rounded-bl-md border bg-card px-3.5 py-2.5 text-sm leading-relaxed">
          Hi Asha, it's been a while. Book a cleaning at Lumen Marina before Sunday and get 10% off.
          <p className="mt-2.5 border-t pt-2.5 text-center font-semibold text-primary">Book a time</p>
        </div>
      </div>
      <dl className="flex flex-col divide-y text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-2.5">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

export function AssistantThread() {
  const { thread, panel, setPanel, sent, toggleSent, notify, go, branch } = useLab();
  if (!thread) return null;
  const a = answers[thread.kind];
  const done = thread.stage === "done";
  const Toggle = panel ? PanelRightClose : PanelRightOpen;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-5">
          <h1 className="truncate font-sans text-base font-semibold">{a.title}</h1>
          <Tag tone="primary">{branch}</Tag>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-8">
            <p className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-muted px-4 py-3 text-[15px] leading-relaxed">
              {thread.q}
            </p>
            <div className="flex gap-3">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                R
              </span>
              {done ? (
                <div className="flex min-w-0 flex-1 flex-col gap-4 text-[15px] leading-relaxed">
                  <p>{a.before}</p>
                  <button
                    type="button"
                    onClick={() => setPanel(!panel)}
                    className={cn(
                      card,
                      "flex w-full items-center gap-3 p-3.5 text-left hover:border-primary",
                      panel && "border-primary",
                    )}
                  >
                    <span className="inline-flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                      <a.icon className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{a.title}</span>
                      <span className="block text-sm text-muted-foreground">{a.sub}</span>
                    </span>
                    <Toggle className="size-4 text-muted-foreground" />
                  </button>
                  <p>{a.after}</p>
                  <div className="flex flex-wrap gap-2">
                    {a.actions.map((label, i) => (
                      <Button
                        key={label}
                        variant={i === 0 ? "default" : "secondary"}
                        onClick={() =>
                          i === 0 && thread.kind === "campaign" ? toggleSent() : notify(`Noted: ${label}`)
                        }
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  className="inline-flex h-8 items-center gap-1.5 px-1"
                  role="status"
                  aria-label="The assistant is working"
                >
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="think-dot size-2 rounded-full bg-muted-foreground" />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mx-auto w-full max-w-2xl px-5 pb-5">
          <AskBox placeholder="Reply to the assistant" />
        </div>
      </div>
      {panel && done ? (
        <aside aria-label={a.title} className="hidden w-[420px] shrink-0 flex-col border-l bg-card lg:flex">
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <h2 className="flex-1 truncate font-semibold">{a.sub.split(",")[0]}</h2>
            {thread.kind === "campaign" ? (
              <Tag tone={sent ? "good" : "plain"}>{sent ? "Scheduled for 5:00 pm" : "Not sent"}</Tag>
            ) : null}
            <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={() => setPanel(false)}>
              <X />
            </Button>
          </div>
          <div className="scroll-thin flex flex-1 flex-col gap-5 overflow-y-auto p-5">
            <div>
              <h3 className="font-display text-xl font-semibold tracking-tight">{a.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {thread.kind === "campaign"
                  ? "Marina, WhatsApp, starts today 5:00 pm"
                  : "Marina, Wed 6 to Tue 12 Nov"}
              </p>
            </div>
            <AnswerBody />
          </div>
          <div className="flex gap-2 border-t p-4">
            {thread.kind === "campaign" ? (
              <Button variant={sent ? "outline" : "default"} onClick={toggleSent}>
                {sent ? "Cancel sending" : "Send at 5:00 pm"}
              </Button>
            ) : (
              <Button onClick={() => go("insights")}>Open in Insights</Button>
            )}
            <Button variant="ghost" className="ml-auto" onClick={() => notify("Saved to recent requests")}>
              Save for later
            </Button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}

export function AssistantHome() {
  const { thread, needs } = useLab();
  if (thread) return <AssistantThread />;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-8 sm:px-8 sm:py-12 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-7 xl:w-full xl:max-w-2xl xl:justify-self-center">
          <Greeting big />
          <AskBox placeholder="Ask for a campaign, a report, or a change to how Mira answers" />
          <div className="-mt-3">
            <Suggestions />
          </div>
          <section aria-labelledby="needs-h" className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <h2 id="needs-h" className="font-semibold">
                Needs you
              </h2>
              {needs.length ? (
                <span className="text-sm text-muted-foreground">{needs.length} left</span>
              ) : null}
            </div>
            <NeedsList />
          </section>
        </div>
        <aside aria-label="Right now" className="flex flex-col gap-4">
          <RightNow />
          <TodayCompact />
          <BranchStatus />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------ Briefing: a feed of today */

export function BriefingHome() {
  const { thread, go, notify } = useLab();
  if (thread) return <AssistantThread />;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Greeting />
          <section aria-label="Needs you" className="mt-2">
            <NeedsList />
          </section>
          <div className={cn(card, "flex items-start gap-3 p-4")}>
            <Mira />
            <div className="flex-1">
              <h2 className="font-semibold">Mira booked 9 appointments today</h2>
              <p className="text-sm text-muted-foreground">
                6 cleanings, 2 check-ups, 1 whitening. Saturday is now full.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => go("customers")}>
              See bookings
            </Button>
          </div>
          <div className={cn(card, "p-4")}>
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <h2 className="font-semibold">“Winter check-up” reached 412 customers</h2>
                <p className="text-sm text-muted-foreground">
                  388 delivered, 201 read, 23 replied. 7 booked from it so far.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => go("campaigns")}>
                Open
              </Button>
            </div>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted">
              <span className="bg-primary" style={{ width: "49%" }} />
              <span className="bg-ai-strong" style={{ width: "45%" }} />
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-xl border border-dashed p-4">
            <div className="flex-1">
              <h2 className="font-semibold">Suggestion: tell customers about Sunday hours</h2>
              <p className="text-sm text-muted-foreground">
                8 people asked this week and Mira had to say she wasn't sure.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => notify("Added to Mira's draft")}>
              Add answer
            </Button>
          </div>
          <AskBox
            placeholder="Or ask for something: a campaign, a report, a change to Mira"
            className="mt-2"
          />
        </div>
        <aside className="flex flex-col gap-3">
          <StatTiles />
          <BranchStatus />
        </aside>
      </div>
    </div>
  );
}

/* --------------------------------------------- Triage: one decision at a time */

export function TriageHome() {
  const { thread, needs, resolveNeed, go, notify, ask } = useLab();
  if (thread) return <AssistantThread />;
  const [top, ...rest] = needs;
  const total = 3;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-10 pb-32">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight">
              {needs.length
                ? `${needs.length} ${needs.length === 1 ? "decision" : "decisions"} left`
                : "All clear"}
            </h1>
            <p className="text-muted-foreground">Everything else at Marina is handled by Mira.</p>
          </div>
          <div className="flex gap-1" role="img" aria-label={`${total - needs.length} of ${total} done`}>
            {Array.from({ length: total }, (_, i) => i).map((i) => (
              <span
                key={i}
                className={cn("h-1.5 w-8 rounded-full", i < total - needs.length ? "bg-good" : "bg-border")}
              />
            ))}
          </div>
        </div>

        {top ? (
          <article className={cn(card, "overflow-hidden")}>
            <div className="flex flex-col gap-4 p-5">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-11 items-center justify-center rounded-lg bg-ai text-ai-foreground">
                  <top.icon className="size-5" />
                </span>
                <div>
                  <h2 className="font-sans text-lg font-semibold">{top.title}</h2>
                  <p className="text-sm text-muted-foreground">{top.detail}</p>
                </div>
              </div>
              {top.id === "refund" ? (
                <>
                  <div className="rounded-lg bg-background p-3">
                    <Bubble
                      line={{
                        by: "customer",
                        text: "I was charged twice for the whitening. Can I get a refund?",
                      }}
                    />
                  </div>
                  <div className="rounded-lg bg-ai p-3.5 text-sm text-ai-foreground">
                    <p className="font-semibold">Mira suggests replying</p>
                    <p className="mt-1">{draftReply}</p>
                  </div>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 border-t bg-muted/50 px-5 py-3">
              <Button
                onClick={() => {
                  resolveNeed(top.id);
                }}
              >
                {top.id === "refund" ? "Approve and send" : "Accept the fix"}
              </Button>
              <Button variant="outline" onClick={() => go(top.go)}>
                {top.action}
              </Button>
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => notify("We'll remind you in an hour")}
              >
                Later
              </Button>
            </div>
          </article>
        ) : (
          <div className={cn(card, "flex flex-col items-center gap-2 p-10 text-center")}>
            <p className="font-display text-xl font-semibold">Nothing needs you</p>
            <p className="text-muted-foreground">Mira has the rest covered.</p>
            <Button variant="outline" className="mt-2" onClick={() => ask("Show this week's numbers")}>
              See how the week went
            </Button>
          </div>
        )}

        {rest.map((n) => (
          <div key={n.id} className={cn(card, "flex items-center gap-3 px-4 py-3 opacity-75")}>
            <span className="inline-flex size-9 items-center justify-center rounded-lg bg-ai text-ai-foreground">
              <n.icon className="size-4" />
            </span>
            <p className="truncate text-sm font-semibold">{n.title}</p>
            <span className="ml-auto text-xs text-muted-foreground">Next</span>
          </div>
        ))}
        <AskBox placeholder="Or ask for something else" />
      </div>
    </div>
  );
}

/* ------------------------------ Board: the branch's day, sorted by who has it */

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Lane({
  title,
  count,
  dot,
  children,
}: {
  title: string;
  count: number;
  dot: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-center gap-2 font-sans text-sm font-semibold">
        <span className={cn("size-2 rounded-full", dot)} />
        {title}
        <span className="font-normal text-muted-foreground">{count}</span>
      </h2>
      {children}
    </section>
  );
}

export function BoardHome() {
  const { thread, branch, setBranch, needs, resolveNeed, go, chats, openChat, takeOver } = useLab();
  if (thread) return <AssistantThread />;
  const live = chats.filter((c) => c.who === "Mira");
  const where = branch === "All branches" ? "across both branches" : `at ${branch}`;
  const outcomeTone = { Booked: "good", Answered: "plain", "Handed over": "danger" } as const;
  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-5 py-7 sm:px-8">
        <header className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight">
              {days[2]} {where}
            </h1>
            <p className="mt-1 text-muted-foreground">
              47 chats so far. Mira answered 42 of them without you.
            </p>
          </div>
          <fieldset className="inline-flex rounded-lg border bg-card p-1 shadow-soft" aria-label="Branch">
            {branches.map((b) => (
              <button
                key={b}
                type="button"
                aria-pressed={branch === b}
                onClick={() => setBranch(b)}
                className={cn(
                  "h-8 rounded-md px-3 text-sm font-medium",
                  branch === b
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {b}
              </button>
            ))}
          </fieldset>
        </header>

        <dl className={cn(card, "grid grid-cols-2 divide-x divide-y lg:grid-cols-4 lg:divide-y-0")}>
          {todayStats.map((s) => (
            <div key={s.label} className="p-4">
              <dd className="font-display text-2xl font-semibold tracking-tight">{s.value}</dd>
              <dt className="text-sm text-muted-foreground">{s.label}</dt>
            </div>
          ))}
        </dl>

        <div className="grid gap-6 lg:grid-cols-3">
          <Lane title="Waiting for you" count={needs.length} dot="bg-destructive">
            {needs.length === 0 ? (
              <p className={cn(card, "p-5 text-sm text-muted-foreground")}>Nothing is waiting for you.</p>
            ) : (
              needs.map((n) => (
                <article key={n.id} className={cn(card, "flex flex-col gap-3 p-4")}>
                  <div className="flex items-start gap-3">
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-destructive">
                      <n.icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-semibold">{n.title}</h3>
                      <p className="text-sm text-muted-foreground">{n.detail}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => go(n.go)}>
                      {n.action}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => resolveNeed(n.id)}>
                      Mark done
                    </Button>
                  </div>
                </article>
              ))
            )}
          </Lane>

          <Lane title="Mira is handling" count={live.length} dot="bg-ai-strong">
            {live.map((c) => {
              const Icon = channelIcon[c.channel];
              return (
                <article key={c.id} className={cn(card, "flex flex-col gap-3 p-4")}>
                  <div className="flex items-center gap-3">
                    <Person name={c.name} />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold">{c.name}</h3>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <LiveDot />
                        Mira is replying
                        <Icon className="ml-1 size-3" />
                        {c.channel}
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 rounded-lg bg-ai px-3 py-2 text-sm text-ai-foreground">
                    {c.lines.at(-1)?.text}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        openChat(c.id);
                        go("inbox");
                      }}
                    >
                      Watch
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        openChat(c.id);
                        takeOver();
                        go("inbox");
                      }}
                    >
                      Take over
                    </Button>
                  </div>
                </article>
              );
            })}
          </Lane>

          <Lane title="Handled today" count={42} dot="bg-good">
            <ul className={cn(card, "divide-y")}>
              {handledToday.map((h) => (
                <li key={h.name} className="flex items-center gap-3 p-3">
                  <Person name={h.name} className="size-8" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{h.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{h.detail}</p>
                  </div>
                  <Tag tone={outcomeTone[h.outcome]}>{h.outcome}</Tag>
                  <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{h.time}</span>
                </li>
              ))}
            </ul>
            <Button variant="link" size="sm" className="h-auto self-start p-0" onClick={() => go("inbox")}>
              See all 42
            </Button>
          </Lane>
        </div>
      </div>
    </div>
  );
}

/** The assistant as a bar at the bottom of every page, instead of a page of its own. */
export function AskBar() {
  const { ask } = useLab();
  return (
    <div className="shrink-0 px-5 pt-2 pb-4 sm:px-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const field = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
          ask(field.value);
          field.value = "";
        }}
        className="mx-auto flex h-12 max-w-3xl items-center gap-2 rounded-full border bg-card pr-1.5 pl-4 shadow-soft focus-within:border-primary"
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          R
        </span>
        <label className="sr-only" htmlFor="ask-bar">
          Ask Relay
        </label>
        <input
          id="ask-bar"
          name="q"
          autoComplete="off"
          placeholder="Tell Relay what you need: a campaign, a report, a change to Mira"
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <kbd className="hidden rounded border px-1.5 font-sans text-[11px] text-muted-foreground sm:inline">
          Enter
        </kbd>
        <Button type="submit" size="icon-sm" aria-label="Send" className="rounded-full">
          <ArrowUp />
        </Button>
      </form>
    </div>
  );
}

/* --------------------------------- Ledger: the day as one timeline with Now */

type Actor = "Mira" | "You" | "Automation" | "Needs you";
const actorDot: Record<Actor, string> = {
  Mira: "bg-ai-strong",
  You: "bg-primary",
  Automation: "bg-muted-foreground",
  "Needs you": "bg-destructive",
};

/** One line of the day. Past entries are plain text; only things you act on become a card. */
function Entry({
  time,
  actor,
  upcoming,
  last,
  children,
}: {
  time: string;
  actor: Actor;
  upcoming?: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[52px_20px_minmax(0,1fr)] gap-x-3">
      <time className="pt-0.5 text-right text-xs text-muted-foreground tabular-nums">{time}</time>
      <span className="relative flex justify-center">
        {last ? null : <span className="absolute inset-y-0 w-px bg-border" />}
        <span
          className={cn(
            "relative mt-1.5 size-2.5 rounded-full ring-4 ring-card",
            upcoming ? "border-2 border-muted-foreground bg-card" : actorDot[actor],
          )}
        />
      </span>
      <div className={cn("min-w-0", last ? "pb-2" : "pb-6")}>
        <p
          className={cn(
            "text-xs font-semibold",
            actor === "Needs you" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {actor}
        </p>
        <div className={cn("mt-0.5 text-[15px] leading-relaxed", upcoming && "text-muted-foreground")}>
          {children}
        </div>
      </div>
    </li>
  );
}

const routine = [
  "Opening hours, asked 5 times",
  "Parking near the clinic, asked 4 times",
  "Price of a check-up, asked 5 times",
];

export function LedgerHome() {
  const { thread, branch, setBranch, needs, resolveNeed, go, notify, chats, openChat, sent } = useLab();
  const [folded, setFolded] = useState(true);
  const [view, setView] = useState<"Day" | "Week">("Day");
  if (thread) return <AssistantThread />;
  const open = (id: string) => needs.some((n) => n.id === id);
  const live = chats.filter((c) => c.who === "Mira");
  const where = branch === "All branches" ? "both branches" : branch;
  const Fold = folded ? ChevronRight : ChevronDown;
  const seg = "h-8 rounded-md px-3 text-sm font-medium";

  return (
    <div className="scroll-thin flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1120px] gap-12 px-6 py-8 sm:px-10 lg:px-12">
        <div className="min-w-0 max-w-[720px] flex-1">
          <header className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-8">
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight">
                Tuesday 12 November
              </h1>
              <p className="mt-1 text-muted-foreground">
                47 chats at {where} so far. Mira answered 42 without you.
                {needs.length
                  ? ` ${needs.length} ${needs.length === 1 ? "is" : "are"} waiting for you.`
                  : " Nothing is waiting for you."}
              </p>
            </div>
            <fieldset className="inline-flex rounded-lg bg-muted p-1" aria-label="Period">
              {(["Day", "Week"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => setView(v)}
                  className={cn(seg, view === v ? "bg-card shadow-sm" : "text-muted-foreground")}
                >
                  {v}
                </button>
              ))}
            </fieldset>
          </header>

          <ol>
            <Entry time="08:00" actor="Mira">
              Booked Sara Lund for a cleaning, Friday 2:00.
            </Entry>
            <Entry time="09:14" actor="Mira">
              <button
                type="button"
                aria-expanded={!folded}
                onClick={() => setFolded(!folded)}
                className="inline-flex items-center gap-1 text-left hover:text-primary"
              >
                Answered 14 routine questions.
                <Fold className="size-4 text-muted-foreground" />
              </button>
              {folded ? null : (
                <ul className="mt-1.5 flex flex-col gap-1 text-sm text-muted-foreground">
                  {routine.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
            </Entry>
            <Entry time="09:20" actor="You">
              Approved the “Winter check-up” campaign for 412 customers.
            </Entry>
            <Entry time="09:47" actor="Automation">
              Sent 6 appointment reminders for tomorrow.
            </Entry>

            {open("refund") ? (
              <Entry time="10:02" actor="Needs you">
                <article className="mt-1.5 flex flex-col gap-3 rounded-xl border bg-background p-4">
                  <div className="flex items-center gap-3">
                    <Person name="Daniel Okafor" />
                    <div>
                      <h2 className="font-sans text-base font-semibold">Daniel Okafor asks for a refund</h2>
                      <p className="text-sm text-muted-foreground">
                        Instagram. Mira paused because refunds need a person.
                      </p>
                    </div>
                  </div>
                  <p className="text-sm">“I was charged twice for the whitening. Can I get a refund?”</p>
                  <div className="rounded-lg bg-ai p-3 text-sm text-ai-foreground">
                    <p className="font-semibold">Mira's suggested reply</p>
                    <p className="mt-1">{draftReply}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => resolveNeed("refund")}>
                      Approve and send
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        openChat("daniel");
                        go("inbox");
                      }}
                    >
                      Reply myself
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => notify("We'll remind you in an hour")}
                    >
                      Later
                    </Button>
                  </div>
                </article>
              </Entry>
            ) : (
              <Entry time="10:02" actor="You">
                Approved Mira's reply to Daniel Okafor about his refund.
              </Entry>
            )}

            {open("insurance") ? (
              <Entry time="10:20" actor="Needs you">
                Mira couldn't answer “Do you take Aetna insurance?” It was asked 3 times this week.
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => go("agents")}>
                    Teach Mira
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => resolveNeed("insurance")}>
                    Mark done
                  </Button>
                </div>
              </Entry>
            ) : (
              <Entry time="10:20" actor="You">
                Dealt with the insurance question.
              </Entry>
            )}

            <Entry time="10:31" actor="Mira">
              Booked Leila Haddad for a check-up, Wednesday 4:00.
            </Entry>

            {open("template") ? (
              <Entry time="10:38" actor="Needs you">
                WhatsApp rejected your appointment reminder because it reads like marketing.
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => go("campaigns")}>
                    Fix message
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => resolveNeed("template")}>
                    Mark done
                  </Button>
                </div>
              </Entry>
            ) : (
              <Entry time="10:38" actor="You">
                Fixed the appointment reminder.
              </Entry>
            )}

            <li className="grid grid-cols-[52px_20px_minmax(0,1fr)] items-center gap-x-3 pb-6">
              <span className="text-right text-xs font-bold text-primary tabular-nums">10:41</span>
              <span className="flex justify-center">
                <span className="live-dot relative size-2.5 rounded-full bg-primary" />
              </span>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-primary">Now</span>
                <span className="h-px flex-1 bg-primary/40" />
              </div>
            </li>

            <Entry time="" actor="Mira">
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex -space-x-2">
                  {live.slice(0, 3).map((c) => (
                    <Person key={c.id} name={c.name} className="size-7 ring-2 ring-card" />
                  ))}
                </span>
                <span>
                  Replying to {live.length} {live.length === 1 ? "customer" : "customers"} right now.
                </span>
                <Button variant="outline" size="sm" onClick={() => go("inbox")}>
                  Watch
                </Button>
              </div>
            </Entry>

            <Entry time="11:30" actor="Automation" upcoming>
              Reminder goes to Lina Haddad about tomorrow's visit.
            </Entry>
            <Entry time="14:00" actor="Automation" upcoming>
              “Winter check-up” sends its next 100 messages.
            </Entry>
            <Entry time="17:00" actor={sent ? "You" : "Automation"} upcoming last>
              {sent
                ? "“Winter cleaning offer” starts sending to 412 customers."
                : "Nothing else is scheduled today."}
            </Entry>
          </ol>
        </div>

        <aside
          aria-label="Branches and today"
          className="sticky top-8 hidden w-[280px] shrink-0 flex-col gap-10 self-start lg:flex"
        >
          <section>
            <h2 className="font-sans text-sm font-semibold">Branches</h2>
            <ul className="mt-3 flex flex-col gap-1">
              {(
                [
                  ["Marina", "31 chats", "bg-good"],
                  ["Downtown", "16 chats, 1 waiting", "bg-destructive"],
                  ["All branches", "47 chats", "bg-border"],
                ] as const
              ).map(([b, note, dot]) => (
                <li key={b}>
                  <button
                    type="button"
                    aria-pressed={branch === b}
                    onClick={() => setBranch(b)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm",
                      branch === b ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                    )}
                  >
                    <span className={cn("size-2 rounded-full", dot)} />
                    <span className="flex-1 font-medium">{b}</span>
                    <span className="text-xs text-muted-foreground">{note}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="font-sans text-sm font-semibold">So far today</h2>
            <dl className="mt-3 flex flex-col gap-2.5 text-sm">
              {todayStats.map((s) => (
                <div key={s.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{s.label}</dt>
                  <dd className="font-display text-lg font-semibold tabular-nums">{s.value}</dd>
                </div>
              ))}
            </dl>
            <Button variant="link" size="sm" className="mt-2 h-auto p-0" onClick={() => go("insights")}>
              See insights
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}
