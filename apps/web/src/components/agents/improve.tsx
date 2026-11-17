"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import Link from "next/link";
import { useState } from "react";
import { errorText } from "./agents-page";
import { type Agent, type Gap, useGapActions, useGaps } from "./queries";

/** Improve: what customers asked that the agent couldn't answer. An answer here becomes knowledge. */

export function ImproveView({ agent, canManage }: { agent: Agent; canManage: boolean }) {
  const gaps = useGaps();
  if (gaps.isPending) return <Skeleton className="h-40 w-full" />;
  if (gaps.isError)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load questions"
        description={errorText(gaps.error)}
      />
    );
  if (!gaps.data.length)
    return (
      <EmptyState
        icon={<Icon name="success" />}
        title="Nothing to answer"
        description={`When ${agent.name} can't find an answer in its knowledge, the question shows up here.`}
      />
    );
  return (
    <ul className="flex flex-col gap-3">
      {gaps.data.map((g) => (
        <GapRow key={g.id} gap={g} canManage={canManage} />
      ))}
    </ul>
  );
}

function GapRow({ gap, canManage }: { gap: Gap; canManage: boolean }) {
  const { answer, dismiss } = useGapActions();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(gap.question);
  const [text, setText] = useState("");
  const busy = answer.isPending || dismiss.isPending;
  return (
    <li>
      <Panel className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">“{gap.question}”</span>
            <span className="text-[13px] text-muted-foreground">
              {new Date(gap.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              {gap.conversationId ? (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    href={`/conversations?view=all&c=${gap.conversationId}`}
                    className="text-primary hover:underline"
                  >
                    Open the chat
                  </Link>
                </>
              ) : null}
            </span>
          </div>
          {canManage && !open ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismiss.mutate(gap.id)}>
                Dismiss
              </Button>
              <Button size="sm" onClick={() => setOpen(true)}>
                Add answer
              </Button>
            </div>
          ) : null}
        </div>
        {open ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              answer.mutate(
                { id: gap.id, question: question.trim(), answer: text.trim() },
                {
                  onSuccess: () => notify.success("Added to knowledge"),
                  onError: (err) => notify.error("Not added", { description: errorText(err) }),
                },
              );
            }}
          >
            <TextInput
              aria-label="Question"
              value={question}
              maxLength={500}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <TextArea
              aria-label="Answer"
              autoFocus
              value={text}
              minRows={3}
              maxLength={4000}
              placeholder="The answer customers should get"
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || text.trim().length < 1 || question.trim().length < 3}>
                {answer.isPending ? "Adding…" : "Add to knowledge"}
              </Button>
            </div>
          </form>
        ) : null}
      </Panel>
    </li>
  );
}
