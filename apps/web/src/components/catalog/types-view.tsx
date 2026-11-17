"use client";

import { fieldTypes } from "@relay/core/contacts";
import { CheckboxRow } from "@relay/ui/components/choice";
import { useConfirm } from "@relay/ui/components/confirm-dialog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import {
  type CatalogField,
  type CatalogOverview,
  type CatalogType,
  useCatalog,
  useCatalogActions,
} from "./queries";

/*
 * Catalogue → Types and fields: the kinds of things the business sells and the details each one has
 * (a Property has bedrooms and area; a Service has lengths). Shared by every branch.
 */

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";
const filterable = new Set(["number", "boolean", "select", "multi_select", "date"]);

/** The template cards: pick one to start a type with its fields. */
export function TypePicker({ overview, onDone }: { overview: CatalogOverview; onDone?: () => void }) {
  const actions = useCatalogActions();
  const used = new Set(overview.types.map((t) => t.template));
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {overview.templates.map((t) => (
        <button
          key={t.id}
          type="button"
          disabled={actions.createType.isPending}
          onClick={() =>
            actions.createType.mutate(
              { name: t.name, kind: t.kind, template: t.id },
              {
                onSuccess: () => {
                  notify.success(`${t.name} added`);
                  onDone?.();
                },
                onError: (err) => notify.error("Not added", { description: errorText(err) }),
              },
            )
          }
          className="flex flex-col gap-1.5 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
        >
          <span className="flex items-center gap-2 font-medium">
            {t.name}
            {used.has(t.id) ? (
              <Tag size="sm" tone="plain">
                Added
              </Tag>
            ) : null}
          </span>
          <span className="text-[13px] text-muted-foreground">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

export function TypesView() {
  const q = useCatalog();
  const [adding, setAdding] = useState(false);
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (!q.data)
    return (
      <EmptyState
        icon={<Icon name="alert" />}
        title="Couldn't load the types"
        description={errorText(q.error)}
        action={<Button onClick={() => q.refetch()}>Try again</Button>}
      />
    );
  const overview = q.data;
  return (
    <div className="flex flex-col gap-4">
      {overview.canManage ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Icon name="add" />
            New type
          </Button>
        </div>
      ) : null}
      {overview.types.length ? (
        overview.types.map((t) => <TypePanel key={t.id} type={t} canManage={overview.canManage} />)
      ) : (
        <EmptyState
          icon={<Icon name="tag" />}
          title="No types yet"
          description="A type is a kind of thing you sell, with its own details."
        />
      )}
      <Modal
        open={adding}
        onOpenChange={setAdding}
        size="xl"
        title="New type"
        description="Start from the closest one; you can rename it and change its fields."
      >
        <TypePicker overview={overview} onDone={() => setAdding(false)} />
        <BlankType onDone={() => setAdding(false)} />
      </Modal>
    </div>
  );
}

function BlankType({ onDone }: { onDone: () => void }) {
  const actions = useCatalogActions();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CatalogType["kind"]>("product");
  return (
    <div className="mt-6 grid gap-3 border-t pt-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
      <Field label="Or a blank type">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gift card" />
      </Field>
      <Field label="Sold as">
        <SelectField
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "product", label: "A product" },
            { value: "service", label: "A service (with lengths)" },
            { value: "other", label: "Something else" },
          ]}
        />
      </Field>
      <Button
        disabled={!name.trim() || actions.createType.isPending}
        onClick={() =>
          actions.createType.mutate(
            { name: name.trim(), kind },
            {
              onSuccess: () => {
                notify.success(`${name.trim()} added`);
                onDone();
              },
              onError: (err) => notify.error("Not added", { description: errorText(err) }),
            },
          )
        }
      >
        Create
      </Button>
    </div>
  );
}

