import { costMicros, type Embedder } from "@relay/agent";
import { newId } from "@relay/core";
import { and, type createDb, eq, recordAiUsage, schema, sql } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Makes catalogue items findable by meaning (queue "catalog", job "embed", one per branch every few
 * seconds at most): every item whose revision is newer than its embedding is embedded in batches of 64,
 * 512 dimensions each. An item edited again meanwhile keeps its newer revision and is picked up by the
 * next run. Without an AI key items are still found by their words.
 */

type Db = ReturnType<typeof createDb>["db"];
export type EmbedJob = { organizationId: string; branchId: string };

const BATCH = 64;
/** What is embedded per item, at most (about 600 tokens). */
const MAX_CHARS = 2400;

export function itemEmbeddingText(item: { title: string; description: string; searchText: string }) {
  return `${item.title}\n${item.searchText}\n${item.description}`.slice(0, MAX_CHARS);
}

export function createCatalogEmbedder(deps: { db: Db; embed: Embedder | null }) {
  const { db } = deps;
  const I = schema.catalogItem;
  return async (job: Job<EmbedJob>) => {
    if (!deps.embed) return { embedded: 0 };
    const { organizationId, branchId } = job.data;
    let embedded = 0;
    for (let round = 0; round < 1000; round++) {
      const items = await db
        .select({
          id: I.id,
          revision: I.revision,
          title: I.title,
          description: I.description,
          searchText: I.searchText,
        })
        .from(I)
        .where(
          and(
            eq(I.organizationId, organizationId),
            eq(I.branchId, branchId),
            sql`${I.embeddedRevision} < ${I.revision}`,
          ),
        )
        .limit(BATCH);
      if (!items.length) break;
      const res = await deps.embed(items.map(itemEmbeddingText));
      await recordAiUsage(db, {
        id: newId("aiUsage"),
        organizationId,
        branchId,
        stepKey: `catalog-embed:${items.map((i) => `${i.id}.${i.revision}`).join(",")}`.slice(0, 500),
        kind: "embed",
        model: res.model,
        inputTokens: Math.round(res.tokens),
        costMicros: costMicros(res.model, { inputTokens: res.tokens, cachedTokens: 0, outputTokens: 0 }),
      });
      for (const [k, item] of items.entries()) {
        const vector = res.embeddings[k];
        if (!vector) continue;
        // Only if nobody changed it meanwhile; otherwise the next round embeds the newer text.
        await db
          .update(I)
          .set({ embedding: vector, embeddedRevision: item.revision })
          .where(and(eq(I.id, item.id), eq(I.revision, item.revision)));
        embedded++;
      }
      // An item edited during this batch stays behind; don't spin on it within one job.
      if (items.length < BATCH) break;
    }
    return { embedded };
  };
}
