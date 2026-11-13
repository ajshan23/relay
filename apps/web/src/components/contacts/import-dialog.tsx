"use client";

import { type FieldType, fieldTypes, type ImportMapping, type ImportTarget } from "@relay/core/contacts";
import { Segmented } from "@relay/ui/components/choice";
import { Icon } from "@relay/ui/components/icon";
import { Modal, ModalActions } from "@relay/ui/components/modal";
import { SelectField } from "@relay/ui/components/select-field";
import { notify } from "@relay/ui/components/toast";
import { Button } from "@relay/ui/ui/button";
import { Progress } from "@relay/ui/ui/progress";
import { Spinner } from "@relay/ui/ui/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type ContactsMeta,
  contactKeys,
  download,
  inBranch,
  startImport,
  type UploadedFile,
  uploadImport,
  useImport,
} from "./queries";

/*
 * Import contacts from Excel or CSV in three steps: pick a file, say where each column goes (guessed
 * for you), then watch it run. Contacts are matched by phone, then email.
 */

const fixedTargets: { value: string; label: string }[] = [
  { value: "skip", label: "Don't import" },
  { value: "name", label: "Name" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "tags", label: "Tags" },
  { value: "opt_out", label: "Marketing opt-out (yes / no)" },
];

const typeOptions = (Object.keys(fieldTypes) as FieldType[]).map((t) => ({
  value: t,
  label: fieldTypes[t].label,
}));

const encode = (t: ImportTarget) =>
  t.kind === "field" ? `field:${t.key}` : t.kind === "new_field" ? "new" : t.kind;

