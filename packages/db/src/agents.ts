import { and, eq, gte, sql, sum } from "drizzle-orm";
import type { Db } from "./client";
import type { DbOrTx } from "./executor";
import { sqlExecutor } from "./executor";
import { aiCreditAllowance, aiUsage } from "./schema/agents";

/*
 * Shared AI-agent data helpers for the API (Try panel) and the worker (live chats): knowledge search,
 * usage rows and the monthly credit balance.
 */

export type KnowledgeSearchHit = { chunkId: string; sourceId: string; title: string; content: string };

/**
 * Hybrid search over a branch's knowledge: full-text (always) and, when an embedding of the query is
 * given, meaning. The two rankings are fused (reciprocal rank) in SQL; the best `limit` pieces return.
 */
export async function searchKnowledge(
  db: DbOrTx,
  opts: { orgId: string; branchId: string; terms: string | null; embedding: number[] | null; limit?: number },
): Promise<KnowledgeSearchHit[]> {
  const limit = opts.limit ?? 5;
  if (!opts.terms && !opts.embedding) return [];
  const q = sqlExecutor(db);
  const params: unknown[] = [opts.orgId, opts.branchId, limit];
  const parts: string[] = [];
  if (opts.terms) {
    params.push(opts.terms);
    parts.push(`select c.id, row_number() over (order by ts_rank(c.tsv, q) desc) as r
      from knowledge_chunk c, to_tsquery('simple', $${params.length}) q
      where c.organization_id = $1 and c.branch_id = $2 and c.tsv @@ q
      order by ts_rank(c.tsv, q) desc limit 20`);
  }
  if (opts.embedding) {
    params.push(`[${opts.embedding.join(",")}]`);
    parts.push(`select c.id, row_number() over (order by c.embedding <=> $${params.length}::vector) as r
      from knowledge_chunk c
      where c.organization_id = $1 and c.branch_id = $2 and c.embedding is not null
      order by c.embedding <=> $${params.length}::vector limit 20`);
  }
  const ranked = parts.map((p, i) => `l${i} as (${p})`).join(",\n");
  const union = parts.map((_, i) => `select id, 1.0 / (60 + r) as s from l${i}`).join(" union all ");
  const rows = await q.query<{ id: string; source_id: string; title: string; content: string }>(
    `with ${ranked},
      fused as (select id, sum(s) as score from (${union}) u group by id order by score desc limit $3)
     select c.id, c.source_id, s.title, c.content
       from fused f join knowledge_chunk c on c.id = f.id join knowledge_source s on s.id = c.source_id
      where s.status = 'ready'
      order by f.score desc`,
    params,
  );
  return rows.map((r) => ({ chunkId: r.id, sourceId: r.source_id, title: r.title, content: r.content }));
}

export type UsageRow = typeof aiUsage.$inferInsert;

/** Records one model call. The step key is unique, so a replayed step never counts twice. */
export async function recordAiUsage(db: DbOrTx, row: UsageRow): Promise<void> {
  await db.insert(aiUsage).values(row).onConflictDoNothing({ target: aiUsage.stepKey });
}

/** The first moment of the current month, in UTC (allowances reset monthly). */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Credits used this month and the allowance. */
export async function aiCredits(
  db: Db,
  orgId: string,
  defaultMonthly: number,
  now = new Date(),
): Promise<{ used: number; allowance: number; left: number }> {
  const [used] = await db
    .select({ n: sum(aiUsage.credits) })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, orgId), gte(aiUsage.createdAt, monthStart(now))));
  const [row] = await db
    .select({ n: aiCreditAllowance.monthlyCredits })
    .from(aiCreditAllowance)
    .where(eq(aiCreditAllowance.organizationId, orgId));
  const usedN = Number(used?.n ?? 0);
  const allowance = row?.n ?? defaultMonthly;
  return { used: usedN, allowance, left: Math.max(0, allowance - usedN) };
}

/** Embeddings as Postgres vector literals. */
export const vectorLiteral = (v: number[]) => sql`${`[${v.join(",")}]`}::vector`;
