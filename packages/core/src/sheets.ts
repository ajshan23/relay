import * as XLSX from "xlsx";

/*
 * Reading and writing spreadsheets (.xlsx, .xls, .csv) for contact imports and exports. Server only:
 * import from "@relay/core/sheets". Cells keep their types: numbers stay numbers, dates become
 * YYYY-MM-DD strings, everything else text.
 */

export type Sheet = { name: string; headers: string[]; rows: unknown[][] };

const MAX_ROWS = 100_000;

const cell = (v: unknown): unknown => {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // SheetJS gives local-midnight dates; read the calendar day back in local time.
    const p = (n: number) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  return v ?? null;
};

/** Every sheet of a workbook: the first non-empty row is the header, the rest are rows. */
export function readWorkbook(bytes: Uint8Array): Sheet[] {
  const wb = XLSX.read(bytes, { type: "array", cellDates: true, dense: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return { name, headers: [], rows: [] };
    const all = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const start = all.findIndex((r) => r.some((v) => cell(v) !== null));
    if (start < 0) return { name, headers: [], rows: [] };
    const width = Math.max(...all.slice(start, start + 200).map((r) => r.length));
    const seen = new Map<string, number>();
    const headers = Array.from({ length: width }, (_, i) => {
      const raw = String(cell(all[start]?.[i]) ?? "").trim() || `Column ${i + 1}`;
      const n = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, n);
      return n > 1 ? `${raw} (${n})` : raw;
    });
    const rows = all
      .slice(start + 1, start + 1 + MAX_ROWS)
      .map((r) => headers.map((_, i) => cell(r[i])))
      .filter((r) => r.some((v) => v !== null));
    return { name, headers, rows };
  });
}

/** A one-sheet workbook as bytes. */
export function writeWorkbook(headers: string[], rows: unknown[][], format: "xlsx" | "csv"): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  if (format === "csv") return new TextEncoder().encode(`﻿${XLSX.utils.sheet_to_csv(ws)}`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Contacts");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}
