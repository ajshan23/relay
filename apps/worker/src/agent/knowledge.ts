import { chunkText, costMicros, type Embedder, estimateTokens, qaChunk } from "@relay/agent";
import { type FileStorage, newId } from "@relay/core";
import { type createDb, eq, recordAiUsage, schema } from "@relay/db";
import { fileText, pageText } from "./extract";

/*
 * Indexing a knowledge source (queue "knowledge", job id index_<source id>_<revision>): read it, cut it
 * into pieces, embed the pieces when an embedder is configured, and swap the source's pieces in one
 * transaction. An edit bumps the revision; a job for an older revision gives up quietly.
 */

type Db = ReturnType<typeof createDb>["db"];
export type KnowledgeJob = { sourceId: string; revision: number };

const MAX_CHUNKS = 400;
const EMBED_BATCH = 64;

export function createKnowledgeProcessor(deps: { db: Db; storage: FileStorage; embed: Embedder | null }) {
  const { db } = deps;
  return async (job: { data: KnowledgeJob }) => {
    const { sourceId, revision } = job.data;
    const [source] = await db
      .select()
      .from(schema.knowledgeSource)
      .where(eq(schema.knowledgeSource.id, sourceId));
    if (!source || source.revision !== revision) return;
    await db
      .update(schema.knowledgeSource)
      .set({ status: "indexing", error: null })
      .where(eq(schema.knowledgeSource.id, sourceId));
    try {
      const { text, title } = await sourceText(source, deps.storage, db);
      const pieces = source.kind === "qa" ? [text] : chunkText(text);
      if (!pieces.length) throw new Error("There's no readable text in it.");
      if (pieces.length > MAX_CHUNKS)
        throw new Error(
          `It's too long (${pieces.length} parts). Split it into smaller files of under 150 pages.`,
        );

      let embeddings: (number[] | null)[] = pieces.map(() => null);
      if (deps.embed) {
        embeddings = [];
        for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
          const batch = pieces.slice(i, i + EMBED_BATCH);
          const res = await deps.embed(batch);
          embeddings.push(...res.embeddings);
          await recordAiUsage(db, {
            id: newId("aiUsage"),
            organizationId: source.organizationId,
            branchId: source.branchId,
            stepKey: `embed:${sourceId}:${revision}:${i}`,
            kind: "embed",
            model: res.model,
            inputTokens: Math.round(res.tokens),
            costMicros: costMicros(res.model, { inputTokens: res.tokens, cachedTokens: 0, outputTokens: 0 }),
          });
        }
      }

      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ revision: schema.knowledgeSource.revision })
          .from(schema.knowledgeSource)
          .where(eq(schema.knowledgeSource.id, sourceId))
          .for("update");
        if (!current || current.revision !== revision) return;
        await tx.delete(schema.knowledgeChunk).where(eq(schema.knowledgeChunk.sourceId, sourceId));
        await tx.insert(schema.knowledgeChunk).values(
          pieces.map((content, position) => ({
            id: newId("knowledgeChunk"),
            sourceId,
            organizationId: source.organizationId,
            branchId: source.branchId,
            position,
            // The title rides along so a search for the page or file name finds its pieces too.
            content: position === 0 && title && source.kind !== "qa" ? `${title}\n\n${content}` : content,
            tokens: estimateTokens(content),
            embedding: embeddings[position] ?? null,
          })),
        );
        await tx
          .update(schema.knowledgeSource)
          .set({
            status: "ready",
            error: null,
            chunkCount: pieces.length,
            indexedAt: new Date(),
            ...(source.kind === "website" && title && source.title === source.url ? { title } : {}),
          })
          .where(eq(schema.knowledgeSource.id, sourceId));
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.knowledgeSource)
        .set({ status: "failed", error: message.slice(0, 300) })
        .where(eq(schema.knowledgeSource.id, sourceId));
    }
  };
}

async function sourceText(
  source: typeof schema.knowledgeSource.$inferSelect,
  storage: FileStorage,
  db: Db,
): Promise<{ text: string; title: string }> {
  switch (source.kind) {
    case "text":
      return { text: source.body ?? "", title: source.title };
    case "qa":
      return { text: qaChunk(source.qa?.question ?? "", source.qa?.answer ?? ""), title: "" };
    case "website": {
      if (!source.url) throw new Error("No address.");
      return pageText(source.url);
    }
    case "file": {
      if (!source.fileId) throw new Error("The file is missing.");
      const [file] = await db.select().from(schema.storedFile).where(eq(schema.storedFile.id, source.fileId));
      if (!file) throw new Error("The file is missing.");
      const bytes = await storage.get(file.storageKey);
      return { text: await fileText(bytes, file.mimeType, source.fileName), title: source.title };
    }
  }
}
