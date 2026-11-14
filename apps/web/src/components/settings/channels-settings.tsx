"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@relay/ui/ui/item";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { channelIcon } from "@/components/inbox/conversation-list";
import { keys, useChannels } from "@/components/inbox/queries";
import type { ChannelMeta, ChannelSummary } from "@/components/inbox/types";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/me";
import { useConnectWhatsApp } from "./connect-whatsapp";

/**
 * Settings → Channels: the business's connected channels. Owners and admins connect a WhatsApp number
 * here (Meta's Embedded Signup; it belongs to the branch they're working in), finish a setup Meta
 * didn't complete, reconnect, disconnect, and choose what customers see from each channel.
 */

const statusTag: Record<string, { label: string; tone: "warning" | "danger" | "plain" }> = {
  setting_up: { label: "Setting up", tone: "warning" },
  error: { label: "Needs attention", tone: "danger" },
  disconnected: { label: "Disconnected", tone: "plain" },
};

const limitLabel = (v: ChannelMeta["messagingLimit"]) => {
  if (v === undefined || v === null) return null;
  if (v === -1 || v === "TIER_UNLIMITED" || v === "UNLIMITED") return "Unlimited a day";
  const n =
    typeof v === "number"
      ? v
      : Number(
          String(v)
            .replace(/\D/g, "")
            .replace(/^(\d+)K$/, "$1000"),
        );
  const tier = typeof v === "string" ? v.match(/TIER_(\d+)(K?)/) : null;
  const people = tier ? Number(tier[1]) * (tier[2] ? 1000 : 1) : n;
  return Number.isFinite(people) && people > 0 ? `${people.toLocaleString()} people a day` : null;
};

const syncWords: Record<string, string> = {
  pending: "waiting",
  requested: "asked Meta",
  importing: "copying",
  done: "done",
  declined: "not shared by the business",
  expired: "not available (more than 24 hours)",
  failed: "failed",
};

/** One-line facts under a WhatsApp number: quality, limit, name review, coexistence copy progress. */
function whatsappFacts(meta: ChannelMeta | undefined) {
  if (!meta) return [];
  const facts: string[] = [];
  const quality = meta.qualityRating ?? meta.qualityFlag;
  if (quality && quality !== "UNKNOWN") facts.push(`Quality ${quality.toLowerCase()}`);
  const limit = limitLabel(meta.messagingLimit);
  if (limit) facts.push(limit);
  if (meta.nameStatus && meta.nameStatus !== "APPROVED" && meta.nameStatus !== "AVAILABLE_WITHOUT_REVIEW")
    facts.push(`Display name ${meta.nameStatus.toLowerCase().replaceAll("_", " ")}`);
  if (meta.username) facts.push(`@${meta.username}`);
  if (meta.onboarding?.coexistence) facts.push("Also on the WhatsApp Business app");
  return facts;
}

function CoexistenceProgress({ meta }: { meta: ChannelMeta | undefined }) {
  const c = meta?.coexistence;
  if (!meta?.onboarding?.coexistence || !c) return null;
  const contacts = c.contacts?.status ?? "pending";
  const history = c.history?.status ?? "pending";
  if (contacts === "done" && history === "done") return null;
  const historyText =
    history === "importing" && typeof c.history?.progress === "number"
      ? `copying ${c.history.progress}%`
      : (syncWords[history] ?? history);
  return (
    <span className="block text-xs text-muted-foreground">
      From the phone app: contacts {syncWords[contacts] ?? contacts}, chats {historyText}
    </span>
  );
}

