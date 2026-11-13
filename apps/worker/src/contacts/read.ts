import { fileStorage } from "@relay/core";
import { type ContactFieldDef, summarizeSheet } from "@relay/core/contacts";
import { readWorkbook } from "@relay/core/sheets";
import { and, type createDb, eq, isNull, schema } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Reads an uploaded spreadsheet for the import screen: every sheet's headers, a preview, a guessed
 * target per column and the distinct values new choice fields need. Runs here, not in the API, so a
 * 20 MB file never holds up anyone's inbox.
 */

type Db = ReturnType<typeof createDb>["db"];
export type ReadJob = { importId: string };

export function createReadProcessor({ db }: { db: Db }) {
  const storage = fileStorage();
  const im = schema.contactImport;

  return async (job: Job<ReadJob>) => {
    const [imp] = await db.select().from(im).where(eq(im.id, job.data.importId)).limit(1);
    if (imp?.status !== "reading") return;
    const fail = (readError: string) =>
      db.update(im).set({ status: "failed", readError, finishedAt: new Date() }).where(eq(im.id, imp.id));

    let sheets: ReturnType<typeof readWorkbook>;
    try {
      sheets = readWorkbook(await storage.get(imp.storageKey)).filter((s) => s.headers.length);
    } catch {
      await fail("We couldn't read that file. Save it as .xlsx or .csv and try again.");
      return;
    }
    if (!sheets.length) {
      await fail("That file has no rows to import.");
      return;
    }
    const fields = (await db
      .select()
      .from(schema.contactField)
      .where(
        and(
          eq(schema.contactField.organizationId, imp.organizationId),
          isNull(schema.contactField.archivedAt),
        ),
      )) as unknown as ContactFieldDef[];
    await db
      .update(im)
      .set({ status: "mapping", sheets: sheets.map((s) => summarizeSheet(s, fields)) })
      .where(eq(im.id, imp.id));
  };
}
