"use client";

import { Icon } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Tag } from "@relay/ui/components/tag";
import { listTime, members } from "./format";
import type { ConversationDetail } from "./types";

type Props = { detail: ConversationDetail; open: boolean; onOpenChange: (open: boolean) => void };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children}</dd>
    </div>
  );
}

/** Customer (or group) details, in the right-hand working panel of the Board layout. */
export function DetailsPanel({ detail: d, open, onOpenChange }: Props) {
  const c = d.conversation;
  const isGroup = c.kind === "group";
  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      title={isGroup ? "Group details" : "Customer details"}
      width="sm"
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          {isGroup ? (
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon name="users" size="lg" />
            </span>
          ) : (
            <Person name={c.title} size="xl" className="size-12" />
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold">{c.title}</p>
            <p className="text-sm text-muted-foreground">
              {isGroup ? members(d.group?.participantCount ?? 0) : `First message ${listTime(c.createdAt)}`}
            </p>
          </div>
        </div>

        <dl className="flex flex-col divide-y">
          {!isGroup
            ? d.contact?.identities.map((i) => (
                <Row key={i.id} label={i.channelType === "whatsapp" ? "WhatsApp" : i.channelType}>
                  {i.phone
                    ? `+${i.phone.replace(/^\+/, "")}`
                    : i.username
                      ? `@${i.username}`
                      : (i.profileName ?? "Phone hidden")}
                </Row>
              ))
            : null}
          {!isGroup && d.contact?.identities[0]?.profileName ? (
            <Row label="Profile name">{d.contact.identities[0].profileName}</Row>
          ) : null}
          <Row label="Channel">{d.channel.name}</Row>
          <Row label="Branch">{d.branch?.name ?? "None"}</Row>
          <Row label="Handled by">{d.assignee?.name ?? "Unassigned"}</Row>
          <Row label="Status">{c.status === "open" ? "Open" : "Closed"}</Row>
          {c.lastInboundAt ? <Row label="Last message from them">{listTime(c.lastInboundAt)}</Row> : null}
          <Row label="Reply window">
            {c.windowOpen && c.windowExpiresAt
              ? `Open until ${new Date(c.windowExpiresAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
              : "Closed"}
          </Row>
        </dl>

        {isGroup && d.group ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Members</p>
              {d.group.status !== "active" ? (
                <Tag tone="warning" className="capitalize">
                  {d.group.status}
                </Tag>
              ) : null}
            </div>
            {d.group.description ? (
              <p className="text-sm text-muted-foreground">{d.group.description}</p>
            ) : null}
            <ul className="flex flex-col gap-1">
              {d.group.participants.map((p) => (
                <li key={p.identityId} className="flex items-center gap-2.5 py-1">
                  <Person name={p.name ?? p.phone ?? "?"} size="sm" decorative />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name ?? "Member"}</span>
                    {p.phone ? <span className="block text-xs text-muted-foreground">+{p.phone}</span> : null}
                  </span>
                  {p.status !== "active" ? (
                    <span className="text-xs text-muted-foreground">
                      {p.status === "left" ? "Left" : "Removed"}
                    </span>
                  ) : null}
                </li>
              ))}
              {!d.group.participants.length ? (
                <li className="text-sm text-muted-foreground">
                  No one has joined yet. Share the invite link.
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>
    </SidePanel>
  );
}
