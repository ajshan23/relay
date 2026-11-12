"use client";

import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { FieldGroup, FormActions } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { Person } from "@relay/ui/components/person";
import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import type { OrgRole } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/me";
import { listOrgMembers, type OrgMember } from "./org-members";
import { errorText, orgRoleLabel, orgRoleOptions, unwrap } from "./words";

type Invitation = {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
};

const memberCol = createDataTableColumns<OrgMember>();
const inviteCol = createDataTableColumns<Invitation>();

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function invitationLink(id: string) {
  return `${window.location.origin}/accept-invitation/${id}`;
}

async function listPendingInvitations(): Promise<Invitation[]> {
  const data = await unwrap(authClient.organization.listInvitations({ query: {} }));
  const now = Date.now();
  return (data ?? [])
    .filter((i) => i.status === "pending" && new Date(i.expiresAt).getTime() > now)
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: (i.role === "admin" || i.role === "owner" ? i.role : "member") as OrgRole,
      expiresAt: new Date(i.expiresAt),
    }));
}

/** Settings → Team: everyone in the business, their organization role, and pending invitations. */
export function TeamSettings() {
  const { me, canManageOrg, refresh } = useMe();
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [failed, setFailed] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmElement] = useConfirm();

  const loadMembers = useCallback(async () => {
    setFailed(false);
    try {
      setMembers(await listOrgMembers());
    } catch {
      setFailed(true);
    }
  }, []);

  const loadInvitations = useCallback(async () => {
    if (!canManageOrg) return;
    try {
      setInvitations(await listPendingInvitations());
    } catch {
      // Only owners and admins may list invitations; anything else just leaves the list empty.
      setInvitations([]);
    }
  }, [canManageOrg]);

  useEffect(() => {
    void loadMembers();
    void loadInvitations();
  }, [loadMembers, loadInvitations]);

  const changeRole = useCallback(
    async (member: OrgMember, role: "admin" | "member") => {
      if (role === member.role) return;
      setBusy(member.memberId);
      try {
        await unwrap(authClient.organization.updateMemberRole({ memberId: member.memberId, role }));
        notify.success(`${member.name} is now ${role === "admin" ? "an admin" : "a member"}`);
        await Promise.all([loadMembers(), refresh()]);
      } catch (err) {
        notify.error(errorText(err, "Couldn't change the role. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [loadMembers, refresh],
  );

  const remove = useCallback(
    async (member: OrgMember) => {
      const ok = await confirm({
        title: `Remove ${member.name} from the team?`,
        description:
          "They can't sign in to this business any more and lose every branch right away. Chats they handled are kept.",
        confirmLabel: "Remove from team",
        tone: "danger",
      });
      if (!ok) return;
      setBusy(member.memberId);
      try {
        await unwrap(authClient.organization.removeMember({ memberIdOrEmail: member.memberId }));
        notify.success(`${member.name} removed from the team`);
        await Promise.all([loadMembers(), refresh()]);
      } catch (err) {
        notify.error(errorText(err, "Couldn't remove them. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [confirm, loadMembers, refresh],
  );

  const cancelInvitation = useCallback(
    async (invitation: Invitation) => {
      setBusy(invitation.id);
      try {
        await unwrap(authClient.organization.cancelInvitation({ invitationId: invitation.id }));
        notify.success(`Invitation for ${invitation.email} cancelled`);
        await loadInvitations();
      } catch (err) {
        notify.error(errorText(err, "Couldn't cancel the invitation. Try again."));
      } finally {
        setBusy(null);
      }
    },
    [loadInvitations],
  );

  const myUserId = me.user.id;
  const memberColumns = useMemo(
    () =>
      memberCol.columns([
        memberCol.accessor("name", {
          header: "Person",
          cell: ({ row }) => {
            const m = row.original;
            return (
              <span className="flex min-w-0 items-center gap-2.5">
                <Person name={m.name} src={m.image ?? undefined} size="sm" decorative />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {m.name}
                    {m.userId === myUserId ? (
                      <span className="font-normal text-muted-foreground"> (you)</span>
                    ) : null}
                  </span>
                  <span className="truncate text-[13px] text-muted-foreground">{m.email}</span>
                </span>
              </span>
            );
          },
        }),
        memberCol.accessor("role", {
          header: "Role",
          cell: ({ row }) => {
            const m = row.original;
            const editable = canManageOrg && m.role !== "owner" && m.userId !== myUserId;
            if (!editable) {
              return (
                <Tag size="sm" tone={m.role === "member" ? "plain" : "primary"}>
                  {orgRoleLabel[m.role]}
                </Tag>
              );
            }
            return (
              <SelectField
                size="sm"
                aria-label={`Role for ${m.name}`}
                value={m.role === "admin" ? "admin" : "member"}
                options={orgRoleOptions}
                disabled={busy === m.memberId}
                onValueChange={(role) => void changeRole(m, role)}
                className="w-32"
              />
            );
          },
        }),
        memberCol.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const m = row.original;
            if (!canManageOrg || m.role === "owner" || m.userId === myUserId) return null;
            return (
              <div className="flex justify-end">
                <IconButton
                  icon="delete"
                  size="sm"
                  label={`Remove ${m.name} from the team`}
                  disabled={busy === m.memberId}
                  onClick={() => void remove(m)}
                />
              </div>
            );
          },
        }),
      ]),
    [busy, canManageOrg, changeRole, myUserId, remove],
  );

  const inviteColumns = useMemo(
    () =>
      inviteCol.columns([
        inviteCol.accessor("email", {
          header: "Email",
          cell: (info) => <span className="font-medium">{info.getValue()}</span>,
        }),
        inviteCol.accessor("role", {
          header: "Joins as",
          enableSorting: false,
          cell: (info) => <Tag size="sm">{orgRoleLabel[info.getValue()]}</Tag>,
        }),
        inviteCol.accessor("expiresAt", {
          header: "Link works until",
          cell: (info) => <span className="text-muted-foreground">{dateFormat.format(info.getValue())}</span>,
        }),
        inviteCol.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const inv = row.original;
            return (
              <div className="flex items-center justify-end gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(invitationLink(inv.id));
                      notify.success("Link copied");
                    } catch {
                      notify.error("Couldn't copy. Your browser blocked it.");
                    }
                  }}
                >
                  <Icon name="copy" size="sm" />
                  Copy link
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy === inv.id}
                  onClick={() => void cancelInvitation(inv)}
                >
                  Cancel
                </Button>
              </div>
            );
          },
        }),
      ]),
    [busy, cancelInvitation],
  );

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="People"
        description="Owners and admins reach every branch. Members only reach the branches they are added to."
        actions={
          canManageOrg ? (
            <Button onClick={() => setInviteOpen(true)}>
              <Icon name="addUser" />
              Invite someone
            </Button>
          ) : null
        }
      >
        {failed ? (
          <Panel padding="none">
            <EmptyState
              icon={<Icon name="alert" />}
              title="Couldn't load your team"
              description="Check your connection and try again."
              action={
                <Button variant="outline" onClick={() => void loadMembers()}>
                  Try again
                </Button>
              }
            />
          </Panel>
        ) : (
          <DataTable
            aria-label="Team"
            columns={memberColumns}
            data={members ?? []}
            loading={members === null}
            getRowId={(m) => m.memberId}
          />
        )}
      </Section>

      {canManageOrg && invitations.length > 0 ? (
        <Section
          title="Waiting to join"
          description="Invitation emails are not sent yet. Copy the link and send it to them yourself."
        >
          <DataTable
            aria-label="Waiting to join"
            density="compact"
            columns={inviteColumns}
            data={invitations}
            getRowId={(i) => i.id}
          />
        </Section>
      ) : null}

      <Modal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        size="sm"
        title="Invite someone"
        description="They join your business once they open the invitation link and sign in."
      >
        <InviteForm
          onCancel={() => setInviteOpen(false)}
          onInvited={async (email) => {
            notify.success(`Invitation ready for ${email}`, {
              description: "Copy the link under Waiting to join.",
            });
            setInviteOpen(false);
            await loadInvitations();
          }}
        />
      </Modal>

      {confirmElement}
    </div>
  );
}

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter an email address"),
  role: z.enum(["admin", "member"]),
});

function InviteForm({
  onCancel,
  onInvited,
}: {
  onCancel: () => void;
  onInvited: (email: string) => Promise<void>;
}) {
  const form = useZodForm(inviteSchema, { defaultValues: { email: "", role: "member" } });
  return (
    <Form
      form={form}
      onSubmit={async (values) => {
        await unwrap(authClient.organization.inviteMember({ email: values.email, role: values.role }));
        await onInvited(values.email);
      }}
    >
      <FieldGroup>
        <FormField control={form.control} name="email" label="Email" required>
          {({ field, control }) => (
            <TextInput
              {...field}
              {...control}
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              autoFocus
            />
          )}
        </FormField>
        <FormField
          control={form.control}
          name="role"
          label="Role"
          hint="You can add members to branches after they join."
        >
          {({ field, control }) => (
            <SelectField
              {...control}
              ref={field.ref}
              value={field.value}
              onValueChange={field.onChange}
              onBlur={field.onBlur}
              options={orgRoleOptions}
            />
          )}
        </FormField>
        <FormError />
        <FormActions>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Create invitation</Button>
        </FormActions>
      </FieldGroup>
    </Form>
  );
}
