"use client";

import { Segmented, SwitchRow } from "@relay/ui/components/choice";
import { Field } from "@relay/ui/components/field";
import { Icon, IconButton } from "@relay/ui/components/icon";
import { SelectField } from "@relay/ui/components/select-field";
import { SidePanel } from "@relay/ui/components/side-panel";
import { TextArea, TextInput } from "@relay/ui/components/text-input";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { Switch } from "@relay/ui/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@relay/ui/ui/tabs";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { FieldInput } from "./field-input";
import {
  type CatalogItem,
  type CatalogOverview,
  type CatalogType,
  type CatalogVariant,
  categoryLabels,
  type ItemInput,
  useCatalogActions,
  useCatalogItem,
} from "./queries";

/*
 * Add or edit one catalogue item: what it is (type, name, category, its fields), its prices (one, or
 * several options such as sizes or lengths, each with its own price, stock and duration), and its
 * gallery once it is saved.
 */

type DraftVariant = Omit<
  CatalogVariant,
  "id" | "price" | "salePrice" | "stock" | "durationMinutes" | "bookingCapacity"
> & {
  id?: string;
  /** Kept as typed until saved. */
  price: string;
  salePrice: string;
  stock: string;
  durationMinutes: string;
  bookingCapacity: string;
};

type Draft = Omit<ItemInput, "variants"> & { variants: DraftVariant[] };

const toDraftVariant = (v: CatalogVariant): DraftVariant => ({
  ...v,
  price: v.price === null ? "" : String(v.price),
  salePrice: v.salePrice === null ? "" : String(v.salePrice),
  stock: v.stock === null ? "" : String(v.stock),
  durationMinutes: v.durationMinutes === null ? "" : String(v.durationMinutes),
  bookingCapacity: String(v.bookingCapacity ?? 1),
});

const blankVariant = (currency: string, service: boolean): DraftVariant => ({
  title: "",
  sku: null,
  price: "",
  salePrice: "",
  currency,
  options: {},
  stock: "",
  available: true,
  durationMinutes: "",
  bookable: service,
  bookingCapacity: "1",
});

function draftOf(item: CatalogItem | undefined, type: CatalogType | undefined, currency: string): Draft {
  if (item)
    return {
      typeId: item.typeId,
      categoryId: item.categoryId,
      title: item.title,
      description: item.description,
      attributes: item.attributes,
      status: item.status,
      tags: item.tags,
      variants: item.variants.map(toDraftVariant),
    };
  return {
    typeId: type?.id ?? "",
    categoryId: null,
    title: "",
    description: "",
    attributes: {},
    status: "active",
    tags: [],
    variants: [blankVariant(currency, type?.kind === "service")],
  };
}

const numberOrNull = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[, ]/g, "")));

export function ItemEditor({
  open,
  onOpenChange,
  itemId,
  overview,
  gallery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null: a new item. */
  itemId: string | null;
  overview: CatalogOverview;
  /** The gallery editor for a saved item (step 3). */
  gallery?: (item: CatalogItem) => ReactNode;
}) {
  const loaded = useCatalogItem(open ? itemId : null);
  const editing = !!itemId;
  return (
    <SidePanel
      open={open}
      onOpenChange={onOpenChange}
      width="lg"
      title={editing ? (loaded.data?.title ?? "Edit item") : "New item"}
      description={editing ? undefined : "Something you sell: a product, a service, a dish, a property."}
    >
      {editing && !loaded.data ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <ItemForm
          key={loaded.data?.id ?? "new"}
          item={loaded.data}
          overview={overview}
          onDone={() => onOpenChange(false)}
          gallery={gallery}
        />
      )}
    </SidePanel>
  );
}

