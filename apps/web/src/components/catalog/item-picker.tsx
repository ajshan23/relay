"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { SearchInput, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Checkbox } from "@relay/ui/ui/checkbox";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { mediaUrl } from "./items-view";

/*
 * Send items from the inbox: search the branch's catalogue, tick up to 10, add a line, and they go out
 * as the AI agent would send them (a card with the main photo, a carousel, or a list), with buttons
 * the customer can tap for more photos or to order.
 */

type Card = {
  id: string;
  title: string;
  priceText: string | null;
  primaryMediaId: string | null;
  details: string[];
};

export function ItemPicker({
  conversationId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const branch = useBranch().branch.id;
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<Card[]>([]);
  const [text, setText] = useState("");
  const results = useQuery({
    queryKey: ["catalog", branch, "picker", q],
    queryFn: () =>
      api<{ items: Card[] }>(inBranch(`/catalog/search?limit=20&q=${encodeURIComponent(q)}`, branch)).then(
        (r) => r.items,
      ),
    enabled: open && !!branch,
    staleTime: 15_000,
  });
  const send = useMutation({
    mutationFn: () =>
      api(`/conversations/${conversationId}/send-items`, {
        method: "POST",
        json: { itemIds: chosen.map((c) => c.id), text: text.trim() || undefined },
      }),
    onSuccess: () => {
      notify.success(chosen.length === 1 ? "Item sent" : `${chosen.length} items sent`);
      qc.invalidateQueries({ queryKey: ["inbox", "messages", conversationId] });
      setChosen([]);
      setText("");
      onOpenChange(false);
    },
    onError: (err) =>
      notify.error("Not sent", { description: err instanceof ApiError ? err.message : undefined }),
  });
  const toggle = (card: Card) =>
    setChosen((cur) =>
      cur.some((c) => c.id === card.id)
        ? cur.filter((c) => c.id !== card.id)
        : cur.length >= 10
          ? cur
          : [...cur, card],
    );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Send items"
      description="Up to 10. They arrive with their photo, price and buttons."
    >
      <div className="flex flex-col gap-3">
        <SearchInput onSearch={setQ} placeholder="Search your catalogue" aria-label="Search items" />
        <div className="max-h-80 overflow-y-auto rounded-md border">
          {results.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : results.data?.length ? (
            <ul className="divide-y">
              {results.data.map((card) => {
                const on = chosen.some((c) => c.id === card.id);
                return (
                  <li key={card.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent">
                      <Checkbox
                        checked={on}
                        onCheckedChange={() => toggle(card)}
                        disabled={!on && chosen.length >= 10}
                      />
                      {card.primaryMediaId ? (
                        // biome-ignore lint/performance/noImgElement: served by our API with auth cookies
                        <img
                          src={mediaUrl(branch, card.primaryMediaId, true)}
                          alt=""
                          className="size-9 rounded object-cover"
                        />
                      ) : (
                        <span className="flex size-9 items-center justify-center rounded bg-muted text-muted-foreground">
                          <Icon name="image" size="sm" />
                        </span>
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{card.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[card.priceText ?? "Price on request", card.details[0]]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              size="sm"
              icon={<Icon name="tag" />}
              title={q ? "Nothing matches" : "No items yet"}
              description={q ? "Try other words." : "Add items under AI agent → Catalogue."}
            />
          )}
        </div>
        <TextInput
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="A line to go with them (optional)"
          aria-label="Message"
        />
      </div>
      <ModalActions>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={!chosen.length || send.isPending} onClick={() => send.mutate()}>
          Send {chosen.length ? chosen.length : ""} {chosen.length === 1 ? "item" : "items"}
        </Button>
      </ModalActions>
    </Modal>
  );
}
