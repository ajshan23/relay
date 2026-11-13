import type { BroadcastErrorAction } from "@relay/channels";
import { newId } from "@relay/core";
import { fillVariables, type TemplateContent, templateVariables } from "@relay/core/templates";
import {
  activeFields,
  and,
  compileFilter,
  type createDb,
  eq,
  inArray,
  listsById,
  schema,
  sql,
} from "@relay/db";
import type { BroadcastContent } from "@relay/db/schema";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { OutboxJob } from "../channels/outbox";
import { accountRef, channels } from "../channels/registry";
import { sendingDaysUntil, startOfLocalDay, windowState } from "./schedule";

/*
 * The broadcast engine. One tick every few seconds; everything it knows is in Postgres, so a restart,
 * a crash or a lost Redis simply carries on from the rows:
 *
 *   scheduled ──start──▶ preparing ──audience frozen──▶ sending ⇄ paused ──▶ completed | stopped
 *
 *   prepare   the audience (lists, smart lists, exclusions) becomes broadcast_recipient rows, deduped by
 *             address, opted-out and unreachable people marked skipped. Lists are never read again.
 *   dispatch  inside the sending hours, up to the daily quota (spread evenly over the hours), the
 *             portfolio's room and the number's speed: claims pending recipients (FOR UPDATE SKIP
 *             LOCKED), writes each message (quietly, into the customer's chat) and queues it with the
 *             message id as the job id, so nothing is ever queued twice.
 *   sync      reads the recipients' message rows (outbox results and status webhooks) and acts on
 *             failures through the channel's error table: retry later, final, opt-out, pause, stop.
 *   health    pauses when the template is paused, disabled or RED, the number is RED or flagged, or
 *             too many messages are failing.
 *   rollup    totals onto the broadcast row; completes it when nobody is left.
 */

type Db = ReturnType<typeof createDb>["db"];
type Broadcast = typeof schema.broadcast.$inferSelect;
type Account = typeof schema.channelAccount.$inferSelect;

const TICK_SECONDS = 10;
const PREPARE_CHUNK = 5000;
/** Default share of the daily limit a broadcast uses when no per-day number is set. */
const DEFAULT_SHARE = 0.75;
/** Daily limit assumed until the channel reports one (the lowest tier). */
const UNKNOWN_LIMIT = 250;
const MAX_ATTEMPTS = 2;
const BREAKER_WINDOW = 200;
const BREAKER_MIN = 100;
const BREAKER_RATIO = 0.2;

export const outboxJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 3_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;

const utcNow = sql`(now() at time zone 'utc')`;