function TypePanel({ type, canManage }: { type: CatalogType; canManage: boolean }) {
  const actions = useCatalogActions();
  const [confirm, confirmElement] = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(type.name);
  return (
    <Panel padding="none" className="overflow-hidden">
      {confirmElement}
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
        {canManage ? (
          <TextInput
            aria-label="Type name"
            value={name}
            className="h-8 max-w-64 font-medium"
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name.trim() &&
              name.trim() !== type.name &&
              actions.updateType.mutate({ id: type.id, name: name.trim() })
            }
          />
        ) : (
          <span className="font-medium">{type.name}</span>
        )}
        <Tag size="sm">
          {type.kind === "service" ? "Service" : type.kind === "product" ? "Product" : "Other"}
        </Tag>
        {canManage ? (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Icon name="add" />
              Field
            </Button>
            <IconButton
              icon="archive"
              size="sm"
              label={`Archive ${type.name}`}
              onClick={async () => {
                const ok = await confirm({
                  title: `Archive ${type.name}?`,
                  description: "You can't add new items of this type. Existing items keep it.",
                  confirmLabel: "Archive",
                });
                if (ok) actions.archiveType.mutate(type.id);
              }}
            />
          </div>
        ) : null}
      </div>
      {type.fields.length ? (
        <ul className="divide-y">
          {type.fields.map((f) => (
            <FieldRow key={f.id} field={f} canManage={canManage} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          No details yet. Items of this type have a name, description, category and prices.
        </p>
      )}
      <AddField type={type} open={adding} onOpenChange={setAdding} />
    </Panel>
  );
}

function FieldRow({ field, canManage }: { field: CatalogField; canManage: boolean }) {
  const actions = useCatalogActions();
  const [confirm, confirmElement] = useConfirm();
  return (
    <li className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
      {confirmElement}
      <span className="font-medium">{field.label}</span>
      <span className="text-muted-foreground">
        {fieldTypes[field.type].label}
        {field.unit ? ` · ${field.unit}` : ""}
        {field.options.length ? ` · ${field.options.map((o) => o.label).join(", ")}` : ""}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {field.onVariant ? <Tag size="sm">Per option</Tag> : null}
        {field.required ? <Tag size="sm">Required</Tag> : null}
        {canManage && filterable.has(field.type) ? (
          <Button
            size="xs"
            variant={field.filterable ? "secondary" : "ghost"}
            onClick={() => actions.updateField.mutate({ id: field.id, filterable: !field.filterable })}
            title="Customers and Mira can filter by it"
          >
            {field.filterable ? "Filter on" : "Filter off"}
          </Button>
        ) : field.filterable ? (
          <Tag size="sm" tone="primary">
            Filter
          </Tag>
        ) : null}
        {canManage ? (
          <IconButton
            icon="delete"
            size="sm"
            label={`Remove ${field.label}`}
            onClick={async () => {
              const ok = await confirm({
                title: `Remove ${field.label}?`,
                description: "New items won't have it. Values already saved on items are kept.",
                confirmLabel: "Remove",
                tone: "danger",
              });
              if (ok) actions.archiveField.mutate(field.id);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

function AddField({
  type,
  open,
  onOpenChange,
}: {
  type: CatalogType;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const actions = useCatalogActions();
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<CatalogField["type"]>("text");
  const [choices, setChoices] = useState("");
  const [unit, setUnit] = useState("");
  const [onVariant, setOnVariant] = useState(false);
  const [canFilter, setCanFilter] = useState(false);
  const [required, setRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choiceType = kind === "select" || kind === "multi_select";
  const reset = () => {
    setLabel("");
    setKind("text");
    setChoices("");
    setUnit("");
    setOnVariant(false);
    setCanFilter(false);
    setRequired(false);
    setError(null);
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={`New field for ${type.name}`}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required>
          <TextInput
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Bedrooms"
            autoFocus
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind of value">
            <SelectField
              value={kind}
              onValueChange={(v) => {
                setKind(v);
                if (!filterable.has(v)) setCanFilter(false);
              }}
              options={Object.entries(fieldTypes).map(([value, t]) => ({
                value: value as CatalogField["type"],
                label: t.label,
              }))}
            />
          </Field>
          {kind === "number" ? (
            <Field label="Unit" optional>
              <TextInput
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="sq ft, km, min"
              />
            </Field>
          ) : null}
        </div>
        {choiceType ? (
          <Field label="Choices" hint="Comma separated" required>
            <TextInput
              value={choices}
              onChange={(e) => setChoices(e.target.value)}
              placeholder="Rent, Sale"
            />
          </Field>
        ) : null}
        <CheckboxRow
          label="Different for each option"
          description="Like size or colour, when an item comes in several options."
          checked={onVariant}
          onCheckedChange={setOnVariant}
        />
        {filterable.has(kind) ? (
          <CheckboxRow
            label="Customers can filter by it"
            description="Mira uses it to narrow results exactly, e.g. 2 bedrooms or under 20,000 km."
            checked={canFilter}
            onCheckedChange={setCanFilter}
          />
        ) : null}
        <CheckboxRow label="Required" checked={required} onCheckedChange={setRequired} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <ModalActions>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          disabled={!label.trim() || actions.addField.isPending}
          onClick={() =>
            actions.addField.mutate(
              {
                typeId: type.id,
                label: label.trim(),
                type: kind,
                options: choiceType
                  ? choices
                      .split(",")
                      .map((c) => c.trim())
                      .filter(Boolean)
                  : [],
                unit: unit.trim() || undefined,
                onVariant,
                filterable: canFilter,
                required,
              },
              {
                onSuccess: () => {
                  notify.success(`${label.trim()} added`);
                  reset();
                  onOpenChange(false);
                },
                onError: (err) => setError(errorText(err)),
              },
            )
          }
        >
          Add field
        </Button>
      </ModalActions>
    </Modal>
  );
}
