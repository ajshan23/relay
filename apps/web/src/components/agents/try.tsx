"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { AgentAvatar } from "@relay/ui/components/person";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { TextArea } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import { useEffect, useRef, useState } from "react";
import { errorText } from "./agents-page";
import { type Agent, type TryResult, useTryAgent } from "./queries";

/*
 * Try: a pretend WhatsApp chat with the agent. Each message runs one real turn (same prompt, tools and
 * knowledge as live chats) but nothing is sent to anyone and no contact changes. Beside it, what the
 * agent did for the last answer: what it found, which tools it used, and what the answer cost.
 */

type Line = { id: number } & (
  | { from: "customer"; text: string }
  | { from: "agent"; text: string; options?: { id: string; title: string }[] }
  | { from: "event"; text: string }
);

let lineSeq = 0;
/** Gives a chat line its own key. */
const line = <T extends Omit<Line, "id">>(l: T) => ({ ...l, id: ++lineSeq }) as Line;

const examples = ["What are your timings?", "How much does it cost?", "Can I talk to a person?"];

export function TryView({ agent, aiReady }: { agent: Agent; aiReady: boolean }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState("");
  const [last, setLast] = useState<TryResult | null>(null);
  const [ended, setEnded] = useState(false);
  const tryAgent = useTryAgent(agent.id);
  const end = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll down whenever a line or "typing…" appears
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [lines.length, tryAgent.isPending]);

  const send = (message: string) => {
    const said = message.trim();
    if (!said || tryAgent.isPending || ended) return;
    const next: Line[] = [...lines, line({ from: "customer", text: said })];
    setLines(next);
    setText("");
    const history = next
      .filter((l): l is Exclude<Line, { from: "event" }> => l.from !== "event")
      .map((l) => ({ from: l.from, text: l.text }));
    tryAgent.mutate(
      { messages: history },
      {
        onSuccess: (r) => {
          setLast(r);
          const o = r.outcome;
          const add: Line[] = [];
          if (o.kind === "reply") {
            add.push(line({ from: "agent", text: o.text }));
            if (o.gap)
              add.push(
                line({
                  from: "event",
                  text: `${agent.name} couldn't answer “${o.gap}”. In a real chat it goes to Improve.`,
                }),
              );
          }
          if (o.kind === "options") add.push(line({ from: "agent", text: o.text, options: o.options }));
          if (o.kind === "handoff") {
            if (o.text) add.push(line({ from: "agent", text: o.text }));
            if (agent.handoff.message) add.push(line({ from: "agent", text: agent.handoff.message }));
            add.push(
              line({ from: "event", text: `${agent.name} would hand this chat to your team: ${o.reason}.` }),
            );
            setEnded(true);
          }
          if (o.kind === "close") {
            if (o.text) add.push(line({ from: "agent", text: o.text }));
            add.push(line({ from: "event", text: `${agent.name} would close this chat.` }));
            setEnded(true);
          }
          if (o.kind === "silent")
            add.push(line({ from: "event", text: `${agent.name} chose not to reply.` }));
          setLines((cur) => [...cur, ...add]);
        },
        onError: (err) => setLines((cur) => [...cur, line({ from: "event", text: errorText(err) })]),
      },
    );
  };

  const restart = () => {
    setLines([]);
    setLast(null);
    setEnded(false);
    tryAgent.reset();
  };

  if (!aiReady)
    return (
      <EmptyState
        icon={<Icon name="sparkles" />}
        title="The AI isn't switched on yet"
        description="Once the server has an AI key, you can chat with your agent here."
      />
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel padding="none" className="flex h-[min(640px,70vh)] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <AgentAvatar name={agent.name} size="sm" decorative />
          <span className="text-sm font-medium">{agent.name}</span>
          <Tag size="sm" tone="ai">
            Test chat
          </Tag>
          <Button size="xs" variant="ghost" className="ml-auto" onClick={restart} disabled={!lines.length}>
            Start over
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto bg-muted/40 px-4 py-4" aria-live="polite">
          {!lines.length ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                Write as a customer would. Answers come from what you taught {agent.name} and its knowledge.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {examples.map((e) => (
                  <Button key={e} size="sm" variant="outline" onClick={() => send(e)}>
                    {e}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-2">
              {lines.map((l, i) =>
                l.from === "event" ? (
                  <li
                    key={l.id}
                    className="self-center rounded-full bg-background px-3 py-1 text-center text-xs text-muted-foreground"
                  >
                    {l.text}
                  </li>
                ) : l.from === "customer" ? (
                  <li
                    key={l.id}
                    className="max-w-[80%] self-end rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground"
                  >
                    {l.text}
                  </li>
                ) : (
                  <li key={l.id} className="flex max-w-[85%] items-end gap-2 self-start">
                    <AgentAvatar name={agent.name} size="xs" decorative />
                    <div className="flex flex-col gap-1.5">
                      <div className="rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
                        {l.text}
                      </div>
                      {l.options ? (
                        <div className="flex flex-wrap gap-1.5">
                          {l.options.map((o) => (
                            <Button
                              key={o.id}
                              size="xs"
                              variant="outline"
                              disabled={ended || tryAgent.isPending || i !== lines.length - 1}
                              onClick={() => send(o.title)}
                            >
                              {o.title}
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ),
              )}
              {tryAgent.isPending ? (
                <li className="flex items-center gap-2 self-start text-[13px] text-muted-foreground">
                  <AgentAvatar name={agent.name} size="xs" decorative />
                  {agent.name} is typing…
                </li>
              ) : null}
            </ol>
          )}
          <div ref={end} />
        </div>
        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <TextArea
            aria-label="Message as a customer"
            value={text}
            minRows={1}
            maxRows={5}
            maxLength={2000}
            disabled={ended}
            placeholder={
              ended ? "This test chat has ended. Start over to try again." : "Write as a customer…"
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
          />
          <Button type="submit" disabled={!text.trim() || tryAgent.isPending || ended}>
            Send
          </Button>
        </form>
      </Panel>

      <Section title="What it did" description="For the last answer." as="h3">
        {!last ? (
          <p className="text-[13px] text-muted-foreground">
            Send a message to see what {agent.name} looked up.
          </p>
        ) : (
          <div className="flex flex-col gap-4 text-[13px]">
            <div className="flex flex-col gap-2">
              <span className="font-medium">Knowledge it used</span>
              {last.knowledge.length ? (
                last.knowledge.map((k) => (
                  <Panel
                    key={`${k.source}:${k.text.slice(0, 40)}`}
                    padding="sm"
                    className="flex flex-col gap-1"
                  >
                    <span className="font-medium">{k.source}</span>
                    <span className="line-clamp-4 text-muted-foreground">{k.text}</span>
                  </Panel>
                ))
              ) : (
                <span className="text-muted-foreground">
                  {last.tools.some((t) => t.name === "search_knowledge")
                    ? "It searched but found nothing."
                    : "It didn't need to look anything up."}
                </span>
              )}
            </div>
            {last.tools.length ? (
              <div className="flex flex-col gap-1">
                <span className="font-medium">Steps</span>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {last.tools.map((t, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps of one answer, in order, never reordered
                    <li key={i} className="flex items-center gap-1.5">
                      <Icon name={t.ok ? "check" : "warning"} size="sm" />
                      {toolWords[t.name] ?? t.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <span className="font-medium">Cost</span>
              <span className="text-muted-foreground">
                {formatUsd(last.usage.reduce((n, u) => n + u.costMicros, 0) / 1_000_000)} ·{" "}
                {last.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0).toLocaleString()} tokens ·{" "}
                {(last.usage.reduce((n, u) => n + u.latencyMs, 0) / 1000).toFixed(1)} s. Tests don't use
                credits.
              </span>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

const toolWords: Record<string, string> = {
  search_knowledge: "Searched its knowledge",
  update_contact: "Would save to the contact card",
};

function formatUsd(n: number) {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