const sample = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function ImportDialog({
  open,
  onOpenChange,
  meta,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meta: ContactsMeta;
}) {
  const qc = useQueryClient();
  const { branch } = useBranch();
  const [file, setFile] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sheet, setSheet] = useState("");
  const [targets, setTargets] = useState<ImportTarget[]>([]);
  const [onMatch, setOnMatch] = useState<"update" | "skip">("update");
  const [running, setRunning] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const progress = useImport(running);
  const imp = progress.data?.import;
  const finished = imp?.status === "done" || imp?.status === "failed";

  useEffect(() => {
    if (finished) void qc.invalidateQueries({ queryKey: contactKeys.all });
  }, [finished, qc]);

  /** Clears the dialog once its closing animation is over, so it doesn't flash the first step. */
  const resetLater = () => setTimeout(() => reset(), 250);
  const reset = () => {
    setFile(null);
    setSheet("");
    setTargets([]);
    setOnMatch("update");
    setRunning(null);
    setError(null);
  };

  const pickSheet = (f: UploadedFile, name: string) => {
    const s = f.sheets.find((x) => x.name === name);
    setSheet(name);
    setTargets(
      (s?.guesses ?? []).map((g) => (g.kind === "new_field" && !meta.canManage ? { kind: "skip" } : g)),
    );
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setUploading(true);
    try {
      const res = await uploadImport(branch.id, f);
      setFile(res);
      const best = [...res.sheets].sort((a, b) => b.total - a.total)[0];
      if (best) pickSheet(res, best.name);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : "That file couldn't be uploaded.",
      );
    } finally {
      setUploading(false);
    }
  };

  const current = file?.sheets.find((s) => s.name === sheet);
  const fieldOptions = [
    ...fixedTargets,
    ...(file?.fields ?? []).map((f) => ({ value: `field:${f.key}`, label: f.label })),
    ...(meta.canManage ? [{ value: "new", label: "New field" }] : []),
  ];
  const hasKey = targets.some((t) => t.kind === "phone" || t.kind === "email");
  const used = targets.filter((t) => t.kind !== "skip").length;

  const setTarget = (i: number, value: string) => {
    const header = current?.headers[i] ?? "";
    const next: ImportTarget =
      value === "new"
        ? { kind: "new_field", label: header, type: "text" }
        : value.startsWith("field:")
          ? { kind: "field", key: value.slice(6) }
          : ({ kind: value } as ImportTarget);
    // Name, phone, email, branch and opt-out can come from one column only.
    setTargets((ts) =>
      ts.map((t, j) =>
        j === i
          ? next
          : ["name", "phone", "email", "opt_out"].includes(next.kind) && t.kind === next.kind
            ? { kind: "skip" }
            : t,
      ),
    );
  };

  const start = async () => {
    if (!file || !current) return;
    setStarting(true);
    setError(null);
    const mapping: ImportMapping = current.headers.map((header, column) => ({
      column,
      header,
      target: targets[column] ?? { kind: "skip" },
    }));
    try {
      await startImport(branch.id, file.import.id, { sheet, mapping, onMatch });
      setRunning(file.import.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The import couldn't start.");
    } finally {
      setStarting(false);
    }
  };

  const step = running ? "run" : file ? "map" : "pick";
  const pct = imp?.total ? Math.round((imp.processed / imp.total) * 100) : 0;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o && (step !== "run" || finished)) resetLater();
      }}
      title={step === "run" ? (finished ? "Import finished" : "Importing contacts") : "Import contacts"}
      description={
        step === "pick"
          ? "From Excel (.xlsx, .xls) or CSV. The first row should hold the column names."
          : step === "map"
            ? "Check where each column goes. We guessed from the column names."
            : undefined
      }
      size={step === "map" ? "xl" : "md"}
      footer={
        step === "map" ? (
          <ModalActions
            start={
              <Button variant="ghost" onClick={reset}>
                Choose another file
              </Button>
            }
          >
            <Button onClick={start} disabled={!hasKey || starting}>
              {starting ? <Spinner /> : null}
              Import {current?.total.toLocaleString()} {current?.total === 1 ? "row" : "rows"}
            </Button>
          </ModalActions>
        ) : step === "run" && finished ? (
          <ModalActions>
            {imp && imp.failed > 0 ? (
              <Button
                variant="outline"
                onClick={() =>
                  download(inBranch(`/contacts/imports/${imp.id}/report`, branch.id)).catch((e: Error) =>
                    notify.error("Couldn't download", { description: e.message }),
                  )
                }
              >
                <Icon name="download" />
                Rows not imported
              </Button>
            ) : null}
            <Button
              onClick={() => {
                onOpenChange(false);
                resetLater();
              }}
            >
              Done
            </Button>
          </ModalActions>
        ) : undefined
      }
    >
      {step === "pick" ? (
        <div className="flex flex-col gap-3">
          <label
            onDragOver={(e: DragEvent) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              setDragOver(false);
              void upload(e.dataTransfer.files[0]);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors hover:bg-muted/50",
              dragOver && "border-primary bg-primary/5",
            )}
          >
            {uploading ? <Spinner /> : <Icon name="upload" size="lg" className="text-muted-foreground" />}
            <span className="font-medium">
              {uploading ? "Reading the file…" : "Drop a file here, or click to choose"}
            </span>
            <span className="text-xs text-muted-foreground">Up to 20 MB and 100,000 rows</span>
            <input
              ref={input}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="sr-only"
              disabled={uploading}
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <p className="text-xs text-muted-foreground">
            Contacts are matched by phone number, then email. Phone numbers need their country code.
          </p>
        </div>
      ) : null}

      {step === "map" && file && current ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-sm">
              <Icon name="file" size="sm" className="text-muted-foreground" />
              <span className="truncate font-medium">{file.import.fileName}</span>
            </span>
            {file.sheets.length > 1 ? (
              <SelectField
                size="sm"
                aria-label="Sheet"
                className="w-48"
                options={file.sheets.map((s) => ({ value: s.name, label: `${s.name} (${s.total} rows)` }))}
                value={sheet}
                onValueChange={(v) => pickSheet(file, v)}
              />
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Column in your file</th>
                  <th className="px-3 py-2 font-medium">Example values</th>
                  <th className="w-[300px] px-3 py-2 font-medium">Import as</th>
                </tr>
              </thead>
              <tbody>
                {current.headers.map((h, i) => {
                  const t = targets[i] ?? { kind: "skip" };
                  const examples = current.preview
                    .map((r) => sample(r[i]))
                    .filter(Boolean)
                    .slice(0, 3);
                  return (
                    <tr key={h} className={cn("border-t", t.kind === "skip" && "text-muted-foreground")}>
                      <td className="px-3 py-2 font-medium">{h}</td>
                      <td className="max-w-56 truncate px-3 py-2 text-muted-foreground">
                        {examples.join(", ") || "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex gap-2">
                          <SelectField
                            size="sm"
                            aria-label={`Import ${h} as`}
                            className="min-w-0 flex-1"
                            options={fieldOptions}
                            value={encode(t)}
                            onValueChange={(v) => setTarget(i, v)}
                          />
                          {t.kind === "new_field" ? (
                            <SelectField
                              size="sm"
                              aria-label={`Type of the new field ${h}`}
                              className="w-36"
                              options={typeOptions}
                              value={t.type}
                              onValueChange={(type) =>
                                setTargets((ts) => ts.map((x, j) => (j === i ? { ...t, type } : x)))
                              }
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">When a contact already exists</span>
            <Segmented
              size="sm"
              aria-label="When a contact already exists"
              options={[
                { value: "update", label: "Fill in their details" },
                { value: "skip", label: "Leave them as they are" },
              ]}
              value={onMatch}
              onChange={setOnMatch}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {used} of {current.headers.length} columns will be imported. Empty cells never clear what's
            already saved.
            {!meta.canManage ? " Only owners and admins can add new fields." : ""}
          </p>
          {!hasKey ? (
            <p className="text-sm text-destructive">Pick the column with phone numbers or emails.</p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      ) : null}

      {step === "run" ? (
        <div className="flex flex-col gap-4">
          {!finished ? (
            <>
              <Progress value={pct} aria-label="Import progress" />
              <p className="text-sm text-muted-foreground">
                {imp
                  ? `${imp.processed.toLocaleString()} of ${imp.total.toLocaleString()} rows`
                  : "Starting…"}
                . You can close this window; the import keeps going.
              </p>
            </>
          ) : imp ? (
            <>
              {imp.status === "failed" ? (
                <p className="text-sm text-destructive">The import stopped before the end.</p>
              ) : null}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["Added", imp.created],
                    ["Updated", imp.updated],
                    ["Left as they were", imp.skipped],
                    ["Not imported", imp.failed],
                  ] as const
                ).map(([label, n]) => (
                  <div key={label} className="rounded-lg border px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{n.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
              {imp.errors.length ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Rows not imported</p>
                  <ul className="max-h-48 overflow-y-auto rounded-lg border text-sm">
                    {imp.errors.map((e) => (
                      <li
                        key={`${e.row}-${e.reason}`}
                        className="flex gap-3 border-t px-3 py-1.5 first:border-t-0"
                      >
                        <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
                          {e.row ? `Row ${e.row}` : "—"}
                        </span>
                        <span>{e.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
