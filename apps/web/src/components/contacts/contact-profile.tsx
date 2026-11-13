"use client";

import type { ContactFieldDef } from "@relay/core/contacts";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { Icon } from "@relay/ui/components/icon";
import { Person } from "@relay/ui/components/person";
import { SidePanel } from "@relay/ui/components/side-panel";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Textarea } from "@relay/ui/ui/textarea";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { channelIcon } from "@/components/inbox/conversation-list";
import { listTime } from "@/components/inbox/format";
import { ApiError } from "@/lib/api";
import { EditableCell, FieldEditor, FieldValue, TagChips } from "./cells";
import { MarketingEditor } from "./marketing";
import { type ContactPatch, type ContactsMeta, useContact, useContactActions } from "./queries";
import { TagPicker } from "./tag-picker";

const textField = (key: string, label: string, type: ContactFieldDef["type"] = "text"): ContactFieldDef => ({
  id: key,
  key,
  label,
  type,
  options: [],
  position: 0,
});

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3 py-0.5">
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Block({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const fullDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const sourceLabel: Record<string, string> = {
  channel: "Wrote in",
  manual: "Added by hand",
  import: "Imported",
};

/** Everything about one contact, beside the table. Every value edits in place. */
export function ContactProfile({
  id,
  meta,
  onClose,
}: {
  id: string | null;
  meta: ContactsMeta;
  onClose: () => void;
}) {
  const detail = useContact(id);
  const actions = useContactActions();
  const [confirm, confirmElement] = useConfirm();
  const [note, setNote] = useState("");
  const d = detail.data;
  const c = d?.contact;
  const canEdit = meta.canEdit;

  const save = (patch: ContactPatch, done?: () => void) => {
    if (!c) return;
    actions.update.mutate(
      { id: c.id, patch },
      {
        onSuccess: () => done?.(),
        onError: (err) =>
          notify.error("Couldn't save that", {
            description: err instanceof ApiError ? err.message : undefined,
          }),
      },
    );
  };

  const title = c ? (c.name ?? (c.phone ? `+${c.phone}` : "Unnamed contact")) : "Contact";

  return (
    <SidePanel
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2.5">
          <Person name={title} size="md" decorative />
          <span className="min-w-0 truncate">{title}</span>
        </span>
      }
      width="md"
      footer={
        c && meta.canManage ? (
          <div className="flex justify-between">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${title}?`,
                  description:
                    "Their details, tags and notes are removed. Past conversations stay in the inbox.",
                  confirmLabel: "Delete contact",
                  tone: "danger",
                });
                if (ok)
                  actions.remove.mutate(c.id, {
                    onSuccess: () => {
                      notify.success("Contact deleted");
                      onClose();
                    },
                  });
              }}
            >
              <Icon name="delete" />
              Delete
            </Button>
          </div>
        ) : undefined
      }
    >
      {confirmElement}
      {!c || !d ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Block title="Details">
            <Row label="Name">
              <EditableCell
                canEdit={canEdit}
                label="name"
                display={<FieldValue field={textField("name", "Name")} value={c.name} />}
                editor={(close) => (
                  <FieldEditor
                    field={textField("name", "Name")}
                    value={c.name}
                    onSave={(v) => save({ name: (v as string) ?? null }, close)}
                  />
                )}
              />
            </Row>
            <Row label="Phone">
              <EditableCell
                canEdit={canEdit}
                label="phone"
                display={<FieldValue field={textField("phone", "Phone", "phone")} value={c.phone} />}
                editor={(close) => (
                  <FieldEditor
                    field={textField("phone", "Phone", "phone")}
                    value={c.phone ? `+${c.phone}` : null}
                    onSave={(v) => save({ phone: (v as string) ?? null }, close)}
                  />
                )}
              />
            </Row>
            <Row label="Email">
              <EditableCell
                canEdit={canEdit}
                label="email"
                display={<FieldValue field={textField("email", "Email", "email")} value={c.email} />}
                editor={(close) => (
                  <FieldEditor
                    field={textField("email", "Email", "email")}
                    value={c.email}
                    onSave={(v) => save({ email: (v as string) ?? null }, close)}
                  />
                )}
              />
            </Row>
            <Row label="Added">
              <span className="text-muted-foreground">
                {fullDate.format(new Date(c.createdAt))} · {sourceLabel[c.source] ?? c.source}
              </span>
            </Row>
          </Block>

          <Block title="Marketing">
            <MarketingEditor
              optOuts={d.optOuts.map((o) => o.channelAccountId)}
              sources={d.optOuts}
              channels={meta.channels}
              canEdit={canEdit}
              onChange={(channelAccountId, optedOut) => save({ optOut: { channelAccountId, optedOut } })}
            />
          </Block>

          <Block title="Channels">
            {d.identities.length ? (
              d.identities.map((i) => (
                <div key={i.id} className="flex items-center gap-2">
                  <Icon name={channelIcon(i.channelType)} size="sm" className="text-muted-foreground" />
                  <span className="truncate">
                    {i.phone
                      ? `+${i.phone}`
                      : i.username
                        ? `@${i.username}`
                        : (i.profileName ?? i.channelType)}
                  </span>
                  {i.profileName && (i.phone || i.username) ? (
                    <span className="truncate text-muted-foreground">{i.profileName}</span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="text-muted-foreground">Hasn't written in yet.</p>
            )}
          </Block>

          <Block title="Tags">
            <EditableCell
              canEdit={canEdit}
              label="tags"
              display={<TagChips ids={c.tagIds} tags={meta.tags} />}
              editor={() => (
                <TagPicker tags={meta.tags} value={c.tagIds} onChange={(tagIds) => save({ tagIds })} />
              )}
            />
          </Block>

          {meta.fields.length ? (
            <Block title="Fields">
              {meta.fields.map((f) => (
                <Row key={f.id} label={f.label}>
                  <EditableCell
                    canEdit={canEdit}
                    label={f.label}
                    display={<FieldValue field={f} value={c.attributes[f.key]} />}
                    editor={(close) => (
                      <FieldEditor
                        field={f}
                        value={c.attributes[f.key]}
                        onSave={(v) =>
                          save({ attributes: { [f.key]: v } }, f.type === "multi_select" ? undefined : close)
                        }
                      />
                    )}
                  />
                </Row>
              ))}
            </Block>
          ) : null}

          <Block title="Notes">
            {canEdit ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!note.trim()) return;
                  actions.addNote.mutate({ id: c.id, body: note.trim() }, { onSuccess: () => setNote("") });
                }}
              >
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Write a note for your team"
                  aria-label="New note"
                  className="min-h-16"
                />
                {note.trim() ? (
                  <Button type="submit" size="sm" className="self-end" disabled={actions.addNote.isPending}>
                    Add note
                  </Button>
                ) : null}
              </form>
            ) : null}
            {d.notes.map((n) => (
              <div key={n.id} className="group rounded-md bg-muted/60 px-3 py-2">
                <p className="whitespace-pre-wrap">{n.body}</p>
                <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {n.authorName ?? "Someone"} · {listTime(n.createdAt)}
                  </span>
                  {canEdit ? (
                    <button
                      type="button"
                      aria-label="Delete note"
                      onClick={() => actions.deleteNote.mutate({ id: c.id, noteId: n.id })}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                    >
                      <Icon name="delete" size="xs" />
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {!d.notes.length && !canEdit ? <p className="text-muted-foreground">No notes.</p> : null}
          </Block>

          {d.lists.length ? (
            <Block title="Lists">
              <div className="flex flex-wrap gap-1">
                {d.lists.map((l) => (
                  <span key={l.id} className="rounded-md border px-1.5 text-xs leading-5">
                    {l.name}
                  </span>
                ))}
              </div>
            </Block>
          ) : null}

          <Block title="Conversations">
            {d.conversations.length ? (
              d.conversations.map((cv) => (
                <Link
                  key={cv.id}
                  href={`/conversations?view=all&c=${cv.id}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-muted"
                >
                  <span className="truncate">{cv.channelName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {cv.status === "open" ? "Open" : "Closed"}
                    {cv.lastMessageAt ? ` · ${listTime(cv.lastMessageAt)}` : ""}
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-muted-foreground">No conversations yet.</p>
            )}
          </Block>
        </div>
      )}
    </SidePanel>
  );
}
