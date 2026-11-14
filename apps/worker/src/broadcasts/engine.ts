import { type BroadcastErrorAction, identityScope } from "@relay/channels";
import { newId } from "@relay/core";
import { templateMessage, valuesFor } from "@relay/core/broadcasts";
import type { TemplateContent } from "@relay/core/templates";
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
import { type BroadcastRules, type BroadcastValues, defaultBroadcastRules } from "@relay/db/schema";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { OutboxJob } from "../channels/outbox";
import { accountRef, channels } from "../channels/registry";
import { nextSendTime, perDayFor, retryOf, startOfLocalDay, windowState } from "./schedule";

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
    await assignVariants(bc);
    await rollup(bc.id);
    await db
      .update(b)
      .set({ status: "sending", startedAt: bc.startedAt ?? new Date(), updatedAt: new Date() })
      .where(and(eq(b.id, bc.id), eq(b.status, "preparing")));
  }

  /** A/B: a random share of people get A, the same share B, the rest wait for the winner. */
  async function assignVariants(bc: Broadcast) {
    if (!bc.test || bc.content.kind !== "template" || !bc.content.variantB) return;
    const share = Math.min(0.5, Math.max(0.01, bc.test.share / 100));
    await db.execute(sql`
      with p as (
        select id, row_number() over (order by random()) as rn, count(*) over () as n
        from broadcast_recipient where broadcast_id = ${bc.id} and status = 'pending' and variant is null)
      update broadcast_recipient r set variant = case
          when p.rn <= ceil(p.n * ${share}::float) then 'A'
          when p.rn <= 2 * ceil(p.n * ${share}::float) then 'B'
          else 'rest' end
      from p where r.id = p.id`);
  }

  async function accountById(id: string) {
    const [a] = await db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, id))
      .limit(1);
    return a ?? null;
  }

  async function templateById(id: string) {
    const [t] = await db
      .select()
      .from(schema.messageTemplate)
      .where(eq(schema.messageTemplate.id, id))
      .limit(1);
    return t ?? null;
  }

  async function templateOf(bc: Broadcast) {
    return bc.content.kind === "template" ? templateById(bc.content.templateId) : null;
  }

  /** Marketing when any template it may send is marketing (A/B can mix). */
  async function isMarketing(bc: Broadcast) {
    const t = await templateOf(bc);
    const tb =
      bc.content.kind === "template" && bc.content.variantB
        ? await templateById(bc.content.variantB.templateId)
        : null;
    return t ? t.purpose === "marketing" || tb?.purpose === "marketing" : true;
  }

  async function rulesOf(organizationId: string): Promise<BroadcastRules> {
    const [row] = await db
      .select({ broadcast: schema.organizationSettings.broadcast })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, organizationId))
      .limit(1);
    return { ...defaultBroadcastRules, ...(row?.broadcast ?? {}) };
  }

  /* ------------------------------------------------------------------ health */

  /** Pauses (or stops) when something makes sending unsafe. Returns false when it did. */
  async function healthy(bc: Broadcast, account: Account | null): Promise<boolean> {
    if (account?.status !== "active") {
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
    const templateIds =
      bc.content.kind === "template"
        ? [bc.content.templateId, ...(bc.content.variantB ? [bc.content.variantB.templateId] : [])]
        : [];
    for (const templateId of templateIds) {
      const [copy] = await db
        .select({ status: schema.templateChannel.status, quality: schema.templateChannel.quality })
        .from(schema.templateChannel)
        .where(
          and(
            eq(schema.templateChannel.templateId, templateId),
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
    let left = 0;
    if (!bc.schedule.perDay && bc.schedule.endBy) {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(r)
        .where(and(eq(r.broadcastId, bc.id), inArray(r.status, ["pending", "queued"])));
      left = row?.n ?? 0;
    }
    const perDay = perDayFor(bc.schedule, left, dailyLimit, now);

    const dayStart = startOfLocalDay(now, bc.schedule.timezone);
    // Claimed today (queued ones included: sent_at is set when claimed).
    const [today] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(r)
      .where(
        and(
          eq(r.broadcastId, bc.id),
          // Stored as UTC without a zone; the driver can't take a Date here.
          sql`${r.sentAt} >= (${dayStart.toISOString()}::timestamptz at time zone 'utc')`,
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

  /** The customer's identity and chat on this channel, made if they never wrote (quiet: closed). */
  async function chatFor(bc: Broadcast, account: Account, contactId: string, address: string) {
    const ci = schema.contactIdentity;
    let [identity] = await db
      .select()
      .from(ci)
      .where(and(eq(ci.contactId, contactId), eq(ci.channelType, account.type), eq(ci.branchId, bc.branchId)))
      .limit(1);
    if (!identity) {
      const scope = identityScope(
        account.providerMeta,
        String((account.providerMeta as { wabaId?: string }).wabaId ?? account.externalId),
      );
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
    // A/B: until a winner is picked only the two test groups go out.
    const waitForWinner = bc.test && !bc.winner ? sql`and (variant is null or variant <> 'rest')` : sql``;
    const claimed = await db.execute<{
      id: string;
      contact_id: string | null;
      address: string;
      variant: string | null;
    }>(sql`
      update broadcast_recipient set status = 'queued', sent_at = ${utcNow}, updated_at = ${utcNow},
        attempts = attempts + 1
      where id in (
        select id from broadcast_recipient
        where broadcast_id = ${bc.id} and status = 'pending' and (retry_at is null or retry_at <= ${utcNow})
          ${waitForWinner}
        order by id limit ${n} for update skip locked)
      returning id, contact_id, address, variant`);
    if (!claimed.length) return 0;
    if (bc.content.kind !== "template") {
      for (const rec of claimed)
        await db
          .update(r)
          .set({ status: "skipped", skipReason: "unsupported", updatedAt: new Date() })
          .where(eq(r.id, rec.id));
      return 0;
    }

    // What each variant sends.
    const content = bc.content;
    const variants = new Map<
      string,
      { template: typeof schema.messageTemplate.$inferSelect; tc: TemplateContent; values: BroadcastValues }
    >();
    const a = await templateById(content.templateId);
    if (a)
      variants.set("A", { template: a, tc: a.content as unknown as TemplateContent, values: content.values });
    if (content.variantB) {
      const tb = await templateById(content.variantB.templateId);
      if (tb)
        variants.set("B", {
          template: tb,
          tc: tb.content as unknown as TemplateContent,
          values: content.variantB.values,
        });
    }
    const variantOf = (v: string | null) => {
      const key = v === "B" ? "B" : v === "rest" ? (bc.winner?.key ?? "A") : "A";
      return { key, spec: variants.get(key) };
    };

    const contactIds = claimed.map((x) => x.contact_id).filter((x): x is string => !!x);
    const contacts = new Map(
      contactIds.length
        ? (await db.select().from(schema.contact).where(inArray(schema.contact.id, contactIds))).map((c) => [
            c.id,
            c,
          ])
        : [],
    );
    const anyMarketing = [...variants.values()].some((v) => v.template.purpose === "marketing");
    // Opted out since the broadcast started (marketing only).
    const optedOut = new Set(
      anyMarketing && contactIds.length
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
    // The business's rules: a weekly cap on marketing per person, and leave live chats alone.
    const rules = await rulesOf(bc.organizationId);
    const capped = new Set<string>();
    if (anyMarketing && rules.frequencyCap && contactIds.length) {
      const rows = await db.execute<{ contact_id: string }>(sql`
        select c.contact_id from message m
        join conversation c on c.id = m.conversation_id
        join message_template t on t.id = m.content ->> 'templateId'
        where c.contact_id in (${sql.join(
          contactIds.map((id) => sql`${id}`),
          sql`, `,
        )})
          and m.direction = 'outbound' and m.type = 'template' and m.status <> 'failed'
          and t.purpose = 'marketing' and coalesce((m.content ->> 'test')::boolean, false) = false
          and m.sent_at > ${utcNow} - interval '7 days'
        group by c.contact_id having count(*) >= ${rules.frequencyCap}`);
      for (const x of rows) capped.add(x.contact_id);
    }
    const live = new Set<string>();
    if (rules.skipLiveChats && contactIds.length) {
      const rows = await db
        .selectDistinct({ id: schema.conversation.contactId })
        .from(schema.conversation)
        .where(
          and(
            inArray(schema.conversation.contactId, contactIds),
            eq(schema.conversation.status, "open"),
            sql`${schema.conversation.assignedUserId} is not null`,
          ),
        );
      for (const x of rows) if (x.id) live.add(x.id);
    }
    const skip = (id: string, reason: string) =>
      db.update(r).set({ status: "skipped", skipReason: reason, updatedAt: new Date() }).where(eq(r.id, id));

    const queue: string[] = [];
    for (const rec of claimed) {
      const contact = rec.contact_id ? contacts.get(rec.contact_id) : undefined;
      if (!contact) {
        await skip(rec.id, "contact_deleted");
        continue;
      }
      const { key, spec } = variantOf(rec.variant);
      if (!spec) {
        await skip(rec.id, "unsupported");
        continue;
      }
      const marketing = spec.template.purpose === "marketing";
      if (marketing && optedOut.has(contact.id)) {
        await skip(rec.id, "opted_out");
        continue;
      }
      if (marketing && capped.has(contact.id)) {
        await skip(rec.id, "frequency_cap");
        continue;
      }
      if (live.has(contact.id)) {
        await skip(rec.id, "in_live_chat");
        continue;
      }
      const values = valuesFor(spec.values, spec.tc, contact);
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
      const messageContent = templateMessage(spec.template, spec.tc, values, {
        broadcastName: bc.name,
        ...(variants.size > 1 ? { variant: key } : {}),
      });
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

  /* ------------------------------------------------------------------ A/B winner */

  /** The read (or reply) rate of each test group. */
  async function testRates(bc: Broadcast) {
    const rows = await db.execute<{
      variant: string;
      sent: number;
      read: number;
      replied: number;
      waiting: number;
      last: string | null;
    }>(sql`
      select variant,
        count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
        count(*) filter (where status = 'read')::int as read,
        count(*) filter (where replied_at is not null)::int as replied,
        count(*) filter (where status in ('pending', 'queued'))::int as waiting,
        max(sent_at)::text as last
      from broadcast_recipient where broadcast_id = ${bc.id} and variant in ('A', 'B')
      group by variant`);
    const metric = bc.test?.metric ?? "read";
    const rate = (k: string) => {
      const x = rows.find((y) => y.variant === k);
      return x?.sent ? (metric === "read" ? x.read : x.replied) / x.sent : 0;
    };
    const waiting = rows.reduce((n, x) => n + x.waiting, 0);
    const last =
      rows
        .map((x) => x.last)
        .filter(Boolean)
        .sort()
        .pop() ?? null;
    return { A: rate("A"), B: rate("B"), waiting, last };
  }

  /** Once both groups are out and the test time has passed, the better one goes to everyone else. */
  async function decideWinner(bc: Broadcast) {
    if (!bc.test || bc.winner) return;
    const t = await testRates(bc);
    if (t.waiting || !t.last) return;
    // Stored as UTC without a zone.
    const lastAt = new Date(`${t.last.replace(" ", "T")}Z`);
    if (Date.now() < lastAt.getTime() + bc.test.decideAfterHours * 3_600_000) return;
    if (bc.test.metric === "replied") await rollup(bc.id, true);
    const fresh = bc.test.metric === "replied" ? await testRates(bc) : t;
    const winner = {
      key: fresh.B > fresh.A ? ("B" as const) : ("A" as const),
      rates: { A: fresh.A, B: fresh.B },
      decidedAt: new Date().toISOString(),
      by: "auto" as const,
    };
    await db
      .update(b)
      .set({ winner, updatedAt: new Date() })
      .where(and(eq(b.id, bc.id), sql`${b.winner} is null`));
    console.log(
      `broadcast ${bc.id}: ${winner.key} won (A ${winner.rates.A.toFixed(2)}, B ${winner.rates.B.toFixed(2)})`,
    );
  }

  /* ------------------------------------------------------------------ follow-ups */

  /**
   * A finished broadcast with a follow-up: once its last message is old enough, a child broadcast
   * goes to the people who didn't respond (same channel, hours and retry), minus anyone who opted out.
   */
  async function startFollowUps() {
    const due = await db.execute<{ id: string }>(sql`
      select p.id from broadcast p
      where p.status = 'completed' and p.follow_up is not null and p.kind = 'main'
        and not exists (select 1 from broadcast c where c.parent_id = p.id)
        and (select max(sent_at) from broadcast_recipient where broadcast_id = p.id)
          < ${utcNow} - make_interval(hours => (p.follow_up ->> 'hours')::int)
      limit 20`);
    for (const { id } of due) {
      try {
        await startFollowUp(id);
      } catch (err) {
        console.error(`broadcast ${id} follow-up failed`, err);
      }
    }
  }

  async function startFollowUp(parentId: string) {
    const parent = await one(parentId);
    const fu = parent?.followUp;
    if (!parent || !fu || !parent.channelAccountId) return;
    const template = await templateById(fu.templateId);
    if (!template) return;
    // Replies up to date before choosing who didn't reply.
    await rollup(parentId, true);
    const who =
      fu.who === "not_delivered"
        ? sql`r.status = 'sent'`
        : fu.who === "not_read"
          ? sql`r.status in ('sent', 'delivered')`
          : sql`r.status in ('sent', 'delivered', 'read') and r.replied_at is null`;
    const optedOut =
      template.purpose === "marketing"
        ? sql`exists (select 1 from contact_opt_out o where o.contact_id = r.contact_id
            and (o.channel_account_id is null or o.channel_account_id = ${parent.channelAccountId}))`
        : sql`false`;
    const childId = newId("broadcast");
    const made = await db.transaction(async (tx) => {
      // One child per parent, even with two workers ticking.
      const [lock] = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${parentId})) as ok`,
      );
      if (!lock?.ok) return false;
      const [exists] = await tx.select({ id: b.id }).from(b).where(eq(b.parentId, parentId)).limit(1);
      if (exists) return false;
      await tx.insert(b).values({
        id: childId,
        organizationId: parent.organizationId,
        branchId: parent.branchId,
        name: `${parent.name} · follow-up`,
        channelType: parent.channelType,
        channelAccountId: parent.channelAccountId,
        content: { kind: "template", templateId: fu.templateId, values: fu.values },
        audience: parent.audience,
        schedule: { ...parent.schedule, startAt: null, endBy: null },
        status: "sending",
        kind: "follow_up",
        parentId,
        createdByUserId: parent.createdByUserId,
        startedAt: new Date(),
      });
      await tx.execute(sql`
        insert into broadcast_recipient (id, broadcast_id, contact_id, address, status, skip_reason)
        select 'bcr_' || replace(gen_random_uuid()::text, '-', ''), ${childId}, r.contact_id, r.address,
          (case when r.contact_id is null or ${optedOut} then 'skipped' else 'pending' end)::broadcast_recipient_status,
          case when r.contact_id is null then 'contact_deleted' when ${optedOut} then 'opted_out' end
        from broadcast_recipient r where r.broadcast_id = ${parentId} and ${who}
        on conflict (broadcast_id, address) do nothing`);
      return true;
    });
    if (!made) return;
    await rollup(childId);
    console.log(`broadcast ${parentId}: follow-up ${childId} started`);
  }

  /* ------------------------------------------------------------------ sync */

  const rank: Record<string, number> = {
    pending: 0,
    queued: 1,
    sent: 2,
    delivered: 3,
    read: 4,
    failed: 5,
    held_back: 5,
    skipped: 5,
  };

  /** Brings recipients up to date with their messages, and acts on failures. */
  async function sync(bc: Broadcast, account: Account | null) {
    const rows = await db.execute<{
      id: string;
      contact_id: string | null;
      attempts: number;
      holds: number;
      message_id: string;
      m_status: string;
      m_error: Record<string, unknown> | null;
      r_status: string;
    }>(sql`
      select r.id, r.contact_id, r.attempts, r.holds, r.message_id, r.status as r_status, m.status as m_status, m.error as m_error
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
    row: { id: string; contact_id: string | null; attempts: number; holds: number; message_id: string },
    action: BroadcastErrorAction,
    code: number | string | null,
  ) {
    const codeText = code === null ? null : String(code);
    // Try this person again later (the failed message is removed, so their chat stays clean).
    const again = async (afterMs: number, at?: Date, held = false) => {
      await db.transaction(async (tx) => {
        await tx
          .update(r)
          .set({
            status: "pending",
            messageId: null,
            retryAt: at ?? new Date(Date.now() + afterMs),
            errorCode: codeText,
            ...(held ? { holds: sql`${r.holds} + 1` } : {}),
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
        // Held-back retries don't use up the tries for temporary problems.
        if (row.attempts - row.holds < MAX_ATTEMPTS) await again(action.afterMs);
        else await final(action.reason);
        return;
      case "held_back": {
        // Only when the business chose to retry: on the first sending moment after the wait.
        const retry = retryOf(bc.schedule);
        if (retry.enabled && row.holds < retry.attempts) {
          await again(0, nextSendTime(bc.schedule, new Date(Date.now() + action.afterMs)), true);
          return;
        }
        await db
          .update(r)
          .set({
            status: "held_back",
            errorCode: codeText,
            error: action.reason,
            holds: sql`${r.holds} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(r.id, row.id));
        return;
      }
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
        count(*) filter (where status = 'held_back')::int as held_back,
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
        heldBack: t.held_back ?? 0,
        updatedAt: new Date(),
      })
      .where(eq(b.id, id));
    // Nobody left (people waiting for a retry are still pending, so it keeps going until then) to send to: done.
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

    // Stopped elsewhere (the outbox halts a broadcast the moment a bad-template error comes back):
    // whoever is still waiting is skipped.
    const ended = await db.execute<{ broadcast_id: string }>(sql`
      update broadcast_recipient set status = 'skipped', skip_reason = 'stopped', updated_at = ${utcNow}
      where status = 'pending' and broadcast_id in (select id from broadcast where status in ('stopped', 'failed'))
      returning broadcast_id`);
    for (const id of new Set(ended.map((x) => x.broadcast_id))) await rollup(id);

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
          let [now] = await db.select().from(b).where(eq(b.id, bc.id)).limit(1);
          if (now?.test && !now.winner) {
            await decideWinner(now);
            [now] = await db.select().from(b).where(eq(b.id, bc.id)).limit(1);
          }
          if (now?.status === "sending" && (await healthy(now, account)) && account)
            sent += await dispatch(now, account);
        }
        await rollup(bc.id, ticks % 6 === 0);
      } catch (err) {
        console.error(`broadcast ${bc.id} tick failed`, err);
      }
    }
    if (ticks % 6 === 0) await startFollowUps();
    // Totals keep moving (delivered, read, replies) for a few days after the last message.
    if (ticks % 6 === 0) {
      const recent = await db
        .select({ id: b.id })
        .from(b)
        .where(
          and(
            inArray(b.status, ["completed", "stopped"]),
            sql`${b.completedAt} > ${utcNow} - interval '3 days'`,
          ),
        );
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

  return { tick, reconcile, prepare, dispatch, sync, rollup, startFollowUp, decideWinner };
}