export function createBroadcastEngine({
  db,
  redis,
  outbox,
}: {
  db: Db;
  redis: Redis;
  outbox: Queue<OutboxJob>;
}) {
  const b = schema.broadcast;
  const r = schema.broadcastRecipient;
  let ticks = 0;

  /* ------------------------------------------------------------------ state changes */

  async function setStatus(
    id: string,
    status: Broadcast["status"],
    reason: string | null,
    detail: string | null,
  ) {
    await db
      .update(b)
      .set({
        status,
        pauseReason: reason,
        pauseDetail: detail,
        updatedAt: new Date(),
        ...(status === "completed" || status === "stopped" || status === "failed"
          ? { completedAt: new Date() }
          : {}),
      })
      .where(eq(b.id, id));
  }

  /** Pauses a sending broadcast for a reason the team sees; they resume it. */
  async function pause(id: string, reason: string, detail: string) {
    await db
      .update(b)
      .set({ status: "paused", pauseReason: reason, pauseDetail: detail, updatedAt: new Date() })
      .where(and(eq(b.id, id), inArray(b.status, ["sending", "scheduled", "preparing"])));
    console.warn(`broadcast ${id} paused: ${reason} (${detail})`);
  }

  /** Ends a broadcast; whoever is still waiting is skipped. */
  async function stop(id: string, reason: string, detail: string) {
    await setStatus(id, "stopped", reason, detail);
    await db
      .update(r)
      .set({ status: "skipped", skipReason: "stopped", updatedAt: new Date() })
      .where(and(eq(r.broadcastId, id), inArray(r.status, ["pending"])));
    console.warn(`broadcast ${id} stopped: ${reason} (${detail})`);
  }

  /* ------------------------------------------------------------------ prepare */

  /** Freezes the audience into recipient rows. Safe to run again (rows are unique per address). */
  async function prepare(bc: Broadcast) {
    const lists = await listsById(db, bc.organizationId, bc.branchId);
    if (!bc.audience.listIds.length && !bc.audience.filter) {
      await setStatus(bc.id, "failed", "audience", "The broadcast has no audience.");
      return;
    }
    const missing = [...bc.audience.listIds, ...bc.audience.excludeListIds].filter((id) => !lists.has(id));
    if (missing.length) {
      await setStatus(
        bc.id,
        "failed",
        "list_deleted",
        "A list this broadcast uses was deleted before it started.",
      );
      return;
    }
    const account = bc.channelAccountId ? await accountById(bc.channelAccountId) : null;
    const caps = account ? channels().get(account.type)?.capabilities.broadcast : null;
    if (!account || !caps) {
      await setStatus(bc.id, "failed", "channel", "The channel is gone or can't send broadcasts.");
      return;
    }
    const fields = new Map((await activeFields(db, bc.organizationId)).map((f) => [f.key, f as never]));
    const rules = [
      ...(bc.audience.listIds.length
        ? [{ field: "list", op: "has_any" as const, value: bc.audience.listIds }]
        : []),
      ...(bc.audience.excludeListIds.length
        ? [{ field: "list", op: "has_none" as const, value: bc.audience.excludeListIds }]
        : []),
    ];
    const where = compileFilter({ match: "all", rules } as never, fields, lists);
    const extra = bc.audience.filter ? compileFilter(bc.audience.filter as never, fields, lists) : undefined;
    const marketing = await isMarketing(bc);
    const c = schema.contact;
    const address =
      caps.addressKind === "email"
        ? sql`nullif(lower(trim(${c.email})), '')`
        : sql`coalesce(nullif(${c.phone}, ''), (select i.phone from ${schema.contactIdentity} i
            where i.contact_id = "contact"."id" and i.channel_type = ${account.type} and i.phone is not null
            order by i.created_at limit 1))`;
    // Marketing only: people who opted out on this channel, or on every channel.
    const optedOut = marketing
      ? sql`exists (select 1 from ${schema.contactOptOut} o where o.contact_id = "contact"."id"
          and (o.channel_account_id is null or o.channel_account_id = ${account.id}))`
      : sql`false`;

    let after = "";
    for (;;) {
      const ids = await db
        .select({ id: c.id })
        .from(c)
        .where(
          and(
            eq(c.organizationId, bc.organizationId),
            eq(c.branchId, bc.branchId),
            where,
            extra,
            sql`${c.id} > ${after}`,
          ),
        )
        .orderBy(c.id)
        .limit(PREPARE_CHUNK);
      if (!ids.length) break;
      after = ids[ids.length - 1]?.id ?? after;
      await db.execute(sql`
        insert into broadcast_recipient (id, broadcast_id, contact_id, address, status, skip_reason)
        select 'bcr_' || replace(gen_random_uuid()::text, '-', ''), ${bc.id}, x.id,
          coalesce(x.address, 'none:' || x.id),
          (case when x.address is null or x.opted then 'skipped' else 'pending' end)::broadcast_recipient_status,
          case when x.address is null then 'no_address' when x.opted then 'opted_out' end
        from (
          select "contact"."id" as id, ${address} as address, ${optedOut} as opted
          from ${c} where "contact"."id" in (${sql.join(
            ids.map((x) => sql`${x.id}`),
            sql`, `,
          )})
          order by "contact"."id"
        ) x
        on conflict (broadcast_id, address) do nothing`);
      if (ids.length < PREPARE_CHUNK) break;
    }
    await rollup(bc.id);
    await db
      .update(b)
      .set({ status: "sending", startedAt: bc.startedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(b.id, bc.id), eq(b.status, "preparing")));
  }

  async function accountById(id: string) {
    const [a] = await db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, id))
      .limit(1);
    return a ?? null;
  }

  async function templateOf(bc: Broadcast) {
    if (bc.content.kind !== "template") return null;
    const [t] = await db
      .select()
      .from(schema.messageTemplate)
      .where(eq(schema.messageTemplate.id, bc.content.templateId))
      .limit(1);
    return t ?? null;
  }

  async function isMarketing(bc: Broadcast) {
    const t = await templateOf(bc);
    return t ? t.purpose === "marketing" : true;
  }

  /* ------------------------------------------------------------------ health */

  /** Pauses (or stops) when something makes sending unsafe. Returns false when it did. */
  async function healthy(bc: Broadcast, account: Account | null): Promise<boolean> {
    if (!account || account.status !== "active") {
      await pause(bc.id, "auth", "The channel isn't connected; reconnect it, then resume.");
      return false;
    }
    const meta = account.providerMeta as { qualityRating?: string; qualityFlag?: string };
    if (meta.qualityRating === "RED" || meta.qualityFlag === "FLAGGED") {
      await pause(
        bc.id,
        "number_quality",
        "The number's quality is low (RED). Sending more could get it limited.",
      );
      return false;
    }
    if (bc.content.kind === "template") {
      const [copy] = await db
        .select({ status: schema.templateChannel.status, quality: schema.templateChannel.quality })
        .from(schema.templateChannel)
        .where(
          and(
            eq(schema.templateChannel.templateId, bc.content.templateId),
            eq(schema.templateChannel.channelAccountId, account.id),
          ),
        )
        .limit(1);
      if (!copy) {
        await stop(bc.id, "template_invalid", "The template isn't on this channel any more.");
        return false;
      }
      if (copy.status === "paused") {
        await pause(bc.id, "template_paused", "Meta paused the template for low quality.");
        return false;
      }
      if (copy.status === "disabled") {
        await pause(bc.id, "template_disabled", "Meta disabled the template.");
        return false;
      }
      if (copy.status !== "ready") {
        await pause(bc.id, "template_invalid", "The template isn't approved on this channel.");
        return false;
      }
      if (copy.quality === "RED") {
        await pause(bc.id, "template_quality", "The template's quality is low (RED); Meta may pause it.");
        return false;
      }
    }
    // Error-rate breaker: many recent failures mean something is wrong with the audience or setup.
    const recent = await db.execute<{ status: string; error_code: string | null }>(sql`
      select status, error_code from broadcast_recipient
      where broadcast_id = ${bc.id} and status in ('sent', 'delivered', 'read', 'failed')
      order by updated_at desc limit ${BREAKER_WINDOW}`);
    if (recent.length >= BREAKER_MIN) {
      const failed = recent.filter((x) => x.status === "failed");
      if (failed.length / recent.length > BREAKER_RATIO) {
        const counts = new Map<string, number>();
        for (const f of failed) counts.set(f.error_code ?? "?", (counts.get(f.error_code ?? "?") ?? 0) + 1);
        const top = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
        await pause(
          bc.id,
          "error_rate",
          `${Math.round((failed.length / recent.length) * 100)}% of recent messages failed (mostly error ${top}).`,
        );
        return false;
      }
    }
    return true;
  }

  /** Refreshes the channel's daily limit and quality from the provider (at start, then hourly). */
  async function refreshHealth(account: Account) {
    const adapter = channels().get(account.type);
    if (!adapter?.health) return account;
    try {
      const h = await adapter.health(accountRef(account));
      const meta = {
        ...account.providerMeta,
        messagingLimit: h.dailyLimit,
        qualityRating: h.quality,
        healthAt: new Date().toISOString(),
      };
      await db
        .update(schema.channelAccount)
        .set({ providerMeta: meta })
        .where(eq(schema.channelAccount.id, account.id));
      return { ...account, providerMeta: meta };
    } catch (err) {
      console.warn(`health of ${account.id}:`, (err as Error).message);
      return account;
    }
  }

  /* ------------------------------------------------------------------ dispatch */

  /** People this business messaged first (templates) in the last 24 h, per org and channel type. */
  const portfolioCache = new Map<string, { at: number; n: number }>();
  async function portfolioUsed(organizationId: string, type: string) {
    const key = `${organizationId}:${type}`;
    const hit = portfolioCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.n;
    const [row] = await db.execute<{ n: number }>(sql`
      select count(distinct c.contact_id)::int as n from message m
      join conversation c on c.id = m.conversation_id
      join channel_account a on a.id = m.channel_account_id
      where m.organization_id = ${organizationId} and a.type = ${type}
        and m.direction = 'outbound' and m.type = 'template' and m.status not in ('failed', 'queued')
        and m.created_at > ${utcNow} - interval '24 hours'`);
    const n = row?.n ?? 0;
    portfolioCache.set(key, { at: Date.now(), n });
    return n;
  }

  /** How many to claim this tick. */
  async function allowance(bc: Broadcast, account: Account) {
    const caps = channels().get(account.type)?.capabilities.broadcast;
    if (!caps) return 0;
    const now = new Date();
    const win = windowState(bc.schedule, now);
    if (!win.open) {
      const detail = win.opensAt
        ? `Waiting for sending hours (opens ${win.opensAt.toISOString()})`
        : "Waiting for sending hours";
      if (bc.pauseDetail !== detail) await db.update(b).set({ pauseDetail: detail }).where(eq(b.id, bc.id));
      return 0;
    }
    if (bc.pauseDetail) await db.update(b).set({ pauseDetail: null }).where(eq(b.id, bc.id));

    const meta = account.providerMeta as { messagingLimit?: number | null };
    const dailyLimit = caps.dailyLimit === "portfolio" ? (meta.messagingLimit ?? UNKNOWN_LIMIT) : -1;
    // Per day: fixed, or spread to finish by a date, or a share of the daily limit.
    let perDay: number;
    if (bc.schedule.perDay) perDay = bc.schedule.perDay;
    else if (bc.schedule.endBy) {
      const [left] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(r)
        .where(and(eq(r.broadcastId, bc.id), inArray(r.status, ["pending", "queued"])));
      perDay = Math.ceil((left?.n ?? 0) / sendingDaysUntil(bc.schedule, now, new Date(bc.schedule.endBy)));
    } else perDay = dailyLimit === -1 ? Number.POSITIVE_INFINITY : Math.floor(dailyLimit * DEFAULT_SHARE);

    const dayStart = startOfLocalDay(now, bc.schedule.timezone);
    // Claimed today (queued ones included: sent_at is set when claimed).
    const [today] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(r)
      .where(
        and(
          eq(r.broadcastId, bc.id),
          sql`${r.sentAt} >= ${dayStart}`,
          inArray(r.status, ["queued", "sent", "delivered", "read", "failed"]),
        ),
      );
    const usedToday = today?.n ?? 0;
    // Even pacing: by this point in the window, at most this share of the day's quota.
    const paced = Number.isFinite(perDay)
      ? Math.ceil(perDay * win.fraction) - usedToday
      : Number.POSITIVE_INFINITY;
    // The portfolio's room, shared with chats and other broadcasts.
    const room =
      dailyLimit === -1
        ? Number.POSITIVE_INFINITY
        : dailyLimit - (await portfolioUsed(bc.organizationId, account.type));
    // The number's speed, minus a back-off when the channel asked to slow down.
    const slow = await redis.get(`bc:slow:${account.id}`);
    const speed = caps.perSecond * TICK_SECONDS * (slow ? 0.25 : 1);
    return Math.max(0, Math.floor(Math.min(paced, room, speed, perDay - usedToday)));
  }

  /** The value of each template detail for one contact; null when a required one is missing. */
  function valuesFor(
    content: Extract<BroadcastContent, { kind: "template" }>,
    tc: TemplateContent,
    contact: typeof schema.contact.$inferSelect,
  ) {
    const out: Record<string, string> = {};
    for (const name of templateVariables(tc)) {
      const spec = content.values[name];
      let v: string | null | undefined = null;
      if (spec?.source === "static") v = spec.text;
      else if (spec?.source === "field") {
        const key = spec.key;
        v =
          key === "name"
            ? contact.name
            : key === "first_name"
              ? (contact.name?.trim().split(/\s+/)[0] ?? null)
              : key === "phone"
                ? contact.phone
                : key === "email"
                  ? contact.email
                  : (() => {
                      const raw = (contact.attributes as Record<string, unknown>)[key];
                      return raw === undefined || raw === null
                        ? null
                        : Array.isArray(raw)
                          ? raw.join(", ")
                          : String(raw);
                    })();
        if (!v?.toString().trim()) v = spec.fallback ?? null;
      }
      if (!v?.toString().trim()) return null;
      out[name] = String(v).trim().slice(0, 1000);
    }
    return out;
  }

  /** The customer's identity and chat on this channel, made if they never wrote (quiet: closed). */
  async function chatFor(bc: Broadcast, account: Account, contactId: string, address: string) {
    const ci = schema.contactIdentity;
    let [identity] = await db
      .select()
      .from(ci)
      .where(and(eq(ci.contactId, contactId), eq(ci.channelType, account.type), eq(ci.branchId, bc.branchId)))
      .limit(1);
    if (!identity) {
      const scope = String((account.providerMeta as { wabaId?: string }).wabaId ?? account.externalId);
      await db
        .insert(ci)
        .values({
          id: newId("contactIdentity"),
          organizationId: bc.organizationId,
          contactId,
          branchId: bc.branchId,
          channelType: account.type,
          scope,
          externalId: address,
          phone: address,
        })
        .onConflictDoNothing();
      [identity] = await db
        .select()
        .from(ci)
        .where(
          and(
            eq(ci.organizationId, bc.organizationId),
            eq(ci.branchId, bc.branchId),
            eq(ci.channelType, account.type),
            eq(ci.scope, scope),
            eq(ci.externalId, address),
          ),
        )
        .limit(1);
    }
    if (!identity) return null;
    const cv = schema.conversation;
    await db
      .insert(cv)
      .values({
        id: newId("conversation"),
        organizationId: bc.organizationId,
        branchId: bc.branchId,
        channelAccountId: account.id,
        kind: "direct",
        contactId: identity.contactId,
        contactIdentityId: identity.id,
        // A broadcast never opens a chat; the customer's reply does.
        status: "closed",
      })
      .onConflictDoNothing();
    const [conversation] = await db
      .select({ id: cv.id })
      .from(cv)
      .where(
        and(
          eq(cv.channelAccountId, account.id),
          eq(cv.contactIdentityId, identity.id),
          eq(cv.kind, "direct"),
        ),
      )
      .limit(1);
    return conversation ?? null;
  }

  async function dispatch(bc: Broadcast, account: Account) {
    const n = await allowance(bc, account);
    if (n <= 0) return 0;
    const claimed = await db.execute<{ id: string; contact_id: string | null; address: string }>(sql`
      update broadcast_recipient set status = 'queued', sent_at = ${utcNow}, updated_at = ${utcNow},
        attempts = attempts + 1
      where id in (
        select id from broadcast_recipient
        where broadcast_id = ${bc.id} and status = 'pending' and (retry_at is null or retry_at <= ${utcNow})
        order by id limit ${n} for update skip locked)
      returning id, contact_id, address`);
    if (!claimed.length) return 0;

    const template = await templateOf(bc);
    const tc = template?.content as unknown as TemplateContent | undefined;
    const content = bc.content;
    const contactIds = claimed.map((x) => x.contact_id).filter((x): x is string => !!x);
    const contacts = new Map(
      contactIds.length
        ? (await db.select().from(schema.contact).where(inArray(schema.contact.id, contactIds))).map((c) => [
            c.id,
            c,
          ])
        : [],
    );
    // Opted out since the broadcast started (marketing only).
    const optedOut = new Set(
      template?.purpose === "marketing" && contactIds.length
        ? (
            await db
              .select({ id: schema.contactOptOut.contactId })
              .from(schema.contactOptOut)
              .where(
                and(
                  inArray(schema.contactOptOut.contactId, contactIds),
                  sql`(${schema.contactOptOut.channelAccountId} is null or ${schema.contactOptOut.channelAccountId} = ${account.id})`,
                ),
              )
          ).map((x) => x.id)
        : [],
    );
    const skip = (id: string, reason: string) =>
      db.update(r).set({ status: "skipped", skipReason: reason, updatedAt: new Date() }).where(eq(r.id, id));

    const queue: string[] = [];
    for (const rec of claimed) {
      const contact = rec.contact_id ? contacts.get(rec.contact_id) : undefined;
      if (!contact) {
        await skip(rec.id, "contact_deleted");
        continue;
      }
      if (optedOut.has(contact.id)) {
        await skip(rec.id, "opted_out");
        continue;
      }
      if (content.kind !== "template" || !template || !tc) {
        await skip(rec.id, "unsupported");
        continue;
      }
      const values = valuesFor(content, tc, contact);
      if (!values) {
        await skip(rec.id, "missing_value");
        continue;
      }
      const chat = await chatFor(bc, account, contact.id, rec.address);
      if (!chat) {
        await skip(rec.id, "no_address");
        continue;
      }
      const messageId = newId("message");
      const messageContent = {
        type: "template",
        templateId: template.id,
        templateName: template.name,
        name: template.slug,
        language: template.language,
        values,
        header:
          tc.header?.kind === "text"
            ? { kind: "text", text: fillVariables(tc.header.text, values) }
            : (tc.header ?? null),
        body: fillVariables(tc.body, values),
        footer: tc.footer,
        buttons: tc.buttons,
        auth: !!tc.auth,
        broadcastName: bc.name,
      };
      // The message and the recipient's link to it are saved together; the job is queued after.
      await db.transaction(async (tx) => {
        await tx.insert(schema.message).values({
          id: messageId,
          organizationId: bc.organizationId,
          conversationId: chat.id,
          channelAccountId: account.id,
          direction: "outbound",
          senderType: "system",
          senderUserId: bc.createdByUserId,
          type: "template",
          content: messageContent,
          status: "queued",
          sentAt: new Date(),
          broadcastId: bc.id,
        });
        await tx.update(r).set({ messageId, updatedAt: new Date() }).where(eq(r.id, rec.id));
      });
      queue.push(messageId);
    }
    if (queue.length)
      await outbox.addBulk(
        queue.map((id) => ({
          name: "send",
          data: { messageId: id },
          opts: { jobId: id, ...outboxJobOptions },
        })),
      );
    return queue.length;
  }

  /* ------------------------------------------------------------------ sync */

  const rank: Record<string, number> = {
    pending: 0,
    queued: 1,
    sent: 2,
    delivered: 3,
    read: 4,
    failed: 5,
    skipped: 5,
  };

  /** Brings recipients up to date with their messages, and acts on failures. */
  async function sync(bc: Broadcast, account: Account | null) {
    const rows = await db.execute<{
      id: string;
      contact_id: string | null;
      attempts: number;
      message_id: string;
      m_status: string;
      m_error: Record<string, unknown> | null;
      r_status: string;
    }>(sql`
      select r.id, r.contact_id, r.attempts, r.message_id, r.status as r_status, m.status as m_status, m.error as m_error
      from broadcast_recipient r join message m on m.id = r.message_id
      where r.broadcast_id = ${bc.id} and r.status in ('queued', 'sent', 'delivered')
        and m.status in ('accepted', 'sent', 'delivered', 'read', 'failed')`);
    const adapter = account ? channels().get(account.type) : null;
    for (const row of rows) {
      const next = row.m_status === "accepted" ? "sent" : row.m_status;
      if ((rank[next] ?? 0) <= (rank[row.r_status] ?? 0)) continue;
      if (next !== "failed") {
        await db
          .update(r)
          .set({ status: next as never, updatedAt: new Date() })
          .where(eq(r.id, row.id));
        continue;
      }
      const err = row.m_error ?? {};
      const first = (err.errors as { code?: number; message?: string; title?: string }[] | undefined)?.[0];
      const code = (err.code as number | string | undefined) ?? first?.code ?? null;
      const text = (err.message as string | undefined) ?? first?.message ?? first?.title ?? "";
      const action: BroadcastErrorAction = adapter?.broadcastError?.(code, text) ?? {
        action: "final",
        reason: text || "Failed",
      };
      await onFailure(bc, account, row, action, code);
    }
  }

  async function onFailure(
    bc: Broadcast,
    account: Account | null,
    row: { id: string; contact_id: string | null; attempts: number; message_id: string },
    action: BroadcastErrorAction,
    code: number | string | null,
  ) {
    const codeText = code === null ? null : String(code);
    // Try this person again later (the failed message is removed, so their chat stays clean).
    const again = async (afterMs: number) => {
      await db.transaction(async (tx) => {
        await tx
          .update(r)
          .set({
            status: "pending",
            messageId: null,
            retryAt: new Date(Date.now() + afterMs),
            errorCode: codeText,
            updatedAt: new Date(),
          })
          .where(eq(r.id, row.id));
        await tx.delete(schema.message).where(eq(schema.message.id, row.message_id));
      });
    };
    const final = (reason: string) =>
      db
        .update(r)
        .set({ status: "failed", errorCode: codeText, error: reason, updatedAt: new Date() })
        .where(eq(r.id, row.id));

    switch (action.action) {
      case "retry":
        if (row.attempts < MAX_ATTEMPTS) await again(action.afterMs);
        else await final(action.reason);
        return;
      case "slow":
        if (account) await redis.set(`bc:slow:${account.id}`, "1", "PX", action.afterMs);
        await again(action.afterMs);
        return;
      case "opt_out":
        await final(action.reason);
        if (row.contact_id && account)
          await db
            .insert(schema.contactOptOut)
            .values({
              id: newId("contactOptOut"),
              organizationId: bc.organizationId,
              contactId: row.contact_id,
              channelAccountId: account.id,
              source: "reply",
            })
            .onConflictDoNothing();
        return;
      case "pause":
        // Not this person's fault: they'll be sent to after resuming.
        await again(0);
        await pause(bc.id, action.pauseReason, action.reason);
        return;
      case "stop":
        await final(action.reason);
        await stop(bc.id, action.pauseReason, action.reason);
        return;
      default:
        await final(action.reason);
    }
  }

  /* ------------------------------------------------------------------ rollup */

  async function rollup(id: string, withReplies = false) {
    if (withReplies)
      await db.execute(sql`
        update broadcast_recipient r set replied_at = x.at from (
          select r2.id, min(m2.sent_at) as at from broadcast_recipient r2
          join message m on m.id = r2.message_id
          join message m2 on m2.conversation_id = m.conversation_id and m2.direction = 'inbound'
            and m2.sent_at > m.sent_at and m2.sent_at < m.sent_at + interval '72 hours'
          where r2.broadcast_id = ${id} and r2.replied_at is null and r2.sent_at > ${utcNow} - interval '72 hours'
          group by r2.id) x
        where r.id = x.id`);
    const [t] = await db.execute<Record<string, number>>(sql`
      select count(*)::int as total,
        count(*) filter (where status in ('pending', 'queued'))::int as pending,
        count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
        count(*) filter (where status in ('delivered', 'read'))::int as delivered,
        count(*) filter (where status = 'read')::int as read,
        count(*) filter (where replied_at is not null)::int as replied,
        count(*) filter (where status = 'failed')::int as failed,
        count(*) filter (where status = 'skipped')::int as skipped
      from broadcast_recipient where broadcast_id = ${id}`);
    if (!t) return;
    await db
      .update(b)
      .set({
        total: t.total ?? 0,
        pending: t.pending ?? 0,
        sent: t.sent ?? 0,
        delivered: t.delivered ?? 0,
        read: t.read ?? 0,
        replied: t.replied ?? 0,
        failed: t.failed ?? 0,
        skipped: t.skipped ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(b.id, id));
    // Nobody left to send to: done.
    if (!t.pending)
      await db
        .update(b)
        .set({ status: "completed", completedAt: new Date(), pauseDetail: null })
        .where(and(eq(b.id, id), eq(b.status, "sending")));
  }

  /* ------------------------------------------------------------------ tick */

  async function tick() {
    ticks++;
    // Due broadcasts start; one stuck in "preparing" (a crash mid-way) prepares again.
    const due = await db
      .update(b)
      .set({
        status: "preparing",
        startedAt: sql`coalesce(${b.startedAt}, ${utcNow})`,
        updatedAt: new Date(),
      })
      .where(
        sql`(${b.status} = 'scheduled' and (${b.schedule} ->> 'startAt' is null or (${b.schedule} ->> 'startAt')::timestamptz <= now()))
          or (${b.status} = 'preparing' and ${b.updatedAt} < ${utcNow} - interval '2 minutes')`,
      )
      .returning();
    for (const bc of due) {
      try {
        const account = bc.channelAccountId ? await accountById(bc.channelAccountId) : null;
        if (account) await refreshHealth(account);
        await prepare(bc);
      } catch (err) {
        console.error(`broadcast ${bc.id} prepare failed`, err);
        await setStatus(bc.id, "failed", "prepare", (err as Error).message.slice(0, 300));
      }
    }

    const active = await db
      .select()
      .from(b)
      .where(inArray(b.status, ["sending", "paused"]));
    let sent = 0;
    for (const bc of active) {
      try {
        let account = bc.channelAccountId ? await accountById(bc.channelAccountId) : null;
        await sync(bc, account);
        if (bc.status === "sending") {
          // Fresh from the provider once an hour.
          if (account && ticks % 360 === 1) account = await refreshHealth(account);
          const [now] = await db.select().from(b).where(eq(b.id, bc.id)).limit(1);
          if (now?.status === "sending" && (await healthy(now, account)) && account)
            sent += await dispatch(now, account);
        }
        await rollup(bc.id, ticks % 6 === 0);
      } catch (err) {
        console.error(`broadcast ${bc.id} tick failed`, err);
      }
    }
    // Totals keep moving (delivered, read, replies) for a few days after the last message.
    if (ticks % 6 === 0) {
      const recent = await db
        .select({ id: b.id })
        .from(b)
        .where(and(eq(b.status, "completed"), sql`${b.completedAt} > ${utcNow} - interval '3 days'`));
      for (const x of recent) {
        const bc = await one(x.id);
        if (!bc) continue;
        const account = bc.channelAccountId ? await accountById(bc.channelAccountId) : null;
        await sync(bc, account).catch((err) => console.warn(`broadcast ${bc.id} sync`, err));
        await rollup(bc.id, true);
      }
    }
    return { started: due.length, active: active.length, queued: sent };
  }

  async function one(id: string) {
    const [x] = await db.select().from(b).where(eq(b.id, id)).limit(1);
    return x;
  }

  /**
   * After a crash: recipients claimed but never queued go back to pending; ones whose message is still
   * waiting get their outbox job again (the message id is the job id, so it's never doubled).
   */
  async function reconcile() {
    const lost = await db.execute<{ id: string }>(sql`
      update broadcast_recipient set status = 'pending', updated_at = ${utcNow}
      where status = 'queued' and message_id is null and updated_at < ${utcNow} - interval '5 minutes'
      returning id`);
    const waiting = await db.execute<{ message_id: string }>(sql`
      select r.message_id from broadcast_recipient r join message m on m.id = r.message_id
      where r.status = 'queued' and m.status = 'queued' and r.updated_at < ${utcNow} - interval '5 minutes'
      limit 5000`);
    if (waiting.length)
      await outbox.addBulk(
        waiting.map((w) => ({
          name: "send",
          data: { messageId: w.message_id },
          opts: { jobId: w.message_id, ...outboxJobOptions },
        })),
      );
    return { requeuedClaims: lost.length, requeuedJobs: waiting.length };
  }

  return { tick, reconcile, prepare, dispatch, sync, rollup };
}
