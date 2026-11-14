import { messagePreview, newId } from "@relay/core";
import { planDays, retryOf, templateMessage, valuesFor } from "@relay/core/broadcasts";
import { writeWorkbook } from "@relay/core/sheets";
import { type TemplateContent, templateVariables } from "@relay/core/templates";
import {
  activeFields,
  and,
  asc,
  compileFilter,
  desc,
  eq,
  inArray,
  isNull,
  listsById,
  or,
  schema,
  sql,
} from "@relay/db";
import {
  type BroadcastAudience,
  type BroadcastContent,
  type BroadcastSchedule,
  defaultBroadcastRules,
} from "@relay/db/schema";
import { Hono } from "hono";
import { z } from "zod";
import { accountRef, channels } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch } from "../contacts/shared";

/*
 * Broadcasts, one branch at a time (?branch=). The worker's engine does the sending (see
 * apps/worker/src/broadcasts/engine.ts); these routes create, check, start, pause, resume, stop and
 * report on them.
 *   GET    /api/broadcasts                    list (?channel=whatsapp)
 *   GET    /api/broadcasts/options            channels (with health), ready templates, lists, fields
 *   POST   /api/broadcasts                    create a draft
 *   GET    /api/broadcasts/:id                one broadcast, with failures grouped by reason
 *   PATCH  /api/broadcasts/:id                change a draft or a scheduled one
 *   DELETE /api/broadcasts/:id                delete a draft
 *   POST   /api/broadcasts/:id/preview        who it would reach, who is skipped and why, the end date
 *   POST   /api/broadcasts/:id/start          checks everything, then schedules it (or starts now)
 *   POST   /api/broadcasts/:id/pause|resume|stop
 *   GET    /api/broadcasts/:id/recipients     page of recipients (?status=&after=)
 *   GET    /api/broadcasts/:id/export         recipients as a spreadsheet
 *   GET    /api/broadcasts/:id/test-contacts  people with a chat on its number, for a test send (?q=)
 *   POST   /api/broadcasts/:id/test           send it to up to 5 of them now, labelled "Test"
 *   POST   /api/broadcasts/:id/winner         A/B: pick the winner now
 * Owners, admins and branch managers manage broadcasts; everyone in the branch can see them.
 */

const valueSpec = z.discriminatedUnion("source", [
  z.object({ source: z.literal("static"), text: z.string().max(1000) }),
  z.object({
    source: z.literal("field"),
    key: z.string().max(80),
    fallback: z.string().max(1000).optional(),
  }),
]);
const contentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("template"),
    templateId: z.string(),
    values: z.record(z.string(), valueSpec),
    variantB: z
      .object({ templateId: z.string(), values: z.record(z.string(), valueSpec) })
      .nullable()
      .optional(),
  }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(1600) }),
  z.object({ kind: z.literal("email"), subject: z.string().min(1).max(200), html: z.string().min(1) }),
]);
const audienceSchema = z.object({
  listIds: z.array(z.string()).max(20).default([]),
  excludeListIds: z.array(z.string()).max(20).default([]),
  filter: z.unknown().optional(),
});
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const scheduleSchema = z.object({
  startAt: z.iso.datetime({ offset: true }).nullable().default(null),
  window: z
    .object({ days: z.array(z.number().int().min(1).max(7)).min(1), from: hhmm, to: hhmm })
    .nullable()
    .default(null),
  perDay: z.number().int().min(1).max(10_000_000).nullable().default(null),
  endBy: z.iso.datetime({ offset: true }).nullable().default(null),
  retry: z
    .object({ enabled: z.boolean(), attempts: z.number().int().min(1).max(3) })
    .default({ enabled: true, attempts: 1 }),
});
const followUpSchema = z.object({
  hours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14),
  who: z.enum(["not_read", "not_replied", "not_delivered"]),
  templateId: z.string(),
  values: z.record(z.string(), valueSpec),
});
const testSchema = z.object({
  share: z.number().int().min(5).max(40),
  decideAfterHours: z.number().int().min(1).max(72),
  metric: z.enum(["read", "replied"]),
});
const draftSchema = z.object({
  name: z.string().trim().min(1, "Give the broadcast a name").max(120),
  channelAccountId: z.string(),
  content: contentSchema,
  audience: audienceSchema,
  schedule: scheduleSchema,
  followUp: followUpSchema.nullable().default(null),
  test: testSchema.nullable().default(null),
});