function ItemForm({
  item,
  overview,
  onDone,
  gallery,
}: {
  item: CatalogItem | undefined;
  overview: CatalogOverview;
  onDone: () => void;
  gallery?: (item: CatalogItem) => ReactNode;
}) {
  const actions = useCatalogActions();
  const currency = overview.currency ?? "AED";
  const [draft, setDraft] = useState<Draft>(() => draftOf(item, overview.types[0], currency));
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("details");
  const [tagText, setTagText] = useState(() => (item?.tags ?? []).join(", "));

  const type = overview.types.find((t) => t.id === draft.typeId);
  const itemFields = (type?.fields ?? []).filter((f) => !f.onVariant);
  const variantFields = (type?.fields ?? []).filter((f) => f.onVariant);
  const service = type?.kind === "service";
  const categories = useMemo(() => categoryLabels(overview.categories), [overview.categories]);
  const several = draft.variants.length > 1 || variantFields.length > 0;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setError(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const setVariant = (i: number, patch: Partial<DraftVariant>) => {
    setError(null);
    setDraft((d) => ({ ...d, variants: d.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
  };

  async function save() {
    const input: ItemInput = {
      ...draft,
      tags: tagText
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      variants: draft.variants.map((v) => ({
        ...v,
        sku: v.sku?.trim() || null,
        price: numberOrNull(v.price),
        salePrice: numberOrNull(v.salePrice),
        stock: numberOrNull(v.stock),
        durationMinutes: numberOrNull(v.durationMinutes),
        bookingCapacity: Math.max(1, Math.round(numberOrNull(v.bookingCapacity) ?? 1)),
      })),
    };
    try {
      const res = await actions.saveItem.mutateAsync({ id: item?.id, input });
      notify.success(item ? "Saved" : `${res.item.title} added`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save. Try again.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="prices">{service ? "Prices and length" : "Prices"}</TabsTrigger>
          <TabsTrigger value="gallery" disabled={!item}>
            Photos and videos
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4 flex flex-col gap-4">
          {!item ? (
            <Field label="What is it?" hint="The type decides which details you fill in.">
              <SelectField
                value={draft.typeId}
                onValueChange={(typeId) => {
                  const t = overview.types.find((x) => x.id === typeId);
                  setDraft((d) => ({
                    ...d,
                    typeId,
                    attributes: {},
                    variants: d.variants.map((v) => ({ ...v, options: {}, bookable: t?.kind === "service" })),
                  }));
                }}
                options={overview.types.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Field>
          ) : null}
          <Field label="Name" required>
            <TextInput value={draft.title} onChange={(e) => set("title", e.target.value)} autoFocus={!item} />
          </Field>
          <Field label="Description" hint="What a customer should know. Mira answers from this.">
            <TextArea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              minRows={3}
              maxRows={10}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category" optional>
              <SelectField
                value={draft.categoryId ?? ""}
                onValueChange={(v) => set("categoryId", v || null)}
                placeholder={categories.length ? "None" : "No categories yet"}
                options={[{ value: "", label: "None" }, ...categories]}
              />
            </Field>
            <Field label="Status">
              <Segmented
                aria-label="Status"
                value={draft.status}
                onChange={(v) => set("status", v)}
                options={[
                  { value: "active", label: "On sale" },
                  { value: "draft", label: "Draft" },
                  { value: "archived", label: "Archived" },
                ]}
              />
            </Field>
          </div>
          {itemFields.length ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {itemFields.map((f) => (
                <FieldInput
                  key={f.id}
                  field={f}
                  value={draft.attributes[f.key]}
                  onChange={(v) => set("attributes", { ...draft.attributes, [f.key]: v })}
                />
              ))}
            </div>
          ) : null}
          <Field label="Tags" optional hint="Comma separated, e.g. bestseller, summer">
            <TextInput value={tagText} onChange={(e) => setTagText(e.target.value)} />
          </Field>
        </TabsContent>

        <TabsContent value="prices" className="mt-4 flex flex-col gap-4">
          {draft.variants.map((v, i) => (
            <div key={v.id ?? `new-${i}`} className="flex flex-col gap-3 rounded-lg border p-4">
              {several ? (
                <div className="flex items-end gap-2">
                  <Field
                    label="Option name"
                    hint={service ? "e.g. 30 min, Full session" : "e.g. Large, Grey 3-seater"}
                    className="flex-1"
                  >
                    <TextInput value={v.title} onChange={(e) => setVariant(i, { title: e.target.value })} />
                  </Field>
                  {draft.variants.length > 1 ? (
                    <IconButton
                      icon="delete"
                      label="Remove this option"
                      onClick={() =>
                        set(
                          "variants",
                          draft.variants.filter((_, j) => j !== i),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : null}
              {variantFields.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {variantFields.map((f) => (
                    <FieldInput
                      key={f.id}
                      field={f}
                      value={v.options[f.key]}
                      onChange={(val) => setVariant(i, { options: { ...v.options, [f.key]: val } })}
                    />
                  ))}
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={`Price (${v.currency})`} hint="Leave empty for price on request">
                  <TextInput
                    inputMode="decimal"
                    value={v.price}
                    onChange={(e) => setVariant(i, { price: e.target.value })}
                  />
                </Field>
                <Field label="Sale price" optional>
                  <TextInput
                    inputMode="decimal"
                    value={v.salePrice}
                    onChange={(e) => setVariant(i, { salePrice: e.target.value })}
                  />
                </Field>
                {service ? (
                  <Field label="Length (minutes)" hint={v.bookable ? "Needed for booking" : undefined}>
                    <TextInput
                      inputMode="numeric"
                      value={v.durationMinutes}
                      onChange={(e) => setVariant(i, { durationMinutes: e.target.value })}
                    />
                  </Field>
                ) : (
                  <Field label="In stock" optional hint="Empty: not tracked">
                    <TextInput
                      inputMode="numeric"
                      value={v.stock}
                      onChange={(e) => setVariant(i, { stock: e.target.value })}
                    />
                  </Field>
                )}
              </div>
              {service ? (
                <div className="grid items-end gap-3 sm:grid-cols-[1fr_200px]">
                  <SwitchRow
                    label="Can be booked"
                    description="Customers can book it on WhatsApp, and your team in Bookings."
                    checked={v.bookable}
                    onCheckedChange={(bookable) => setVariant(i, { bookable })}
                  />
                  {v.bookable ? (
                    <Field label="How many at the same time" hint="Tables, chairs or rooms">
                      <TextInput
                        inputMode="numeric"
                        value={v.bookingCapacity}
                        onChange={(e) => setVariant(i, { bookingCapacity: e.target.value })}
                      />
                    </Field>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Field label="SKU" optional className="min-w-48 flex-1">
                  <TextInput value={v.sku ?? ""} onChange={(e) => setVariant(i, { sku: e.target.value })} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={v.available} onCheckedChange={(on) => setVariant(i, { available: on })} />
                  Available
                </label>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => set("variants", [...draft.variants, blankVariant(currency, service)])}
          >
            <Icon name="add" />
            {several ? "Add another option" : "Add options (sizes, lengths…)"}
          </Button>
        </TabsContent>

        <TabsContent value="gallery" className="mt-4">
          {item && gallery ? gallery(item) : null}
        </TabsContent>
      </Tabs>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="button" onClick={save} disabled={actions.saveItem.isPending || !draft.typeId}>
          {item ? "Save changes" : "Add item"}
        </Button>
      </div>
    </div>
  );
}
