"use client";

import { FilterPills, Segmented, SwitchRow } from "@relay/ui/components/choice";
import { ConfirmDialog, useConfirm } from "@relay/ui/components/confirm-dialog";
import { createDataTableColumns, DataTable } from "@relay/ui/components/data-table";
import { EmptyState } from "@relay/ui/components/empty-state";
import { FieldGroup, FormActions } from "@relay/ui/components/field";
import { Form, FormError, FormField, useZodForm } from "@relay/ui/components/form";
import { Icon, IconButton, type IconName, icons } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { PageHeader } from "@relay/ui/components/page-header";
import { AgentAvatar, Person, PersonStack } from "@relay/ui/components/person";
import { Panel, Section } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { SidePanel } from "@relay/ui/components/side-panel";
import { Stat, StatGroup } from "@relay/ui/components/stat";
import { StatusDot, Tag } from "@relay/ui/components/tag";
import { SearchInput, TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { useTheme } from "next-themes";
import { useState } from "react";
import { z } from "zod";

type Customer = { id: string; name: string; branch: string; stage: string; latest: string; who: string };
const customers: Customer[] = [
  { id: "1", name: "Asha Menon", branch: "Marina", stage: "Booked", latest: "Sat 11:00", who: "Mira" },
  {
    id: "2",
    name: "Daniel Okafor",
    branch: "Marina",
    stage: "Talking",
    latest: "Refund request",
    who: "Front desk",
  },
  { id: "3", name: "Rahul Verma", branch: "Marina", stage: "Booked", latest: "Mon 10:30", who: "Mira" },
  {
    id: "4",
    name: "Fatima Noor",
    branch: "Downtown",
    stage: "Visited",
    latest: "Invoice sent",
    who: "Priya",
  },
  { id: "5", name: "Leila Haddad", branch: "Marina", stage: "Booked", latest: "Wed 4:00", who: "Sameer" },
  {
    id: "6",
    name: "Tom Becker",
    branch: "Downtown",
    stage: "New enquiry",
    latest: "Asked a price",
    who: "Mira",
  },
  {
    id: "7",
    name: "Nora Aziz",
    branch: "Marina",
    stage: "New enquiry",
    latest: "Asked about braces",
    who: "Mira",
  },
];
const stageTone = { Booked: "good", Talking: "primary", "New enquiry": "ai", Visited: "plain" } as const;

const col = createDataTableColumns<Customer>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    cell: (i) => (
      <span className="flex items-center gap-2.5">
        <Person name={i.getValue()} size="sm" decorative />
        <span className="font-semibold">{i.getValue()}</span>
      </span>
    ),
  }),
  col.accessor("branch", { header: "Branch" }),
  col.accessor("stage", {
    header: "Stage",
    cell: (i) => (
      <Tag tone={stageTone[i.getValue() as keyof typeof stageTone] ?? "plain"}>{i.getValue()}</Tag>
    ),
  }),
  col.accessor("latest", { header: "Latest", enableSorting: false }),
  col.accessor("who", {
    header: "Handled by",
    cell: (i) => <Tag tone={i.getValue() === "Mira" ? "ai" : "plain"}>{i.getValue()}</Tag>,
  }),
]);

const schema = z.object({
  name: z.string().min(2, "Enter the branch name"),
  role: z.enum(["owner", "manager", "agent"]),
  note: z.string().max(200, "Keep it under 200 characters").optional(),
});

const someIcons: IconName[] = [
  "home",
  "conversations",
  "customers",
  "agent",
  "campaigns",
  "insights",
  "settings",
  "search",
  "add",
  "edit",
  "delete",
  "filter",
  "send",
  "attach",
  "sparkles",
  "branch",
  "whatsapp",
  "instagram",
  "website",
  "calendar",
  "alert",
  "check",
];

