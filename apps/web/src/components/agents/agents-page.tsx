"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { AgentAvatar } from "@relay/ui/components/person";
import { Panel } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useSearchParams } from "next/navigation";
import { ApiError } from "@/lib/api";
import { GoLiveView } from "./go-live";
import { ImproveView } from "./improve";
import { KnowledgeView } from "./knowledge";
import { type Agent, useAgentActions, useAgents } from "./queries";
import { TeachView } from "./teach";
import { TryView } from "./try";

/*
 * /agents: the branch's AI agent. The sub-menu picks the view (?view=): Teach, Try, Go live, Improve,
 * and the three kinds of knowledge. With no agent yet, the page offers to set one up.
 */

const titles: Record<string, { title: string; description: string }> = {
  teach: {
    title: "Teach",
    description: "Who your agent is, what its job is, and when it hands a chat to your team.",
  },
  try: {
    title: "Try",
    description: "Chat with your agent here before customers do. Nothing is sent on WhatsApp.",
  },
  "go-live": { title: "Go live", description: "Decide which chats your agent answers, and when." },
  improve: {
    title: "Improve",
    description: "Questions your agent couldn't answer. Answer them once and it knows next time.",
  },
  website: { title: "Website", description: "Pages from your website your agent can read and answer from." },
  files: { title: "Files", description: "Price lists, brochures and policies your agent can answer from." },
  "questions-and-answers": {
    title: "Questions and answers",
    description: "Exact answers to the questions customers ask most, and short notes.",
  },
};

export const statusWords: Record<Agent["status"], { label: string; tone: "good" | "plain" | "warning" }> = {
  live: { label: "Live", tone: "good" },
  draft: { label: "Not live yet", tone: "plain" },
  paused: { label: "Paused", tone: "warning" },
};

export function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

export function AgentsPage() {
  const params = useSearchParams();
  const view = titles[params.get("view") ?? ""] ? (params.get("view") as string) : "teach";
  const q = useAgents();
  const agent = q.data?.agents[0];
  const head = titles[view] ?? { title: "Teach", description: "" };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-8">
      {q.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : q.isError ? (
        <EmptyState
          icon={<Icon name="alert" />}
          title="Couldn't load your AI agent"
          description={errorText(q.error)}
          action={<Button onClick={() => q.refetch()}>Try again</Button>}
        />
      ) : !agent ? (
        <SetUpAgent canManage={!!q.data?.canManage} starters={q.data?.starters ?? []} />
      ) : (
        <>
          <header className="flex flex-wrap items-start gap-4">
            <AgentAvatar name={agent.name} size="lg" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
                <Tag size="sm" tone={statusWords[agent.status].tone}>
                  {statusWords[agent.status].label}
                </Tag>
              </div>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{head.title}:</span> {head.description}
              </p>
            </div>
          </header>
          {!q.data.aiReady ? (
            <Panel className="flex items-start gap-3 border-warning bg-warning-soft text-[13px]">
              <Icon name="warning" size="sm" className="mt-0.5 text-warning" />
              <span>
                The AI isn't switched on for this server yet, so {agent.name} can't answer. You can still
                teach it and add knowledge.
              </span>
            </Panel>
          ) : null}
          {view === "teach" ? <TeachView agent={agent} canManage={q.data.canManage} /> : null}
          {view === "try" ? <TryView agent={agent} aiReady={q.data.aiReady} /> : null}
          {view === "go-live" ? <GoLiveView agent={agent} overview={q.data} /> : null}
          {view === "improve" ? <ImproveView agent={agent} canManage={q.data.canManage} /> : null}
          {view === "website" ? <KnowledgeView kind="website" canManage={q.data.canManage} /> : null}
          {view === "files" ? <KnowledgeView kind="file" canManage={q.data.canManage} /> : null}
          {view === "questions-and-answers" ? <KnowledgeView kind="qa" canManage={q.data.canManage} /> : null}
        </>
      )}
    </div>
  );
}

function SetUpAgent({
  canManage,
  starters,
}: {
  canManage: boolean;
  starters: { id: string; label: string; instructions: string }[];
}) {
  const { create } = useAgentActions();
  const start = (starter?: string) =>
    create.mutate(
      { starter },
      {
        onSuccess: () => notify.success("Mira is ready to learn"),
        onError: (err) => notify.error("Couldn't set up the agent", { description: errorText(err) }),
      },
    );
  return (
    <div className="flex flex-col items-center gap-8 py-10 text-center">
      <AgentAvatar name="Mira" size="xl" decorative />
      <div className="flex max-w-lg flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Meet Mira, your AI agent</h1>
        <p className="text-sm text-muted-foreground">
          Mira answers your customers on WhatsApp from what you teach her, and hands the chat to your team
          when a person is needed. Pick what she should do first; you can change everything later.
        </p>
      </div>
      {canManage ? (
        <div className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
          {starters.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={create.isPending}
              onClick={() => start(s.id)}
              className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <span className="font-medium">{s.label}</span>
              <span className="line-clamp-4 text-[13px] text-muted-foreground">
                {s.instructions.split("\n")[0]}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Ask a manager of this branch to set up the AI agent.</p>
      )}
      {canManage ? (
        <Button variant="ghost" disabled={create.isPending} onClick={() => start()}>
          Start from a blank page
        </Button>
      ) : null}
    </div>
  );
}
