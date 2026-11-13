"use client";

import { EmptyState } from "@relay/ui/components/empty-state";
import { Icon } from "@relay/ui/components/icon";
import { Panel, Section } from "@relay/ui/components/section";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
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
import type { ChannelSummary } from "@/components/inbox/types";
import { ApiError, api } from "@/lib/api";
import { useMe } from "@/lib/me";

/**
 * Settings → Channels: the business's connected channels and what customers see from each. For now one
 * choice: whether customers see blue ticks and "typing…" when the team reads and answers them.
 */
export function ChannelsSettings() {
  const { canManageOrg } = useMe();
  const channels = useChannels();
  const qc = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);

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

  return (
    <Section
      title="Channels"
      description="The numbers and accounts your customers message. Changes apply to everyone in the business."
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
          description="Connect a WhatsApp number to start talking to customers here."
        />
      ) : (
        <Panel padding="none">
          <ItemGroup>
            {channels.data.map((ch, i) => {
              const on = ch.settings?.readReceipts !== false;
              const can = ch.canShowRead !== false;
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
                        {ch.status !== "active" ? <Tag tone="danger">{ch.status}</Tag> : null}
                      </ItemTitle>
                      <ItemDescription>{ch.displayPhone ?? ch.type}</ItemDescription>
                    </ItemContent>
                    <ItemActions className="basis-full sm:basis-auto">
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
                    </ItemActions>
                  </Item>
                </Fragment>
              );
            })}
          </ItemGroup>
        </Panel>
      )}
      {!canManageOrg ? (
        <p className="text-xs text-muted-foreground">Only owners and admins can change channel settings.</p>
      ) : null}
    </Section>
  );
}
