import {
  createGraphClient,
  type GraphClient,
  requestSmbSync,
  type SmbSyncType,
  smbSyncFailure,
} from "@relay/channels";
import { decryptSecretJson, env } from "@relay/core";
import { and, type createDb, eq, schema, sql } from "@relay/db";
import type { Job } from "bullmq";

/*
 * Coexistence follow-ups after a number is connected through Embedded Signup (queue "onboarding"):
 *   coexistence-sync    asks Meta for the phone app's contacts, then its chat history. Each can be
 *                       asked once per onboarding, within 24 hours; the answers arrive as webhooks.
 *   coexistence-expire  at 24 hours, marks anything never asked for as expired.
 * Declined history (the business turned sharing off) is final for this onboarding.
 */

type Db = ReturnType<typeof createDb>["db"];
export type OnboardingJob = { channelAccountId: string };

type Sync = { status?: string };
type Coexistence = { windowEndsAt?: string; contacts?: Sync; history?: Sync };

export function createOnboardingProcessor(deps: { db: Db; graph?: GraphClient }) {
  const { db } = deps;
  const config = env();
  const graph =
    deps.graph ??
    createGraphClient({
      baseUrl: config.META_GRAPH_URL,
      version: config.META_GRAPH_VERSION,
      timeoutMs: 20_000,
    });
  const ca = schema.channelAccount;

  async function set(channelId: string, key: "contacts" | "history", patch: Record<string, unknown>) {
    const path = sql.raw(`'{coexistence,${key}}'`);
    await db
      .update(ca)
      .set({
        providerMeta: sql`jsonb_set(${ca.providerMeta}, ${path}, coalesce(${ca.providerMeta} #> ${path}, '{}'::jsonb) || ${JSON.stringify({ ...patch, updatedAt: new Date().toISOString() })}::jsonb, true)`,
        updatedAt: new Date(),
      } as never)
      .where(and(eq(ca.id, channelId), sql`${ca.providerMeta} ? 'coexistence'`));
  }

  async function sync(job: Job<OnboardingJob>) {
    const [ch] = await db.select().from(ca).where(eq(ca.id, job.data.channelAccountId));
    if (!ch || ch.status === "disconnected") return;
    const coex = (ch.providerMeta as { coexistence?: Coexistence }).coexistence;
    if (!coex) return;
    if (coex.windowEndsAt && Date.parse(coex.windowEndsAt) < Date.now()) return;
    const { accessToken } = decryptSecretJson(ch.credentials, config.CHANNEL_SECRET_KEY ?? "") as {
      accessToken: string;
    };

    // Contacts first, then history (FlowFlex's order: names are known before the chats arrive).
    const steps: [key: "contacts" | "history", type: SmbSyncType][] = [
      ["contacts", "smb_app_state_sync"],
      ["history", "history"],
    ];
    for (const [key, type] of steps) {
      if ((coex[key]?.status ?? "pending") !== "pending") continue;
      try {
        const requestId = await requestSmbSync(graph, ch.externalId, accessToken, type);
        await set(ch.id, key, { status: "requested", requestId, requestedAt: new Date().toISOString() });
      } catch (err) {
        const outcome = smbSyncFailure(err);
        const message = err instanceof Error ? err.message : String(err);
        if (outcome === "retry") throw err; // BullMQ retries with backoff
        await set(ch.id, key, {
          status:
            outcome === "already_requested"
              ? "requested"
              : outcome === "declined"
                ? "declined"
                : outcome === "expired"
                  ? "expired"
                  : "failed",
          error: message,
        });
      }
    }
  }

  async function expire(job: Job<OnboardingJob>) {
    const [ch] = await db.select().from(ca).where(eq(ca.id, job.data.channelAccountId));
    const coex = (ch?.providerMeta as { coexistence?: Coexistence } | undefined)?.coexistence;
    if (!ch || !coex) return;
    for (const key of ["contacts", "history"] as const)
      if ((coex[key]?.status ?? "pending") === "pending")
        await set(ch.id, key, { status: "expired", error: "Not requested within 24 hours of connecting." });
  }

  return async (job: Job<OnboardingJob>) => {
    if (job.name === "coexistence-sync") return sync(job);
    if (job.name === "coexistence-expire") return expire(job);
  };
}
