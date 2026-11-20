"use client";

import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { Person } from "@relay/ui/components/person";
import { SelectField } from "@relay/ui/components/select-field";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Input } from "@relay/ui/ui/input";
import { Label } from "@relay/ui/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useContacts } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { keys, useChannels } from "./queries";
import type { ChannelSummary } from "./types";

/*
 * Starting a chat from Relay. The server finds or creates the contact, their WhatsApp identity and the
 * chat (an existing chat is reused), then the chat opens; its composer sends the first message, which
 * outside WhatsApp's 24-hour window has to be a template.
 */

/** WhatsApp numbers this branch can start chats from (none when their role can't start chats). */
export function useBranchNumbers() {
  const { branch } = useBranch();
  const { can } = useMe();
  const canStart = can("chats.start", branch.id);
  const channels = useChannels();
  const numbers = useMemo(
    () =>
      (channels.data ?? []).filter(
        (c: ChannelSummary) =>
          canStart && c.type === "whatsapp" && c.status === "active" && c.branchId === branch.id,
      ),
    [channels.data, branch.id, canStart],
  );
  return { numbers, loading: channels.isPending };
}

/** Opens (finding or creating) a chat and goes to it in the inbox. */
export function useStartConversation() {
  const { branch } = useBranch();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const start = async (input: {
    channelAccountId: string;
    contactId?: string;
    phone?: string;
    name?: string;
  }) => {
    setBusy(true);
    try {
      const res = await api<{ conversationId: string; created: boolean }>(
        `/conversations/start?branch=${encodeURIComponent(branch.id)}`,
        { method: "POST", json: input },
      );
      void qc.invalidateQueries({ queryKey: keys.all });
      router.push(`/conversations?view=all&c=${res.conversationId}`);
      return true;
    } catch (err) {
      notify.error("Couldn't start the chat", {
        description: err instanceof ApiError ? err.message : undefined,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { start, busy };
}

const phoneDigits = (s: string) => s.replace(/[^\d]/g, "");
const looksLikePhone = (s: string) => /^\+?[\d\s()-]{8,}$/.test(s.trim()) && phoneDigits(s).length >= 8;

export function NewConversationDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { branch } = useBranch();
  const { numbers, loading } = useBranchNumbers();
  const { start, busy } = useStartConversation();
  const [channelId, setChannelId] = useState<string>("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    // A number is searched by its digits, so "+91 98470" finds 9198470…
    const text = query.trim();
    const q = /^\+?[\d\s()-]+$/.test(text) ? phoneDigits(text) : text;
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (!channelId && numbers[0]) setChannelId(numbers[0].id);
  }, [numbers, channelId]);

  const contacts = useContacts({
    filter: { match: "all", rules: [] },
    sort: { field: "lastMessageAt", dir: "desc" },
    q: debounced,
    page: 1,
    pageSize: 6,
  });
  const typedPhone = looksLikePhone(query) ? phoneDigits(query) : null;
  // The search is fuzzy; a contact with exactly the typed number comes first.
  const rows = open
    ? [...(contacts.data?.contacts ?? [])].sort(
        (a, b) => Number(b.phone === typedPhone) - Number(a.phone === typedPhone),
      )
    : [];

  const go = async (input: { contactId?: string; phone?: string }) => {
    if (!channelId) return;
    if (await start({ channelAccountId: channelId, ...input })) onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New conversation"
      description={`Message someone on WhatsApp from ${branch.name}.`}
      size="md"
      footer={
        <ModalActions>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </ModalActions>
      }
    >
      <div className="flex flex-col gap-4 px-6 pb-5">
        {!loading && !numbers.length ? (
          <p className="text-sm text-muted-foreground">
            This branch has no active WhatsApp number. Connect one in Settings → Channels.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <Label htmlFor="new-chat-from">Send from</Label>
              <SelectField
                id="new-chat-from"
                aria-label="WhatsApp number to send from"
                value={channelId}
                onValueChange={setChannelId}
                options={numbers.map((n) => ({
                  value: n.id,
                  label: `${n.displayName}${n.displayPhone ? ` · ${n.displayPhone}` : ""}`,
                }))}
              />
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <Label htmlFor="new-chat-to">To</Label>
              <Input
                id="new-chat-to"
                autoFocus
                placeholder="Search a contact, or type a number with country code"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && typedPhone) void go({ phone: typedPhone });
                }}
              />
            </div>
            <div className="-mx-2 flex flex-col">
              {typedPhone ? (
                <button
                  type="button"
                  disabled={busy || !channelId}
                  onClick={() => void go({ phone: typedPhone })}
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span className="inline-flex size-8 items-center justify-center rounded-full bg-muted">
                    <Icon name="phone" size="sm" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-medium">Message +{typedPhone}</span>
                    <span className="text-xs text-muted-foreground">
                      Adds them as a contact in {branch.name} if they aren't one yet
                    </span>
                  </span>
                </button>
              ) : null}
              {rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={busy || !channelId}
                  onClick={() => void go({ contactId: r.id })}
                  className="flex items-center gap-3 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <Person name={r.name ?? r.phone ?? "Contact"} size="sm" decorative />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {r.name ?? (r.phone ? `+${r.phone}` : "Unnamed contact")}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {r.phone
                        ? `+${r.phone}`
                        : r.channels.find((ch) => ch.username)?.username
                          ? `@${r.channels.find((ch) => ch.username)?.username}`
                          : "No phone number"}
                    </span>
                  </span>
                </button>
              ))}
              {!typedPhone && !rows.length && debounced ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No contact matches “{debounced}”. Type their number with the country code instead.
                </p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              WhatsApp lets businesses start a chat with an approved template. Once they reply, you can write
              freely for 24 hours.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