export function ChannelsSettings() {
  const { canManageOrg } = useMe();
  const { branch } = useBranch();
  const channels = useChannels();
  const qc = useQueryClient();
  const [confirm, confirmDialog] = useConfirm();
  const connect = useConnectWhatsApp();
  const [saving, setSaving] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: keys.channels() });

  const setReadReceipts = async (ch: ChannelSummary, on: boolean) => {
    setSaving(ch.id);
    // Show the change at once; put it back if the server says no.
    const put = (value: boolean) =>
      qc.setQueryData<ChannelSummary[]>(keys.channels(), (list) =>
        list?.map((c) => (c.id === ch.id ? { ...c, settings: { ...c.settings, readReceipts: value } } : c)),
      );
    put(on);
    try {
      await api(`/channels/${ch.id}`, { method: "PATCH", json: { settings: { readReceipts: on } } });
      notify.success(on ? "Customers will see when you've read and are typing" : "Read receipts turned off", {
        description: ch.displayName,
      });
    } catch (err) {
      put(!on);
      notify.error("Couldn't save that", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSaving(null);
    }
  };

  const finishSetup = async (ch: ChannelSummary) => {
    setSaving(ch.id);
    try {
      const res = await api<{ setupError: string | null }>(`/channels/${ch.id}/finish-setup`, {
        method: "POST",
      });
      if (res.setupError) notify.error("Not finished yet", { description: res.setupError });
      else notify.success("WhatsApp is ready", { description: ch.displayName });
    } catch (err) {
      notify.error("Couldn't finish setup", {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setSaving(null);
      void refresh();
    }
  };

  const disconnect = async (ch: ChannelSummary) => {
    const ok = await confirm({
      title: `Disconnect ${ch.displayName}?`,
      description:
        "Relay stops sending and receiving on this number. Conversations and contacts stay. You can reconnect it later.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/channels/${ch.id}`, { method: "DELETE" });
      notify.success("Disconnected", { description: ch.displayName });
    } catch (err) {
      notify.error("Couldn't disconnect", { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      void refresh();
    }
  };

  const connectButton =
    canManageOrg && connect.available ? (
      <Button onClick={() => connect.start()} disabled={connect.loading || connect.busy}>
        <Icon name="whatsapp" />
        Connect WhatsApp
      </Button>
    ) : null;

  return (
    <Section
      title="Channels"
      description={`The numbers and accounts your customers message. New numbers are connected to ${branch.name}.`}
      actions={channels.data?.length ? connectButton : null}
    >
      {channels.isPending ? (
        <Panel padding="none">
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </Panel>
      ) : !channels.data?.length ? (
        <EmptyState
          icon="message"
          title="No channels yet"
          description="Connect your WhatsApp number to start talking to customers here. You can keep using the WhatsApp Business app on your phone."
          action={connectButton}
        />
      ) : (
        <Panel padding="none">
          <ItemGroup>
            {channels.data.map((ch, i) => {
              const on = ch.settings?.readReceipts !== false;
              const can = ch.canShowRead !== false;
              const tag = statusTag[ch.status];
              const meta = ch.providerMeta;
              const facts = ch.type === "whatsapp" ? whatsappFacts(meta) : [];
              const viaSignup = meta?.onboarding?.method === "embedded_signup";
              return (
                <Fragment key={ch.id}>
                  {i > 0 ? <ItemSeparator /> : null}
                  <Item className="flex-wrap gap-y-3 px-4 py-3">
                    <ItemMedia variant="icon">
                      <Icon name={channelIcon(ch.type)} size="sm" />
                    </ItemMedia>
                    <ItemContent className="min-w-48">
                      <ItemTitle>
                        {ch.displayName}
                        {tag ? <Tag tone={tag.tone}>{tag.label}</Tag> : null}
                      </ItemTitle>
                      <ItemDescription>
                        {ch.displayPhone ?? ch.type}
                        {facts.length ? ` · ${facts.join(" · ")}` : ""}
                      </ItemDescription>
                      {ch.status !== "active" && ch.statusReason ? (
                        <span className="block text-xs text-muted-foreground">{ch.statusReason}</span>
                      ) : null}
                      <CoexistenceProgress meta={meta} />
                    </ItemContent>
                    <ItemActions className="basis-full flex-wrap justify-end sm:basis-auto">
                      {canManageOrg && ch.status === "setting_up" ? (
                        <Button size="sm" onClick={() => void finishSetup(ch)} disabled={saving === ch.id}>
                          Finish setup
                        </Button>
                      ) : null}
                      {canManageOrg &&
                      ch.type === "whatsapp" &&
                      connect.available &&
                      (ch.status !== "active" || viaSignup) ? (
                        <Button
                          size="sm"
                          variant={ch.status === "active" ? "ghost" : "outline"}
                          onClick={() => connect.start(ch.id)}
                          disabled={connect.loading || connect.busy}
                        >
                          Reconnect
                        </Button>
                      ) : null}
                      {ch.status === "active" ? (
                        <label className="flex max-w-sm items-start gap-3">
                          <span className="min-w-0 text-right">
                            <span className="block text-sm font-medium">
                              Show customers when you've read and are typing
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {!can
                                ? "Not available on this channel"
                                : on
                                  ? 'Blue ticks when someone opens their message, and "typing…" while you reply.'
                                  : 'Customers won\'t see blue ticks or "typing…" from your team.'}
                            </span>
                          </span>
                          <Switch
                            checked={can && on}
                            disabled={!can || !canManageOrg || saving === ch.id}
                            onCheckedChange={(v) => void setReadReceipts(ch, v)}
                            aria-label={`Read receipts and typing on ${ch.displayName}`}
                          />
                        </label>
                      ) : null}
                      {canManageOrg && ch.status !== "disconnected" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => void disconnect(ch)}
                          aria-label={`Disconnect ${ch.displayName}`}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </ItemGroup>
        </Panel>
      )}
      {!canManageOrg ? (
        <p className="text-xs text-muted-foreground">
          Only owners and admins can connect and change channels.
        </p>
      ) : null}
      {connect.dialog}
      {confirmDialog}
    </Section>
  );
}
