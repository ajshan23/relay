import { type ExportJob, type ExportResult, fileStorage } from "@relay/core";
import { type ContactFieldDef, type ExportRow, exportTable } from "@relay/core/contacts";
import { writeWorkbook } from "@relay/core/sheets";
import { and, type createDb, eq, isNull, schema } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Writes a contacts export. The API compiled the table's query (filters, sort, search, list); this
 * runs it, turns ids into names and writes the file where the API can hand it to the browser.
 */

type Db = ReturnType<typeof createDb>["db"];
type Sql = ReturnType<typeof createDb>["sql"];

/** Timestamps arrive as text without a zone; they're UTC. */
const utc = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d/.test(v) && !/[zZ]|[+-]\d{2}(:?\d{2})?$/.test(v)
    ? `${v.replace(" ", "T")}Z`
    : v;

export function createExportProcessor({ db, sql }: { db: Db; sql: Sql }) {
  const storage = fileStorage();

  return async (job: Job<ExportJob>): Promise<ExportResult> => {
    const d = job.data;
    const raw = await sql.unsafe(d.sql, d.params as never[]).values();
    const rows = raw.map((values) => {
      const row = Object.fromEntries(d.keys.map((k, i) => [k, values[i]]));
      row.lastMessageAt = utc(row.lastMessageAt);
      row.createdAt = utc(row.createdAt);
      return row as ExportRow;
    });
    const [fields, tags, channels] = await Promise.all([
      db
        .select()
        .from(schema.contactField)
        .where(and(eq(schema.contactField.organizationId, d.orgId), isNull(schema.contactField.archivedAt))),
      db
        .select({ id: schema.tag.id, name: schema.tag.name })
        .from(schema.tag)
        .where(eq(schema.tag.organizationId, d.orgId)),
      db
        .select({ id: schema.channelAccount.id, name: schema.channelAccount.displayName })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.organizationId, d.orgId)),
    ]);
    const { headers, cells } = exportTable(d.columns, rows, {
      fields: fields as unknown as ContactFieldDef[],
      tags: new Map(tags.map((t) => [t.id, t.name])),
      channels: new Map(channels.map((ch) => [ch.id, ch.name])),
    });
    const bytes = writeWorkbook(headers, cells, d.format);
    // S3 deletes these after a day (lifecycle rule on exports/).
    const storageKey = `exports/${d.orgId}/${job.id}.${d.format}`;
    await storage.put(storageKey, bytes, {
      contentType:
        d.format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    return {
      storageKey,
      fileName: `contacts-${new Date().toISOString().slice(0, 10)}.${d.format}`,
      rows: rows.length,
    };
  };
}