export function broadcastRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  const b = schema.broadcast;
  const r = schema.broadcastRecipient;

  async function canManage(access: Access, branchId: string) {
    if (isOrgAdmin(access.orgRole)) return true;
    const [row] = await ctx.db
      .select({ n: sql<number>`1` })
      .from(schema.branchMember)
      .where(
        and(
          eq(schema.branchMember.branchId, branchId),
          eq(schema.branchMember.userId, access.userId),
          eq(schema.branchMember.role, "manager"),
        ),
      )
      .limit(1);
    return !!row;
  }

  async function find(orgId: string, branchId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(b)
      .where(and(eq(b.id, id), eq(b.organizationId, orgId), eq(b.branchId, branchId)))
      .limit(1);
    return row ?? null;
  }

  /** The branch's channels that can broadcast. */
  async function branchChannels(orgId: string, branchId: string) {
    const ca = schema.channelAccount;
    const rows = await ctx.db
      .select()
      .from(ca)
      .where(
        and(
          eq(ca.organizationId, orgId),
          or(
            eq(ca.defaultBranchId, branchId),
            sql`exists (select 1 from ${schema.channelAccountBranch} x where x.channel_account_id = ${ca.id} and x.branch_id = ${branchId})`,
          ),
        ),
      )
      .orderBy(asc(ca.createdAt));
    return rows.filter((a) => channels().get(a.type)?.capabilities.broadcast);
  }

  async function branchTimezone(branchId: string) {
    const [row] = await ctx.db
      .select({ tz: schema.branch.timezone })
      .from(schema.branch)
      .where(eq(schema.branch.id, branchId))
      .limit(1);
    return row?.tz ?? "UTC";
  }

  const withTimezone = async (
    s: z.infer<typeof scheduleSchema>,
    branchId: string,
  ): Promise<BroadcastSchedule> => ({
    ...s,
    timezone: await branchTimezone(branchId),
  });

  /* ------------------------------------------------------------------ read */

  app.get("/", async (c) => {
    const access = c.var.access;
    const channel = c.req.query("channel");
    const rows = await ctx.db
      .select()
      .from(b)
      .where(
        and(
          eq(b.organizationId, access.orgId),
          eq(b.branchId, c.var.branchId),
          channel && channel !== "all" ? eq(b.channelType, channel) : undefined,
        ),
      )
      .orderBy(desc(b.createdAt))
      .limit(200);
    return c.json({ broadcasts: rows });
  });

  // Everything the create screen needs: channels with their health, ready templates, lists, fields.
  app.get("/options", async (c) => {
    const access = c.var.access;
    const accounts = await branchChannels(access.orgId, c.var.branchId);
    const ids = accounts.map((a) => a.id);
    const templates = ids.length
      ? await ctx.db
          .select({
            id: schema.messageTemplate.id,
            name: schema.messageTemplate.name,
            purpose: schema.messageTemplate.purpose,
            language: schema.messageTemplate.language,
            content: schema.messageTemplate.content,
            channelAccountId: schema.templateChannel.channelAccountId,
            status: schema.templateChannel.status,
            quality: schema.templateChannel.quality,
          })
          .from(schema.templateChannel)
          .innerJoin(schema.messageTemplate, eq(schema.messageTemplate.id, schema.templateChannel.templateId))
          .where(
            and(
              inArray(schema.templateChannel.channelAccountId, ids),
              eq(schema.templateChannel.status, "ready"),
            ),
          )
          .orderBy(asc(schema.messageTemplate.name))
      : [];
    const lists = await ctx.db
      .select({ id: schema.contactList.id, name: schema.contactList.name, kind: schema.contactList.kind })
      .from(schema.contactList)
      .where(
        and(
          eq(schema.contactList.organizationId, access.orgId),
          eq(schema.contactList.branchId, c.var.branchId),
        ),
      )
      .orderBy(asc(schema.contactList.name));
    const fields = await activeFields(ctx.db, access.orgId);
    return c.json({
      channels: accounts.map((a) => {
        const meta = a.providerMeta as {
          messagingLimit?: number | null;
          qualityRating?: string | null;
          qualityFlag?: string | null;
        };
        return {
          id: a.id,
          type: a.type,
          name: a.displayName,
          phone: a.displayPhone,
          status: a.status,
          broadcast: channels().get(a.type)?.capabilities.broadcast ?? null,
          dailyLimit: meta.messagingLimit ?? null,
          quality: meta.qualityFlag === "FLAGGED" ? "RED" : (meta.qualityRating ?? null),
        };
      }),
      templates: templates.map((t) => ({
        ...t,
        variables: templateVariables(t.content as unknown as TemplateContent),
      })),
      lists,
      fields: [
        { key: "first_name", label: "First name" },
        { key: "name", label: "Name" },
        { key: "phone", label: "Phone" },
        { key: "email", label: "Email" },
        ...fields.map((f) => ({ key: f.key, label: f.label })),
      ],
      timezone: await branchTimezone(c.var.branchId),
      canManage: await canManage(access, c.var.branchId),
    });
  });

  app.get("/:id", async (c) => {
    const access = c.var.access;
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    // Why people weren't reached, grouped.
    const reasons = await ctx.db
      .select({
        status: r.status,
        reason: sql<string>`coalesce(${r.skipReason}, ${r.error}, ${r.errorCode}, 'unknown')`,
        n: sql<number>`count(*)::int`,
      })
      .from(r)
      .where(and(eq(r.broadcastId, bc.id), inArray(r.status, ["failed", "held_back", "skipped"])))
      .groupBy(r.status, sql`coalesce(${r.skipReason}, ${r.error}, ${r.errorCode}, 'unknown')`)
      .orderBy(desc(sql`count(*)`));
    const [template] =
      bc.content.kind === "template"
        ? await ctx.db
            .select({
              id: schema.messageTemplate.id,
              name: schema.messageTemplate.name,
              content: schema.messageTemplate.content,
              purpose: schema.messageTemplate.purpose,
            })
            .from(schema.messageTemplate)
            .where(eq(schema.messageTemplate.id, bc.content.templateId))
            .limit(1)
        : [];
    // People waiting to be tried again after Meta held them back.
    const [retrying] = await ctx.db
      .select({ n: sql<number>`count(*)::int`, next: sql<string | null>`min(${r.retryAt})::text` })
      .from(r)
      .where(and(eq(r.broadcastId, bc.id), eq(r.status, "pending"), sql`${r.holds} > 0`));
    // A/B: each group's numbers so far.
    const variants = bc.test
      ? await ctx.db.execute<{
          variant: string;
          total: number;
          sent: number;
          read: number;
          replied: number;
        }>(sql`
          select variant, count(*)::int as total,
            count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
            count(*) filter (where status = 'read')::int as read,
            count(*) filter (where replied_at is not null)::int as replied
          from broadcast_recipient where broadcast_id = ${bc.id} and variant is not null group by variant`)
      : [];
    const templateIds = [
      ...(bc.content.kind === "template" && bc.content.variantB ? [bc.content.variantB.templateId] : []),
      ...(bc.followUp ? [bc.followUp.templateId] : []),
    ];
    const others = templateIds.length
      ? await ctx.db
          .select({ id: schema.messageTemplate.id, name: schema.messageTemplate.name })
          .from(schema.messageTemplate)
          .where(inArray(schema.messageTemplate.id, templateIds))
      : [];
    const related = await ctx.db
      .select({
        id: b.id,
        name: b.name,
        status: b.status,
        kind: b.kind,
        total: b.total,
        sent: b.sent,
        read: b.read,
        replied: b.replied,
      })
      .from(b)
      .where(bc.parentId ? or(eq(b.parentId, bc.id), eq(b.id, bc.parentId)) : eq(b.parentId, bc.id));
    return c.json({
      broadcast: bc,
      reasons,
      template: template ?? null,
      templateNames: Object.fromEntries(others.map((t) => [t.id, t.name])),
      retrying: {
        count: retrying?.n ?? 0,
        next: retrying?.next ? `${retrying.next.replace(" ", "T")}Z` : null,
      },
      variants,
      followUps: related.filter((x) => x.kind === "follow_up" && x.id !== bc.id),
      parent: related.find((x) => x.id === bc.parentId) ?? null,
      canManage: await canManage(access, c.var.branchId),
    });
  });

  app.get("/:id/recipients", async (c) => {
    const access = c.var.access;
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    const status = c.req.query("status");
    const after = c.req.query("after") ?? "";
    const rows = await ctx.db
      .select({
        id: r.id,
        address: r.address,
        status: r.status,
        skipReason: r.skipReason,
        error: r.error,
        errorCode: r.errorCode,
        sentAt: r.sentAt,
        repliedAt: r.repliedAt,
        contactId: r.contactId,
        name: schema.contact.name,
      })
      .from(r)
      .leftJoin(schema.contact, eq(schema.contact.id, r.contactId))
      .where(
        and(
          eq(r.broadcastId, bc.id),
          status ? eq(r.status, status as never) : undefined,
          after ? sql`${r.id} > ${after}` : undefined,
        ),
      )
      .orderBy(asc(r.id))
      .limit(101);
    return c.json({ recipients: rows.slice(0, 100), next: rows.length > 100 ? rows[99]?.id : null });
  });

  app.get("/:id/export", async (c) => {
    const access = c.var.access;
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    const rows = await ctx.db
      .select({
        name: schema.contact.name,
        address: r.address,
        status: r.status,
        reason: sql<string | null>`coalesce(${r.skipReason}, ${r.error})`,
        sentAt: r.sentAt,
        repliedAt: r.repliedAt,
      })
      .from(r)
      .leftJoin(schema.contact, eq(schema.contact.id, r.contactId))
      .where(eq(r.broadcastId, bc.id))
      .orderBy(asc(r.id))
      .limit(200_000);
    const day = (d: Date | null) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : null);
    const bytes = writeWorkbook(
      ["Name", "Phone or email", "Status", "Why", "Sent", "Replied"],
      rows.map((x) => [
        x.name,
        x.address.startsWith("none:") ? null : x.address,
        x.status,
        x.reason,
        day(x.sentAt),
        day(x.repliedAt),
      ]),
      "csv",
    );
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="broadcast-${bc.id}.csv"`,
    });
  });

  /* ------------------------------------------------------------------ write */

  app.post("/", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId)))
      return fail(c, 403, "forbidden", "Only managers can create broadcasts.");
    const parsed = await parseBody(c, draftSchema);
    if ("error" in parsed) return parsed.error;
    const d = parsed.data;
    const account = (await branchChannels(access.orgId, c.var.branchId)).find(
      (a) => a.id === d.channelAccountId,
    );
    if (!account) return fail(c, 422, "invalid_input", "Choose a channel of this branch.");
    const [row] = await ctx.db
      .insert(b)
      .values({
        id: newId("broadcast"),
        organizationId: access.orgId,
        branchId: c.var.branchId,
        name: d.name,
        channelType: account.type,
        channelAccountId: account.id,
        content: d.content as BroadcastContent,
        audience: d.audience as BroadcastAudience,
        schedule: await withTimezone(d.schedule, c.var.branchId),
        followUp: d.followUp,
        test: d.content.kind === "template" && d.content.variantB ? d.test : null,
        createdByUserId: access.userId,
      })
      .returning();
    return c.json({ broadcast: row }, 201);
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    if (bc.status !== "draft" && bc.status !== "scheduled")
      return fail(c, 409, "not_editable", "Only drafts and scheduled broadcasts can be changed.");
    const parsed = await parseBody(c, draftSchema.partial());
    if ("error" in parsed) return parsed.error;
    const d = parsed.data;
    let channel: { type: string; id: string } | undefined;
    if (d.channelAccountId) {
      channel = (await branchChannels(access.orgId, c.var.branchId)).find((a) => a.id === d.channelAccountId);
      if (!channel) return fail(c, 422, "invalid_input", "Choose a channel of this branch.");
    }
    const [row] = await ctx.db
      .update(b)
      .set({
        ...(d.name ? { name: d.name } : {}),
        ...(channel ? { channelAccountId: channel.id, channelType: channel.type } : {}),
        ...(d.content ? { content: d.content as BroadcastContent } : {}),
        ...(d.audience ? { audience: d.audience as BroadcastAudience } : {}),
        ...(d.schedule ? { schedule: await withTimezone(d.schedule, c.var.branchId) } : {}),
        ...(d.followUp !== undefined ? { followUp: d.followUp } : {}),
        ...(d.test !== undefined || d.content
          ? {
              test: (() => {
                const content = d.content ?? bc.content;
                return content.kind === "template" && content.variantB ? (d.test ?? bc.test) : null;
              })(),
            }
          : {}),
        // A change sends a scheduled broadcast back to draft; starting it checks everything again.
        status: "draft",
        updatedAt: new Date(),
      })
      .where(eq(b.id, bc.id))
      .returning();
    return c.json({ broadcast: row });
  });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    if (bc.status !== "draft")
      return fail(c, 409, "not_draft", "Only drafts can be deleted; stop it instead.");
    await ctx.db.delete(b).where(eq(b.id, bc.id));
    return c.body(null, 204);
  });

  /** Who a broadcast would reach now, who'd be skipped and why, and when it would finish. */
  async function estimate(bc: typeof b.$inferSelect) {
    const lists = await listsById(ctx.db, bc.organizationId, bc.branchId);
    const missing = [...bc.audience.listIds, ...bc.audience.excludeListIds].filter((id) => !lists.has(id));
    if (missing.length) return { error: "A list in the audience was deleted." };
    if (!bc.audience.listIds.length && !bc.audience.filter) return { error: "Choose who it goes to." };
    const fields = new Map((await activeFields(ctx.db, bc.organizationId)).map((f) => [f.key, f as never]));
    const rules = [
      ...(bc.audience.listIds.length ? [{ field: "list", op: "has_any", value: bc.audience.listIds }] : []),
      ...(bc.audience.excludeListIds.length
        ? [{ field: "list", op: "has_none", value: bc.audience.excludeListIds }]
        : []),
    ];
    const where = compileFilter({ match: "all", rules } as never, fields, lists);
    const extra = bc.audience.filter ? compileFilter(bc.audience.filter as never, fields, lists) : undefined;
    const account = bc.channelAccountId
      ? (
          await ctx.db
            .select()
            .from(schema.channelAccount)
            .where(eq(schema.channelAccount.id, bc.channelAccountId))
            .limit(1)
        )[0]
      : undefined;
    const caps = account ? channels().get(account.type)?.capabilities.broadcast : null;
    if (!account || !caps) return { error: "Choose a channel." };
    const [template] =
      bc.content.kind === "template"
        ? await ctx.db
            .select()
            .from(schema.messageTemplate)
            .where(eq(schema.messageTemplate.id, bc.content.templateId))
            .limit(1)
        : [];
    const marketing = template ? template.purpose === "marketing" : true;
    const c = schema.contact;
    const address =
      caps.addressKind === "email"
        ? sql`nullif(trim(${c.email}), '')`
        : sql`coalesce(nullif(${c.phone}, ''), (select i.phone from ${schema.contactIdentity} i where i.contact_id = "contact"."id" and i.channel_type = ${account.type} and i.phone is not null limit 1))`;
    const optedOut = marketing
      ? sql`exists (select 1 from ${schema.contactOptOut} o where o.contact_id = "contact"."id" and (o.channel_account_id is null or o.channel_account_id = ${account.id}))`
      : sql`false`;
    const [counts] = await ctx.db.execute<{
      total: number;
      no_address: number;
      opted_out: number;
      reachable: number;
      distinct_addresses: number;
      us_numbers: number;
    }>(sql`
      select count(*)::int as total,
        count(*) filter (where x.address is null)::int as no_address,
        count(*) filter (where x.address is not null and x.opted)::int as opted_out,
        count(*) filter (where x.address is not null and not x.opted)::int as reachable,
        count(distinct x.address) filter (where x.address is not null and not x.opted)::int as distinct_addresses,
        count(*) filter (where x.address like '1%' and not x.opted)::int as us_numbers
      from (select ${address} as address, ${optedOut} as opted from ${c}
        where ${and(eq(c.organizationId, bc.organizationId), eq(c.branchId, bc.branchId), where, extra)}) x`);
    const reach = counts?.distinct_addresses ?? 0;
    const meta = account.providerMeta as { messagingLimit?: number | null };
    const limit = caps.dailyLimit === "portfolio" ? (meta.messagingLimit ?? 250) : -1;
    const plan = planDays(bc.schedule, reach, limit);
    const retry = retryOf(bc.schedule);
    // The business's rules, counted now (they're applied again when each message goes out).
    const [settings] = await ctx.db
      .select({ broadcast: schema.organizationSettings.broadcast })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, bc.organizationId))
      .limit(1);
    const biz = { ...defaultBroadcastRules, ...(settings?.broadcast ?? {}) };
    const audienceIds = sql`select ${c.id} from ${c} where ${and(eq(c.organizationId, bc.organizationId), eq(c.branchId, bc.branchId), where, extra)}`;
    const [ruleCounts] = await ctx.db.execute<{ capped: number; live: number }>(sql`
      select
        ${
          marketing && biz.frequencyCap
            ? sql`(select count(*)::int from (
                select cv.contact_id from message m
                join conversation cv on cv.id = m.conversation_id
                join message_template t on t.id = m.content ->> 'templateId'
                where cv.contact_id in (${audienceIds}) and m.direction = 'outbound' and m.type = 'template'
                  and m.status <> 'failed' and t.purpose = 'marketing'
                  and coalesce((m.content ->> 'test')::boolean, false) = false
                  and m.sent_at > (now() at time zone 'utc') - interval '7 days'
                group by cv.contact_id having count(*) >= ${biz.frequencyCap}) x)`
            : sql`0`
        } as capped,
        ${
          biz.skipLiveChats
            ? sql`(select count(distinct cv.contact_id)::int from conversation cv
                where cv.contact_id in (${audienceIds}) and cv.status = 'open' and cv.assigned_user_id is not null)`
            : sql`0`
        } as live`);
    return {
      total: counts?.total ?? 0,
      reach,
      skipped: {
        noAddress: counts?.no_address ?? 0,
        optedOut: counts?.opted_out ?? 0,
        duplicates: (counts?.reachable ?? 0) - reach,
      },
      // Meta doesn't deliver marketing templates to US numbers.
      usNumbers: marketing && account.type === "whatsapp" ? (counts?.us_numbers ?? 0) : 0,
      dailyLimit: limit,
      perDay: plan.perDay,
      sendingDays: plan.days.length,
      plan: plan.days.slice(0, 14),
      moreDays: Math.max(0, plan.days.length - 14),
      retryDays: retry.enabled ? retry.attempts : 0,
      rules: {
        frequencyCap: marketing ? biz.frequencyCap : null,
        capped: ruleCounts?.capped ?? 0,
        skipLiveChats: biz.skipLiveChats,
        inLiveChat: ruleCounts?.live ?? 0,
      },
      marketing,
    };
  }

  app.post("/:id/preview", async (c) => {
    const bc = await find(c.var.access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    const e = await estimate(bc);
    if ("error" in e) return fail(c, 422, "invalid_input", e.error ?? "Can't estimate");
    return c.json({ estimate: e });
  });

  app.post("/:id/start", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    if (bc.status !== "draft") return fail(c, 409, "not_draft", "This broadcast has already been started.");
    const problems: string[] = [];
    const [account] = bc.channelAccountId
      ? await ctx.db
          .select()
          .from(schema.channelAccount)
          .where(eq(schema.channelAccount.id, bc.channelAccountId))
          .limit(1)
      : [];
    if (account?.status !== "active") problems.push("The channel isn't connected.");
    if (account && bc.content.kind === "template") {
      const [copy] = await ctx.db
        .select({ status: schema.templateChannel.status, content: schema.messageTemplate.content })
        .from(schema.templateChannel)
        .innerJoin(schema.messageTemplate, eq(schema.messageTemplate.id, schema.templateChannel.templateId))
        .where(
          and(
            eq(schema.templateChannel.templateId, bc.content.templateId),
            eq(schema.templateChannel.channelAccountId, account.id),
          ),
        )
        .limit(1);
      if (copy?.status !== "ready") problems.push("The template isn't approved on this channel.");
      else {
        const content = bc.content;
        const unset = templateVariables(copy.content as unknown as TemplateContent).filter(
          (v) => !content.values[v],
        );
        if (unset.length) problems.push(`Fill in: ${unset.join(", ")}.`);
      }
    } else if (bc.content.kind !== "template") problems.push("This channel can only send templates for now.");
    // The A/B template and the follow-up template must be ready too, with their details filled.
    const extraTemplates = [
      ...(bc.content.kind === "template" && bc.content.variantB
        ? [{ label: "template B", ...bc.content.variantB }]
        : []),
      ...(bc.followUp ? [{ label: "the follow-up", ...bc.followUp }] : []),
    ];
    for (const t of account ? extraTemplates : []) {
      const [copy] = await ctx.db
        .select({ status: schema.templateChannel.status, content: schema.messageTemplate.content })
        .from(schema.templateChannel)
        .innerJoin(schema.messageTemplate, eq(schema.messageTemplate.id, schema.templateChannel.templateId))
        .where(
          and(
            eq(schema.templateChannel.templateId, t.templateId),
            eq(schema.templateChannel.channelAccountId, account?.id ?? ""),
          ),
        )
        .limit(1);
      if (copy?.status !== "ready")
        problems.push(`The template for ${t.label} isn't approved on this channel.`);
      else {
        const unset = templateVariables(copy.content as unknown as TemplateContent).filter(
          (v) => !t.values[v],
        );
        if (unset.length) problems.push(`Fill in ${unset.join(", ")} for ${t.label}.`);
      }
    }
    if (bc.content.kind === "template" && bc.content.variantB && !bc.test)
      problems.push("Set how the A/B test picks a winner.");
    const s = bc.schedule;
    if (s.window && s.window.from >= s.window.to) problems.push("Sending hours must end after they start.");
    if (s.startAt && new Date(s.startAt).getTime() < Date.now() - 60_000)
      problems.push("The start time has passed.");
    if (s.endBy && new Date(s.endBy).getTime() <= Date.now()) problems.push("The finish date has passed.");
    // Fresh health from the channel: a RED number shouldn't start a broadcast.
    if (account) {
      const adapter = channels().get(account.type);
      if (adapter?.health)
        try {
          const h = await adapter.health(accountRef(account));
          await ctx.db
            .update(schema.channelAccount)
            .set({
              providerMeta: {
                ...account.providerMeta,
                messagingLimit: h.dailyLimit,
                qualityRating: h.quality,
              },
            })
            .where(eq(schema.channelAccount.id, account.id));
          if (h.quality === "RED")
            problems.push("The number's quality is low (RED). Wait until it recovers.");
        } catch {
          // Health unknown: the engine checks again before sending.
        }
    }
    const e = await estimate(bc);
    if ("error" in e) problems.push(e.error ?? "");
    else if (!e.reach) problems.push("Nobody in the audience can be reached.");
    if (problems.length) return fail(c, 422, "cannot_start", problems.join(" "));
    const [row] = await ctx.db
      .update(b)
      .set({ status: "scheduled", pauseReason: null, pauseDetail: null, updatedAt: new Date() })
      .where(and(eq(b.id, bc.id), eq(b.status, "draft")))
      .returning();
    return c.json({ broadcast: row });
  });

  app.post("/:id/pause", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const [row] = await ctx.db
      .update(b)
      .set({
        status: "paused",
        pauseReason: "manual",
        pauseDetail: "Paused by your team.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(b.id, c.req.param("id")),
          eq(b.organizationId, access.orgId),
          eq(b.branchId, c.var.branchId),
          inArray(b.status, ["sending", "scheduled", "preparing"]),
        ),
      )
      .returning();
    if (!row) return fail(c, 409, "not_running", "Only a sending or scheduled broadcast can be paused.");
    return c.json({ broadcast: row });
  });

  app.post("/:id/resume", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    if (bc.status !== "paused") return fail(c, 409, "not_paused", "Only a paused broadcast can be resumed.");
    // Recipients exist once it started; before that it goes back to waiting for its start.
    const [started] = await ctx.db
      .select({ n: sql<number>`1` })
      .from(r)
      .where(eq(r.broadcastId, bc.id))
      .limit(1);
    const [row] = await ctx.db
      .update(b)
      .set({
        status: started ? "sending" : "scheduled",
        pauseReason: null,
        pauseDetail: null,
        updatedAt: new Date(),
      })
      .where(and(eq(b.id, bc.id), eq(b.status, "paused")))
      .returning();
    return c.json({ broadcast: row });
  });

  app.post("/:id/stop", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    if (!["scheduled", "preparing", "sending", "paused"].includes(bc.status))
      return fail(c, 409, "not_running", "This broadcast isn't running.");
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(b)
        .set({
          status: "stopped",
          pauseReason: "manual",
          pauseDetail: "Stopped by your team.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(b.id, bc.id));
      await tx
        .update(r)
        .set({ status: "skipped", skipReason: "stopped", updatedAt: new Date() })
        .where(and(eq(r.broadcastId, bc.id), eq(r.status, "pending")));
    });
    return c.json({ broadcast: await find(access.orgId, c.var.branchId, bc.id) });
  });

  /* ------------------------------------------------------------------ test send, winner */

  /** People with a chat on the broadcast's number (the only ones a test can go to). */
  app.get("/:id/test-contacts", async (c) => {
    const access = c.var.access;
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc?.channelAccountId) return fail(c, 404, "not_found");
    const q = (c.req.query("q") ?? "").trim();
    const cv = schema.conversation;
    const ct = schema.contact;
    const rows = await ctx.db
      .select({ id: ct.id, name: ct.name, phone: ct.phone, lastMessageAt: cv.lastMessageAt })
      .from(cv)
      .innerJoin(ct, eq(ct.id, cv.contactId))
      .where(
        and(
          eq(cv.channelAccountId, bc.channelAccountId),
          eq(cv.branchId, c.var.branchId),
          eq(cv.kind, "direct"),
          q
            ? or(sql`${ct.name} ilike ${`%${q}%`}`, sql`${ct.phone} like ${`%${q.replace(/\D/g, "")}%`}`)
            : undefined,
        ),
      )
      .orderBy(sql`${cv.lastMessageAt} desc nulls last`)
      .limit(10);
    return c.json({ contacts: rows });
  });

  app.post("/:id/test", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc?.channelAccountId) return fail(c, 404, "not_found");
    const parsed = await parseBody(
      c,
      z.object({ contactIds: z.array(z.string()).min(1).max(5), variant: z.enum(["A", "B"]).default("A") }),
    );
    if ("error" in parsed) return parsed.error;
    if (bc.content.kind !== "template") return fail(c, 422, "invalid_input", "Only templates can be tested.");
    const spec = parsed.data.variant === "B" && bc.content.variantB ? bc.content.variantB : bc.content;
    const [template] = await ctx.db
      .select()
      .from(schema.messageTemplate)
      .innerJoin(schema.templateChannel, eq(schema.templateChannel.templateId, schema.messageTemplate.id))
      .where(
        and(
          eq(schema.messageTemplate.id, spec.templateId),
          eq(schema.templateChannel.channelAccountId, bc.channelAccountId),
        ),
      )
      .limit(1);
    if (template?.template_channel.status !== "ready")
      return fail(c, 422, "invalid_input", "The template isn't approved on this channel.");
    const t = template.message_template;
    const tc = t.content as unknown as TemplateContent;
    const cv = schema.conversation;
    const chats = await ctx.db
      .select({ conversation: cv, contact: schema.contact })
      .from(cv)
      .innerJoin(schema.contact, eq(schema.contact.id, cv.contactId))
      .where(
        and(
          eq(cv.channelAccountId, bc.channelAccountId),
          eq(cv.branchId, c.var.branchId),
          eq(cv.kind, "direct"),
          inArray(cv.contactId, parsed.data.contactIds),
        ),
      );
    if (!chats.length) return fail(c, 422, "invalid_input", "Choose people who have a chat on this number.");
    const sent: string[] = [];
    const problems: string[] = [];
    for (const { conversation, contact } of chats) {
      const values = valuesFor(spec.values, tc, contact);
      if (!values) {
        problems.push(`${contact.name ?? contact.phone}: a detail is empty`);
        continue;
      }
      const id = newId("message");
      const content = templateMessage(t, tc, values, { broadcastName: bc.name, test: true });
      const now = new Date();
      await ctx.db.transaction(async (tx) => {
        await tx.insert(schema.message).values({
          id,
          organizationId: bc.organizationId,
          conversationId: conversation.id,
          channelAccountId: conversation.channelAccountId,
          direction: "outbound",
          senderType: "user",
          senderUserId: access.userId,
          type: "template",
          content,
          status: "queued",
          sentAt: now,
        });
        await tx
          .update(cv)
          .set({
            lastMessageAt: now,
            lastMessagePreview: messagePreview("template", content, "outbound", null),
            updatedAt: now,
          })
          .where(eq(cv.id, conversation.id));
      });
      await ctx.queues.outbox.add(
        "send",
        { messageId: id },
        { jobId: id, attempts: 3, backoff: { type: "exponential", delay: 3_000 }, removeOnComplete: true },
      );
      sent.push(contact.name ?? contact.phone ?? id);
    }
    return c.json({ sent, problems });
  });

  app.post("/:id/winner", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const bc = await find(access.orgId, c.var.branchId, c.req.param("id"));
    if (!bc) return fail(c, 404, "not_found");
    const parsed = await parseBody(c, z.object({ key: z.enum(["A", "B"]) }));
    if ("error" in parsed) return parsed.error;
    if (!bc.test || bc.winner) return fail(c, 409, "no_test", "There's no A/B test waiting for a winner.");
    const rows = await ctx.db.execute<{ variant: string; sent: number; good: number }>(sql`
      select variant, count(*) filter (where status in ('sent', 'delivered', 'read'))::int as sent,
        count(*) filter (where ${bc.test.metric === "read" ? sql`status = 'read'` : sql`replied_at is not null`})::int as good
      from broadcast_recipient where broadcast_id = ${bc.id} and variant in ('A', 'B') group by variant`);
    const rate = (k: string) => {
      const x = rows.find((y) => y.variant === k);
      return x?.sent ? x.good / x.sent : 0;
    };
    const [row] = await ctx.db
      .update(b)
      .set({
        winner: {
          key: parsed.data.key,
          rates: { A: rate("A"), B: rate("B") },
          decidedAt: new Date().toISOString(),
          by: "manual",
        },
        updatedAt: new Date(),
      })
      .where(and(eq(b.id, bc.id), isNull(b.winner)))
      .returning();
    return c.json({ broadcast: row });
  });

  return app;
}

/**
 * Broadcasts waiting to start that use a list (deleting it would break them). Started ones don't
 * count: their audience is already frozen.
 */
export async function broadcastsUsingList(ctx: AppContext, listId: string) {
  const b = schema.broadcast;
  return ctx.db
    .select({ id: b.id, name: b.name, status: b.status })
    .from(b)
    .where(
      and(
        inArray(b.status, ["scheduled", "draft"]),
        isNull(b.startedAt),
        sql`(${b.audience} -> 'listIds') ? ${listId} or (${b.audience} -> 'excludeListIds') ? ${listId}`,
      ),
    );
}
