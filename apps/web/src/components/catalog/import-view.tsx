"use client";

import { type CatalogImportSheet, type CatalogImportTarget, catalogImportTargets } from "@relay/core/catalog";
import { EmptyState } from "@relay/ui/components/empty-state";
import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Panel } from "@relay/ui/components/section";
import { SelectField } from "@relay/ui/components/select-field";
import { Tag } from "@relay/ui/components/tag";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { Skeleton } from "@relay/ui/ui/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import { catalogKeys, useCatalog } from "./queries";

/*
 * Catalogue → Import: an Excel or CSV file into this branch. Pick the kind of items, upload, match the
 * columns (guessed for you), and it imports in the background. Rows with the same id or name become one
 * item with options; importing the same file again updates those items. Photo links are downloaded.
 */

type CatalogImport = {
  id: string;
  fileName: string;
  status: "reading" | "mapping" | "queued" | "running" | "done" | "failed";
  sheets: CatalogImportSheet[] | null;
  readError: string | null;
  total: number;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { row: number; reason: string }[];
  createdAt: string;
};

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

export function ImportView() {
  const branch = useBranch().branch.id;
  const overview = useCatalog();
  const qc = useQueryClient();
  const [typeId, setTypeId] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const types = overview.data?.types ?? [];
  useEffect(() => {
    if (!typeId && types[0]) setTypeId(types[0].id);
  }, [typeId, types]);

  const recent = useQuery({
    queryKey: ["catalog", branch, "imports"],
    queryFn: () =>
      api<{ imports: CatalogImport[] }>(inBranch("/catalog/imports", branch)).then((r) => r.imports),
    enabled: !!branch,
  });
  const imp = useQuery({
    queryKey: ["catalog", branch, "import", current],
    queryFn: () =>
      api<{ import: CatalogImport }>(inBranch(`/catalog/imports/${current}`, branch)).then((r) => r.import),
    enabled: !!current,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "reading" || s === "queued" || s === "running" ? 1500 : false;
    },
  });
  useEffect(() => {
    if (imp.data?.status === "done") {
      qc.invalidateQueries({ queryKey: catalogKeys.all });
    }
  }, [imp.data?.status, qc]);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      form.append("typeId", typeId);
      return api<{ import: CatalogImport }>(inBranch("/catalog/imports", branch), {
        method: "POST",
        body: form,
      });
    },
    onSuccess: (r) => setCurrent(r.import.id),
    onError: (err) => notify.error("Not uploaded", { description: errorText(err) }),
  });

  if (!overview.data) return <Skeleton className="h-48 w-full" />;
  if (!overview.data.canManage)
    return (
      <EmptyState
        icon={<Icon name="upload" />}
        title="Only managers import"
        description="Ask a manager of this branch to import items."
      />
    );
  if (!types.length)
    return (
      <EmptyState
        icon={<Icon name="tag" />}
        title="Pick what you sell first"
        description="Open Items and choose a type, then come back to import."
      />
    );

  return (
    <div className="flex flex-col gap-6">
      {!current || imp.data?.status === "done" || imp.data?.status === "failed" ? (
        <Panel padding="lg" className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[16rem_1fr] sm:items-end">
            <Field label="These items are">
              <SelectField
                value={typeId}
                onValueChange={setTypeId}
                options={types.map((t) => ({ value: t.id, label: t.name }))}
              />
            </Field>
            <div className="flex flex-col gap-1">
              <Button
                className="self-start"
                disabled={!typeId || upload.isPending}
                onClick={() => input.current?.click()}
              >
                <Icon name="upload" />
                {upload.isPending ? "Uploading…" : "Choose an Excel or CSV file"}
              </Button>
              <span className="text-xs text-muted-foreground">
                One row per item, or per option. Up to 20 MB. Columns are matched for you.
              </span>
            </div>
          </div>
          <input
            ref={input}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = "";
            }}
          />
        </Panel>
      ) : null}

      {current && imp.data ? (
        <ImportProgress imp={imp.data} typeId={typeId} onReset={() => setCurrent(null)} />
      ) : null}

      {recent.data?.length ? (
        <Panel padding="none" className="overflow-hidden">
          <div className="border-b px-5 py-3 text-sm font-medium">Recent imports</div>
          <ul className="divide-y">
            {recent.data.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <Icon name="table" size="sm" className="text-muted-foreground" />
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  onClick={() => setCurrent(r.id)}
                >
                  {r.fileName}
                </button>
                <span className="text-muted-foreground">
                  {r.status === "done"
                    ? `${r.created} added, ${r.updated} updated${r.failed ? `, ${r.failed} failed` : ""}`
                    : ""}
                </span>
                <Tag
                  size="sm"
                  tone={r.status === "done" ? "good" : r.status === "failed" ? "danger" : "plain"}
                >
                  {statusWords[r.status]}
                </Tag>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

const statusWords: Record<CatalogImport["status"], string> = {
  reading: "Reading",
  mapping: "Matching columns",
  queued: "Waiting",
  running: "Importing",
  done: "Done",
  failed: "Failed",
};

function ImportProgress({
  imp,
  typeId,
  onReset,
}: {
  imp: CatalogImport;
  typeId: string;
  onReset: () => void;
}) {
  const branch = useBranch().branch.id;
  const qc = useQueryClient();
  const overview = useCatalog();
  const type = overview.data?.types.find((t) => t.id === typeId);
  const [sheetName, setSheetName] = useState(imp.sheets?.[0]?.name ?? "");
  const sheet = imp.sheets?.find((s) => s.name === sheetName) ?? imp.sheets?.[0];
  const [mapping, setMapping] = useState<Record<string, CatalogImportTarget>>({});
  useEffect(() => {
    if (sheet) setMapping(sheet.guesses);
  }, [sheet]);
  const start = useMutation({
    mutationFn: () =>
      api(inBranch(`/catalog/imports/${imp.id}/start`, branch), {
        method: "POST",
        json: { sheet: sheet?.name, mapping },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["catalog", branch, "import", imp.id] }),
    onError: (err) => notify.error("Not started", { description: errorText(err) }),
  });

  if (imp.status === "reading") return <Panel padding="lg">Reading {imp.fileName}…</Panel>;
  if (imp.status === "failed")
    return (
      <Panel padding="lg" className="flex flex-col gap-2">
        <span className="font-medium text-destructive">The import stopped</span>
        <span className="text-sm">{imp.readError ?? "Something went wrong."}</span>
        <Button variant="outline" className="self-start" onClick={onReset}>
          Try another file
        </Button>
      </Panel>
    );
  if (imp.status === "mapping" && sheet) {
    const options = [
      ...catalogImportTargets.map((t) => ({ value: t.value, label: t.label })),
      ...(type?.fields ?? []).map((f) => ({
        value: `field:${f.key}` as CatalogImportTarget,
        label: `${type?.name}: ${f.label}`,
      })),
    ];
    return (
      <Panel padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
          <span className="font-medium">Match the columns</span>
          <span className="text-sm text-muted-foreground">
            {sheet.rowCount} rows in {imp.fileName}
          </span>
          {imp.sheets && imp.sheets.length > 1 ? (
            <SelectField
              value={sheet.name}
              onValueChange={setSheetName}
              size="sm"
              className="ml-auto w-48"
              aria-label="Sheet"
              options={imp.sheets.map((s) => ({ value: s.name, label: s.name }))}
            />
          ) : null}
        </div>
        <ul className="divide-y">
          {sheet.headers.map((h, i) => (
            <li
              key={h}
              className="grid gap-2 px-5 py-2.5 text-sm sm:grid-cols-[1fr_1fr_16rem] sm:items-center"
            >
              <span className="font-medium">{h}</span>
              <span className="truncate text-muted-foreground">
                {sheet.preview
                  .map((r) => r[i])
                  .filter((v) => v !== null && v !== undefined && v !== "")
                  .slice(0, 2)
                  .map(String)
                  .join(", ")}
              </span>
              <SelectField
                aria-label={`Where ${h} goes`}
                size="sm"
                value={mapping[h] ?? "skip"}
                onValueChange={(v) => setMapping((m) => ({ ...m, [h]: v as CatalogImportTarget }))}
                options={options}
              />
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" onClick={onReset}>
            Cancel
          </Button>
          <Button disabled={start.isPending} onClick={() => start.mutate()}>
            Import {sheet.rowCount} rows
          </Button>
        </div>
      </Panel>
    );
  }
  const share = imp.total ? imp.processed / imp.total : 0;
  return (
    <Panel padding="lg" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {imp.status === "done" ? `Imported ${imp.fileName}` : `Importing ${imp.fileName}…`}
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">
          {imp.processed} of {imp.total} rows
        </span>
      </div>
      <Progress value={share * 100} />
      <span className="text-sm">
        {imp.created} added · {imp.updated} updated
        {imp.skipped ? ` · ${imp.skipped} empty rows skipped` : ""}
        {imp.failed ? ` · ${imp.failed} not imported` : ""}
      </span>
      {imp.errors.length ? (
        <ul className="max-h-60 overflow-y-auto rounded-md border text-sm">
          {imp.errors.map((e) => (
            <li key={`${e.row}-${e.reason}`} className="flex gap-3 border-b px-3 py-1.5 last:border-0">
              <span className="w-16 shrink-0 text-muted-foreground">Row {e.row}</span>
              <span>{e.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {imp.status === "done" ? (
        <Button variant="outline" className="self-start" onClick={onReset}>
          Import another file
        </Button>
      ) : null}
    </Panel>
  );
}
