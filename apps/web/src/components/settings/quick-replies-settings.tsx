"use client";

import { quickReplyPlaceholders } from "@relay/core/quick-replies";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { FieldGroup, FormActions } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useMemo, useState } from "react";
import { z } from "zod";
import { type QuickReply, useQuickReplies, useQuickReplyActions } from "@/components/quick-replies/queries";
import { useBranch } from "@/components/shell/branch-context";
import { errorText } from "./words";

const col = createDataTableColumns<QuickReply>();
const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

const schema = z.object({
  shortcut: z
    .string()
    .trim()
    .min(1, "Give it a shortcut")
    .max(30, "Keep it under 30 characters")
    .regex(/^\/?[\p{L}\p{N}_-]+$/u, "Letters, numbers, - and _ only, no spaces"),
  title: z.string().trim().min(1, "Give it a title").max(80),
  body: z.string().trim().min(1, "Write the reply").max(4096),
  scope: z.enum(["business", "branch"]),
});

/**
 * Settings → Quick replies: saved answers agents insert by typing "/" and the shortcut in the reply
 * box, for the whole business or the selected branch. For now anyone who can reply manages them.
 */
export function QuickRepliesSettings() {
  const { branch } = useBranch();
  const list = useQuickReplies();
  const actions = useQuickReplyActions();
  const [confirm, confirmElement] = useConfirm();
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [open, setOpen] = useState(false);

  const add = () => {
    setEditing(null);
    setOpen(true);
  };

  const columns = useMemo(
    () => [
      col.accessor("shortcut", {
        header: "Shortcut",
        cell: (info) => <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/{info.getValue()}</code>,
      }),
      col.accessor("title", {
        header: "Reply",
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{row.original.title}</span>
            <span className="max-w-md truncate text-xs text-muted-foreground">{row.original.body}</span>
          </span>
        ),
      }),
      col.accessor("branchId", {
        header: "For",
        enableSorting: false,
        cell: (info) =>
          info.getValue() ? (
            <Tag size="sm">{branch.name}</Tag>
          ) : (
            <Tag size="sm" tone="primary">
              Whole business
            </Tag>
          ),
      }),
      col.accessor("updatedAt", {
        header: "Updated",
        cell: (info) => (
          <span className="text-muted-foreground">{day.format(new Date(info.getValue()))}</span>
        ),
      }),
      col.display({
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-0.5">
            <IconButton
              icon="edit"
              size="sm"
              label={`Edit /${row.original.shortcut}`}
              onClick={() => {
                setEditing(row.original);
                setOpen(true);
              }}
            />
            <IconButton
              icon="delete"
              size="sm"
              label={`Delete /${row.original.shortcut}`}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete /${row.original.shortcut}?`,
                  description:
                    "Nobody will be able to insert it any more. Messages already sent stay as they are.",
                  confirmLabel: "Delete",
                  tone: "danger",
                });
                if (!ok) return;
                actions.remove.mutate(row.original.id, {
                  onSuccess: () => notify.success("Quick reply deleted"),
                  onError: (err) => notify.error("Couldn't delete it", { description: errorText(err) }),
                });
              }}
            />
          </div>
        ),
      }),
    ],
    [branch.name, actions.remove, confirm],
  );

  const addButton = (
    <Button size="sm" onClick={add}>
      <Icon name="add" />
      New quick reply
    </Button>
  );

  return (
    <Section
      title="Quick replies"
      description='Answers you send often. Type "/" in the reply box to insert one.'
      actions={addButton}
    >
      {confirmElement}
      <DataTable
        aria-label="Quick replies"
        columns={columns}
        data={list.data ?? []}
        loading={list.isPending}
        getRowId={(r) => r.id}
        empty={
          <EmptyState
            icon={<Icon name="zap" />}
            title="No quick replies yet"
            description="Save the answers your team types every day, like opening hours or how to book."
            action={addButton}
          />
        }
      />
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={editing ? "Edit quick reply" : "New quick reply"}
        description="Placeholders are filled in with the customer's and your details when you insert it."
      >
        <QuickReplyForm
          reply={editing}
          branchName={branch.name}
          branchId={branch.id}
          onDone={() => setOpen(false)}
        />
      </Modal>
    </Section>
  );
}

function QuickReplyForm({
  reply,
  branchId,
  branchName,
  onDone,
}: {
  reply: QuickReply | null;
  branchId: string;
  branchName: string;
  onDone: () => void;
}) {
  const actions = useQuickReplyActions();
  const form = useZodForm(schema, {
    defaultValues: {
      shortcut: reply?.shortcut ?? "",
      title: reply?.title ?? "",
      body: reply?.body ?? "",
      scope: reply && !reply.branchId ? "business" : reply ? "branch" : "business",
    },
  });
  return (
    <Form
      form={form}
      onSubmit={async (v) => {
        try {
          await actions.save.mutateAsync({
            id: reply?.id,
            shortcut: v.shortcut.replace(/^\/+/, ""),
            title: v.title,
            body: v.body,
            branchId: v.scope === "branch" ? branchId : null,
          });
          notify.success(reply ? "Quick reply saved" : "Quick reply added");
          onDone();
        } catch (err) {
          throw new Error(errorText(err));
        }
      }}
    >
      <FieldGroup>
        <FormField
          control={form.control}
          name="shortcut"
          label="Shortcut"
          hint='Type "/" and this in the reply box, e.g. /timings'
          required
        >
          {({ field, control }) => (
            <TextInput {...field} {...control} placeholder="timings" autoComplete="off" autoFocus />
          )}
        </FormField>
        <FormField control={form.control} name="title" label="Title" required>
          {({ field, control }) => <TextInput {...field} {...control} placeholder="Opening hours" />}
        </FormField>
        <FormField control={form.control} name="body" label="Reply" required>
          {({ field, control }) => (
            <div className="flex flex-col gap-2">
              <TextArea
                {...field}
                {...control}
                minRows={4}
                maxRows={10}
                placeholder="Hi {first_name}, we're open 9 am to 9 pm every day."
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Insert:</span>
                {quickReplyPlaceholders.map((p) => (
                  <Button
                    key={p.key}
                    type="button"
                    variant="outline"
                    size="xs"
                    title={p.label}
                    onClick={() =>
                      form.setValue("body", `${field.value ?? ""}{${p.key}}`, { shouldDirty: true })
                    }
                  >
                    {`{${p.key}}`}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </FormField>
        <FormField control={form.control} name="scope" label="Who can use it">
          {({ field, control }) => (
            <SelectField
              {...control}
              ref={field.ref}
              value={field.value}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              options={[
                { value: "business", label: "Everyone in the business" },
                { value: "branch", label: `Only ${branchName}` },
              ]}
            />
          )}
        </FormField>
        <FormError />
        <FormActions>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit">{reply ? "Save changes" : "Add quick reply"}</Button>
        </FormActions>
      </FieldGroup>
    </Form>
  );
}