export function Showcase() {
  const { resolvedTheme, setTheme } = useTheme();
  const [modal, setModal] = useState(false);
  const [panel, setPanel] = useState(false);
  const [danger, setDanger] = useState(false);
  const [confirm, confirmElement] = useConfirm();
  const [period, setPeriod] = useState("day");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(0);
  const form = useZodForm(schema, { defaultValues: { name: "", role: "agent", note: "" } });

  return (
    <div className="min-h-screen bg-background">
      <PageHeader
        title="Design system"
        description={`Every common component, in FlowFlex ${resolvedTheme === "dark" ? "dark" : "light"}. ${Object.keys(icons).length} icons, one source.`}
        actions={
          <Button variant="outline" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
            <Icon name={resolvedTheme === "dark" ? "sun" : "moon"} />
            Switch to {resolvedTheme === "dark" ? "light" : "dark"}
          </Button>
        }
      />

      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 pb-16 sm:px-8">
        <Section title="Buttons" description="One primary action per view. Everything else is quieter.">
          <Panel className="flex flex-wrap items-center gap-2">
            <Button>Save changes</Button>
            <Button variant="outline">Cancel</Button>
            <Button variant="secondary">Send a test</Button>
            <Button variant="ghost">Later</Button>
            <Button variant="destructive">Delete branch</Button>
            <Button size="sm">Small</Button>
            <Button size="xs" variant="outline">
              Extra small
            </Button>
            <Button disabled>Disabled</Button>
            <IconButton icon="filter" label="Filter" />
            <IconButton icon="add" label="Add customer" variant="outline" />
            <IconButton icon="send" label="Send" variant="solid" />
          </Panel>
        </Section>

        <Section title="Icons" description="Pages use these names, never an icon library directly.">
          <Panel className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-11">
            {someIcons.map((name) => (
              <div key={name} className="flex flex-col items-center gap-1.5 text-center">
                <Icon name={name} size="lg" />
                <span className="text-xs text-muted-foreground">{name}</span>
              </div>
            ))}
          </Panel>
        </Section>

        <Section title="Tags, status and people" description="Violet-lilac always means the AI did it.">
          <Panel className="flex flex-wrap items-center gap-x-6 gap-y-4">
            <div className="flex flex-wrap gap-2">
              <Tag>Plain</Tag>
              <Tag tone="ai">Mira</Tag>
              <Tag tone="good">Booked</Tag>
              <Tag tone="danger">Needs a person</Tag>
              <Tag tone="warning">Waiting for approval</Tag>
              <Tag tone="primary">Marina</Tag>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-2">
                <StatusDot tone="ai" live />
                Mira is replying
              </span>
              <span className="flex items-center gap-2">
                <StatusDot tone="good" />
                All handled
              </span>
              <span className="flex items-center gap-2">
                <StatusDot tone="danger" />1 waiting
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Person name="Priya Shah" size="lg" />
              <Person name="Asha Menon" />
              <AgentAvatar name="Mira" />
              <PersonStack people={customers.slice(0, 5).map((c) => ({ name: c.name }))} />
            </div>
          </Panel>
        </Section>

        <Section title="Numbers">
          <StatGroup variant="strip">
            <Stat value="47" label="chats today" note="Up 12% on last Tuesday" trend="up" />
            <Stat value="89%" label="answered by Mira" note="5 went to your team" />
            <Stat value="1m 40s" label="to first reply" note="Target is under 5 minutes" trend="down" />
            <Stat value="9" label="appointments booked" note="About AED 3,150" />
          </StatGroup>
        </Section>

        <Section
          title="Table"
          description="Sorting, selection, paging, loading and empty states come with it."
        >
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput placeholder="Search by name or phone" wrapperClassName="w-full sm:w-72" />
            <FilterPills
              aria-label="Customer filter"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "Everyone", count: 7 },
                { value: "booked", label: "Booked", count: 3 },
                { value: "new", label: "New this week", count: 2 },
              ]}
            />
            <span className="ml-auto text-sm text-muted-foreground">{selected} selected</span>
          </div>
          <DataTable
            aria-label="Customers"
            columns={columns}
            data={customers}
            getRowId={(c) => c.id}
            selection="multi"
            onSelectionChange={(rows) => setSelected(rows.length)}
            onRowClick={() => setPanel(true)}
            pageSize={5}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <DataTable aria-label="Loading example" columns={columns} data={[]} loading pageSize={3} />
            <Panel padding="none">
              <EmptyState
                icon={<Icon name="customers" size="lg" />}
                title="No customers yet"
                description="They appear here as soon as someone messages you."
                action={<Button size="sm">Import customers</Button>}
              />
            </Panel>
          </div>
        </Section>

        <Section
          title="Forms"
          description="Labels, hints and errors are wired to the control. Try saving it empty."
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <Form
                form={form}
                onSubmit={async (values) => {
                  await new Promise((r) => setTimeout(r, 700));
                  notify.success(`Saved ${values.name}`);
                  form.reset();
                }}
              >
                <FieldGroup>
                  <FormField control={form.control} name="name" label="Branch name" required>
                    {({ field, control }) => <TextInput {...field} {...control} placeholder="Marina" />}
                  </FormField>
                  <FormField
                    control={form.control}
                    name="role"
                    label="Your role"
                    hint="Decides what you can change here."
                  >
                    {({ field, control }) => (
                      <SelectField
                        {...control}
                        ref={field.ref}
                        value={field.value}
                        onValueChange={field.onChange}
                        onBlur={field.onBlur}
                        options={[
                          { value: "owner", label: "Owner", description: "Everything, including billing" },
                          { value: "manager", label: "Manager", description: "Team and settings" },
                          { value: "agent", label: "Agent", description: "Reply to customers" },
                        ]}
                      />
                    )}
                  </FormField>
                  <FormField control={form.control} name="note" label="Note" optional>
                    {({ field, control }) => (
                      <TextArea {...field} {...control} placeholder="Anything the team should know" />
                    )}
                  </FormField>
                  <FormError />
                  <FormActions>
                    <Button type="button" variant="outline" onClick={() => form.reset()}>
                      Clear
                    </Button>
                    <Button type="submit">Save branch</Button>
                  </FormActions>
                </FieldGroup>
              </Form>
            </Panel>
            <Panel className="flex flex-col gap-5">
              <Segmented
                aria-label="Period"
                value={period}
                onChange={setPeriod}
                options={[
                  { value: "day", label: "Day" },
                  { value: "week", label: "Week" },
                  { value: "month", label: "Month" },
                ]}
              />
              <SwitchRow
                label="Mira answers on WhatsApp"
                description="Turn off to send every chat to your team."
                defaultChecked
              />
              <SwitchRow label="Mira answers on Instagram" description="Comments and direct messages." />
            </Panel>
          </div>
        </Section>

        <Section title="Modals, panels and messages">
          <Panel className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setModal(true)}>
              Open a modal
            </Button>
            <Button variant="outline" onClick={() => setPanel(true)}>
              Open a side panel
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Send to 412 customers?",
                    description: "Messages start going out at 5:00 pm.",
                    confirmLabel: "Send campaign",
                  })
                ) {
                  notify.success("Scheduled for 5:00 pm today");
                }
              }}
            >
              Ask to confirm
            </Button>
            <Button variant="outline" onClick={() => setDanger(true)}>
              Confirm something risky
            </Button>
            <Button variant="outline" onClick={() => notify.success("Marked as done")}>
              Success message
            </Button>
            <Button variant="outline" onClick={() => notify.error("Couldn't send the message")}>
              Error message
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                notify.promise(new Promise((r) => setTimeout(r, 1200)), {
                  loading: "Saving…",
                  success: "Saved",
                  error: "Couldn't save",
                })
              }
            >
              Saving message
            </Button>
          </Panel>
        </Section>
      </div>

      <Modal
        open={modal}
        onOpenChange={setModal}
        title="Add a branch"
        description="Each branch has its own conversations, customers and team."
        footer={
          <ModalActions>
            <Button variant="outline" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setModal(false);
                notify.success("Branch added");
              }}
            >
              Add branch
            </Button>
          </ModalActions>
        }
      >
        <FieldGroup>
          <TextInput aria-label="Branch name" placeholder="Branch name" />
          <TextInput aria-label="City" placeholder="City" />
        </FieldGroup>
      </Modal>

      <SidePanel
        open={panel}
        onOpenChange={setPanel}
        title="Asha Menon"
        description="Marina, reached on WhatsApp"
      >
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Tag tone="good">Booked</Tag>
            <Tag tone="ai">Mira</Tag>
          </div>
          <p className="text-sm text-muted-foreground">
            Next visit Saturday 11:00 with Dr. Rao. Prefers morning appointments.
          </p>
        </div>
      </SidePanel>

      <ConfirmDialog
        open={danger}
        onOpenChange={setDanger}
        title="Delete the Downtown branch?"
        description="Its conversations and customers are removed for everyone. This can't be undone."
        confirmLabel="Delete branch"
        tone="danger"
        onConfirm={() => {
          notify.info("Nothing was deleted. This is a demo.");
        }}
      />
      {confirmElement}
    </div>
  );
}
