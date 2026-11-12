"use client";

import { ArrowUp, Bot, Check, ChevronsUpDown, Info, MapPin, Paperclip } from "lucide-react";
import { createContext, type FormEvent, type KeyboardEvent, type ReactNode, useContext } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { branches, type Channel, channelIcon, type Line, type Stage, todayStats } from "@/lib/data";
import { useLab } from "@/lib/store";
import { cn } from "@/lib/utils";

const initials = (name: string) =>
  name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

export function Person({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar className={cn("size-9", className)}>
      <AvatarFallback className="bg-muted text-xs font-semibold">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/** Mira is the customer-facing AI agent. She always uses the AI accent colour. */
export function Mira({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Mira, AI agent"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-ai-strong text-sm font-bold text-ai-strong-foreground",
        className,
      )}
    >
      M
    </span>
  );
}

export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("live-dot relative inline-block size-2 rounded-full bg-ai-strong", className)} />
  );
}

type Tone = "plain" | "ai" | "good" | "danger" | "primary";
const tones: Record<Tone, string> = {
  plain: "bg-muted text-muted-foreground",
  ai: "bg-ai text-ai-foreground",
  good: "bg-good-soft text-good",
  danger: "bg-danger-soft text-destructive",
  primary: "bg-accent text-accent-foreground",
};
export function Tag({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <Badge className={cn("rounded-full border-transparent font-semibold", tones[tone])}>{children}</Badge>
  );
}
export const WhoTag = ({ who }: { who: string }) => (
  <Tag tone={who === "Mira" ? "ai" : who === "Needs a person" || who === "Front desk" ? "danger" : "plain"}>
    {who}
  </Tag>
);
const stageTone: Record<Stage, Tone> = {
  Booked: "good",
  Talking: "primary",
  "New enquiry": "ai",
  Visited: "plain",
};
export const StageTag = ({ stage }: { stage: Stage }) => <Tag tone={stageTone[stage]}>{stage}</Tag>;

export function ChannelTag({ channel }: { channel: Channel }) {
  const Icon = channelIcon[channel];
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3" />
      {channel}
    </span>
  );
}

export function Bubble({ line }: { line: Line }) {
  if (line.by === "note") {
    return (
      <p className="flex w-full items-center justify-center gap-1.5 py-1 text-center text-xs text-muted-foreground">
        <Info className="size-3.5" />
        {line.text}
      </p>
    );
  }
  const mine = line.by !== "customer";
  return (
    <div className={cn("flex", mine && "justify-end")}>
      <div className="max-w-[80%]">
        {line.by === "mira" ? (
          <div className="mb-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground">
            <Bot className="size-3" />
            Mira
          </div>
        ) : null}
        <p
          className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
            line.by === "customer" && "rounded-bl-md border bg-card",
            line.by === "mira" && "rounded-br-md bg-ai text-ai-foreground",
            line.by === "you" && "rounded-br-md bg-primary text-primary-foreground",
          )}
        >
          {line.text}
        </p>
      </div>
    </div>
  );
}

export function BranchMenu({ className, onNav }: { className?: string; onNav?: boolean }) {
  const { branch, setBranch } = useLab();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={onNav ? "ghost" : "outline"}
          size="sm"
          className={cn(
            onNav && "text-nav-foreground hover:bg-nav-active hover:text-nav-foreground",
            className,
          )}
        >
          <MapPin />
          {branch}
          <ChevronsUpDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={branch} onValueChange={setBranch}>
          {branches.map((b) => (
            <DropdownMenuRadioItem key={b} value={b}>
              {b}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AskBox({ placeholder, className }: { placeholder: string; className?: string }) {
  const { ask } = useLab();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const field = e.currentTarget.elements.namedItem("q") as HTMLTextAreaElement;
    ask(field.value);
    field.value = "";
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }
  return (
    <form
      onSubmit={submit}
      className={cn("rounded-xl border bg-card p-3 shadow-soft focus-within:border-primary", className)}
    >
      <label className="sr-only" htmlFor="ask">
        Message the assistant
      </label>
      <Textarea
        id="ask"
        name="q"
        rows={2}
        placeholder={placeholder}
        onKeyDown={onKey}
        className="min-h-14 resize-none border-0 bg-transparent px-1.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" aria-label="Attach a file">
          <Paperclip />
        </Button>
        <BranchMenu className="border-0 text-muted-foreground shadow-none" />
        <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">Enter to send</span>
        <Button type="submit" size="icon" aria-label="Send">
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}

export function NeedsList({ compact }: { compact?: boolean }) {
  const { needs, resolveNeed, go } = useLab();
  if (needs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border bg-card p-8 text-center shadow-soft">
        <span className="inline-flex size-11 items-center justify-center rounded-full bg-good-soft text-good">
          <Check className="size-5" />
        </span>
        <p className="font-semibold">Nothing needs you</p>
        <p className="text-sm text-muted-foreground">
          Mira has the rest covered. New decisions will show up here.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y rounded-xl border bg-card shadow-soft">
      {needs.map((n) => (
        <li key={n.id} className={cn("flex items-center gap-3.5", compact ? "p-3" : "p-4")}>
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-ai text-ai-foreground">
            <n.icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{n.title}</p>
            {compact ? null : <p className="text-sm text-muted-foreground">{n.detail}</p>}
          </div>
          <Button size="sm" onClick={() => go(n.go)}>
            {n.action}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Mark as done: ${n.title}`}
            title="Mark as done"
            onClick={() => resolveNeed(n.id)}
            className="text-muted-foreground hover:bg-good-soft hover:text-good"
          >
            <Check />
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function StatTiles({ className }: { className?: string }) {
  return (
    <dl className={cn("grid gap-3", className)}>
      {todayStats.map((s) => (
        <div key={s.label} className="rounded-xl border bg-card p-4 shadow-soft">
          <dd className="font-display text-3xl font-semibold tracking-tight">{s.value}</dd>
          <dt className="font-medium">{s.label}</dt>
          <p className="mt-1 text-sm text-muted-foreground">{s.note}</p>
        </div>
      ))}
    </dl>
  );
}

/** True inside structures whose own header already names the page, so pages skip their big title. */
export const CompactContext = createContext(false);

export function PageHeader({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  const compact = useContext(CompactContext);
  if (compact) {
    return (
      <header className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-3 sm:px-8">
        <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">{sub}</p>
        <div className="flex gap-2">{children}</div>
      </header>
    );
  }
  return (
    <header className="flex flex-wrap items-end gap-3 px-5 pt-7 pb-5 sm:px-8">
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-muted-foreground">{sub}</p>
      </div>
      <div className="flex gap-2">{children}</div>
    </header>
  );
}
