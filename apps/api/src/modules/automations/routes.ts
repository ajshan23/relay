import { createHash } from "node:crypto";
import { newId } from "@relay/core";
import {
  type AutomationDefinition,
  type AutomationRunInput,
  type AutomationRunLabels,
  automationWorkflows,
  definitionSchema,
  describeRun,
  emptyDefinition,
  hasErrors,
  type Issue,
  type MessagePreview,
  migrateDefinition,
  startedBy,
  starters,
  triggerPriority,
  triggersOverlap,
  type ValidationContext,
  validateDefinition,
} from "@relay/core/automations";
import { numbersFor } from "@relay/core/permissions";
import { type TemplateContent, templateVariables } from "@relay/core/templates";
import { and, desc, eq, ilike, inArray, isNull, ne, or, schema, sql } from "@relay/db";
import type { RunStatus } from "@relay/kairos";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, can, fail, type Permission, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { type BranchEnv, requireBranch } from "../contacts/shared";
import { assignableUsers, canWork, findConversation, visibleTo } from "../conversations/access";
import { resolveMapLink, reversePlace, searchPlaces } from "./places";
import { isLiveRun, startRunInChat, stopRun } from "./runs";

/*
 * Automations, one branch at a time (?branch=). The worker runs them (apps/worker/src/automations);
 * these routes edit, check, publish and report.
 *   GET    /api/automations                         list, with runs in the last 7 days
 *   GET    /api/automations/starters                ready-made automations to start from
 *   POST   /api/automations                         create (blank or from a starter)
 *   GET    /api/automations/:id                     the draft, its problems, versions
 *   GET    /api/automations/:id/options             tags, fields, team, templates for the editor
 *   PATCH  /api/automations/:id                     save the draft (needs the current revision)
 *   POST   /api/automations/:id/publish             check, freeze a version, go live
 *   POST   /api/automations/:id/pause|resume|archive
 *   DELETE /api/automations/:id                     only one that was never published
 *   POST   /api/automations/:id/versions/:n/restore copy an old version into the draft
 *   GET    /api/automations/:id/runs                runs (?status=&before=)
 *   GET    /api/automations/:id/runs/:runId         one run: steps, answers, path
 *   POST   /api/automations/:id/runs/:runId/stop
 *   GET    /api/automations/:id/test-chats          chats on its number to test in (?q=)
 *   POST   /api/automations/:id/test                run the draft in one chat, marked as a test
 *   GET    /api/automations/chat/:conversationId     the chat's running automation + ones to run
 *   POST   /api/automations/chat/:conversationId/run|stop
 * Owners, admins and branch managers edit and publish; anyone who can reply runs one from a chat.
 */

const LIVE: RunStatus[] = ["queued", "running", "sleeping", "waiting"];

const createBody = z.object({
  name: z.string().trim().min(1, "Name it").max(80),
  channelAccountId: z.string().min(1, "Pick a number"),
  starterId: z.string().optional(),
  timezone: z.string().max(60).optional(),
});
const patchBody = z.object({
  revision: z.number().int(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  channelAccountId: z.string().min(1).optional(),
  draft: z.unknown().optional(),
});

const checksum = (def: AutomationDefinition) =>
  createHash("sha256").update(JSON.stringify(def)).digest("hex");

export function automationRoutes(ctx: AppContext) {
  const app = new Hono<BranchEnv>();
  app.use(requireSession, requireOrg(ctx), requireBranch(ctx));
  // The inbox's "run an automation in this chat" routes only need the chat; everything else needs to see automations.
  app.use(async (c, next) => {
    if (
      !c.req.path.includes("/chat/") &&
      !can(c.var.access, "automations.view", { branchId: c.var.branchId })
    )
      return fail(c, 403, "forbidden");
    await next();
  });
  const a = schema.automation;
  const v = schema.automationVersion;

  /** May they do `perm` in this branch (on one of its numbers, when given)? */
  async function canManage(
    access: Access,
    branchId: string,
    perm: Permission = "automations.manage",
    channelId?: string | null,
  ) {
    return can(access, perm, { branchId, channelId });
  }

  /** One automation of the branch, when they hold `perm` on its number. */
  async function find(access: Access, branchId: string, id: string, perm: Permission = "automations.view") {
    const [row] = await ctx.db
      .select()
      .from(a)
      .where(and(eq(a.id, id), eq(a.organizationId, access.orgId), eq(a.branchId, branchId)))
      .limit(1);
    if (!row || !can(access, perm, { branchId, channelId: row.channelAccountId })) return null;
    return row;
  }

  /** WhatsApp numbers that serve this branch. */
  async function branchNumbers(access: Access, branchId: string, perm: Permission = "automations.view") {
    const ca = schema.channelAccount;
    const rows = await ctx.db
      .select({
        id: ca.id,
        displayName: ca.displayName,
        displayPhone: ca.displayPhone,
        status: ca.status,
      })
      .from(ca)
      .where(
        and(
          eq(ca.organizationId, access.orgId),
          eq(ca.type, "whatsapp"),
          ne(ca.status, "disconnected"),
          eq(ca.branchId, branchId),
        ),
      );
    const mine = numbersFor(access, perm, branchId);
    return rows.filter((n) => mine === "all" || mine.has(n.id));
  }

  /** What the editor and validation need: tags, fields, team and this number's templates. */
  async function options(orgId: string, branchId: string, channelAccountId: string | null) {
    const [tags, fields, users, templates] = await Promise.all([
      ctx.db
        .select({ id: schema.tag.id, name: schema.tag.name, colour: schema.tag.colour })
        .from(schema.tag)
        .where(
          and(
            eq(schema.tag.organizationId, orgId),
            or(isNull(schema.tag.branchId), eq(schema.tag.branchId, branchId)),
          ),
        ),
      ctx.db
        .select({
          key: schema.contactField.key,
          label: schema.contactField.label,
          type: schema.contactField.type,
        })
        .from(schema.contactField)
        .where(and(eq(schema.contactField.organizationId, orgId), isNull(schema.contactField.archivedAt))),
      assignableUsers(ctx, orgId, branchId),
      channelAccountId
        ? ctx.db
            .select({
              id: schema.messageTemplate.id,
              name: schema.messageTemplate.name,
              content: schema.messageTemplate.content,
              status: schema.templateChannel.status,
            })
            .from(schema.messageTemplate)
            .innerJoin(
              schema.templateChannel,
              and(
                eq(schema.templateChannel.templateId, schema.messageTemplate.id),
                eq(schema.templateChannel.channelAccountId, channelAccountId),
              ),
            )
            .where(eq(schema.messageTemplate.organizationId, orgId))
        : Promise.resolve([]),
    ]);
    return {
      tags,
      fields,
      users,
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        body: (t.content as unknown as TemplateContent).body,
        variables: templateVariables(t.content as unknown as TemplateContent),
        /** Quick-reply buttons by position: an automation waiting for a reply can branch on each. */
        replyButtons: ((t.content as unknown as TemplateContent).buttons ?? []).flatMap((b, index) =>
          b.kind === "reply" ? [{ index, title: b.text }] : [],
        ),
      })),
    };
  }

  async function check(
    automation: typeof a.$inferSelect,
    def: AutomationDefinition,
    opts: Awaited<ReturnType<typeof options>>,
  ): Promise<Issue[]> {
    const vctx: ValidationContext = {
      tags: new Set(opts.tags.map((t) => t.id)),
      fields: new Set(opts.fields.map((f) => f.key)),
      assignees: new Set(opts.users.map((u) => u.id)),
      templates: new Map(opts.templates.map((t) => [t.id, t])),
    };
    const issues = validateDefinition(def, vctx);
    if (!automation.channelAccountId)
      issues.push({ level: "error", code: "NO_NUMBER", message: "Pick the WhatsApp number it runs on." });
    // Other live automations on the same number that one message could also start.
    if (automation.channelAccountId) {
      const others = await ctx.db
        .select({ name: a.name, def: v.definition })
        .from(a)
        .innerJoin(v, eq(v.id, a.liveVersionId))
        .where(
          and(
            eq(a.channelAccountId, automation.channelAccountId),
            eq(a.status, "live"),
            ne(a.id, automation.id),
          ),
        );
      for (const o of others) {
        const why = triggersOverlap(def.trigger, (o.def as AutomationDefinition).trigger);
        if (why)
          issues.push({
            level: "warning",
            code: "OVERLAP",
            nodeId: "trigger",
            message: `Overlaps with “${o.name}”: ${why} Only the more specific one starts, then the most recently updated.`,
          });
      }
    }
    return issues;
  }

  function view(row: typeof a.$inferSelect) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      channelAccountId: row.channelAccountId,
      status: row.status,
      triggerType: (row.draft as AutomationDefinition).trigger.type,
      draftRevision: row.draftRevision,
      liveVersionId: row.liveVersionId,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // ---- list and create

  app.get("/", async (c) => {
    const access = c.var.access;
    const rows = await ctx.db
      .select()
      .from(a)
      .where(
        and(eq(a.organizationId, access.orgId), eq(a.branchId, c.var.branchId), ne(a.status, "archived")),
      )
      .orderBy(desc(a.updatedAt));
    const stats = rows.length
      ? await ctx.kairos.sql
          .unsafe(
            `select labels->>'automationId' as id,
               count(*) filter (where created_at > now() - interval '7 days')::int as runs7d,
               count(*) filter (where status in ('queued','running','sleeping','waiting'))::int as live,
               max(created_at) as last_run
             from kairos.run
             where tenant_id = $1 and workflow = $2 and labels->>'automationId' = any($3::text[])
               and not (labels ? 'test')
             group by 1`,
            [access.orgId, automationWorkflows.run.name, rows.map((r) => r.id)],
          )
          .catch(() => [])
      : [];
    const byId = new Map(
      (stats as unknown as { id: string; runs7d: number; live: number; last_run: Date }[]).map((s) => [
        s.id,
        s,
      ]),
    );
    const mine = numbersFor(access, "automations.view", c.var.branchId);
    return c.json({
      automations: rows
        .filter((r) => mine === "all" || !r.channelAccountId || mine.has(r.channelAccountId))
        .map((r) => ({
          ...view(r),
          runs7d: byId.get(r.id)?.runs7d ?? 0,
          liveRuns: byId.get(r.id)?.live ?? 0,
          lastRunAt: byId.get(r.id)?.last_run ?? null,
        })),
      numbers: await branchNumbers(access, c.var.branchId),
      canManage: await canManage(access, c.var.branchId),
      canPublish: await canManage(access, c.var.branchId, "automations.publish"),
    });
  });

  app.get("/starters", (c) =>
    c.json({ starters: starters.map(({ id, name, description }) => ({ id, name, description })) }),
  );

  // ---- places, for the "Send location" step's map picker

  app.get("/places", async (c) => {
    try {
      return c.json({ places: await searchPlaces(c.req.query("q") ?? "") });
    } catch {
      return fail(c, 502, "place_search_failed");
    }
  });

  app.get("/places/reverse", async (c) => {
    try {
      return c.json({ place: await reversePlace(Number(c.req.query("lat")), Number(c.req.query("lon"))) });
    } catch {
      return fail(c, 502, "place_search_failed");
    }
  });

  app.post("/map-link", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.slice(0, 2000) : "";
    const pin = await resolveMapLink(text).catch(() => null);
    return pin ? c.json({ pin }) : fail(c, 422, "map_link_unreadable");
  });

  app.post("/", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, createBody);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;
    const numbers = await branchNumbers(access, c.var.branchId, "automations.manage");
    if (!numbers.some((n) => n.id === body.channelAccountId))
      return fail(c, 422, "wrong_number", "That number isn't connected to this branch.");
    const starter = body.starterId ? starters.find((s) => s.id === body.starterId) : null;
    if (body.starterId && !starter) return fail(c, 422, "unknown_starter");
    const draft = starter ? starter.build({ timezone: body.timezone ?? "Asia/Kolkata" }) : emptyDefinition();
    const [row] = await ctx.db
      .insert(a)
      .values({
        id: newId("automation"),
        organizationId: access.orgId,
        branchId: c.var.branchId,
        name: body.name,
        description: starter?.description ?? null,
        channelAccountId: body.channelAccountId,
        draft,
        createdByUserId: access.userId,
        updatedByUserId: access.userId,
      })
      .returning();
    if (!row) throw new Error("automation not created");
    return c.json({ automation: view(row) }, 201);
  });

  // ---- one automation

  app.get("/:id", async (c) => {
    const access = c.var.access;
    const row = await find(access, c.var.branchId, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    const def = migrateDefinition(row.draft);
    const versions = await ctx.db
      .select({
        id: v.id,
        number: v.number,
        checksum: v.checksum,
        publishedAt: v.publishedAt,
        publishedBy: schema.user.name,
      })
      .from(v)
      .leftJoin(schema.user, eq(schema.user.id, v.publishedByUserId))
      .where(and(eq(v.automationId, row.id), sql`${v.number} > 0`))
      .orderBy(desc(v.number));
    const live = versions.find((x) => x.id === row.liveVersionId) ?? null;
    const opts = await options(access.orgId, c.var.branchId, row.channelAccountId);
    return c.json({
      automation: view(row),
      draft: def,
      issues: await check(row, def, opts),
      versions: versions.map(({ checksum: _, ...x }) => x),
      liveVersion: live ? { id: live.id, number: live.number } : null,
      unpublishedChanges: !live || live.checksum !== checksum(def),
      canManage: await canManage(access, c.var.branchId, "automations.manage", row.channelAccountId),
      canPublish: await canManage(access, c.var.branchId, "automations.publish", row.channelAccountId),
    });
  });

  app.get("/:id/options", async (c) => {
    const access = c.var.access;
    const row = await find(access, c.var.branchId, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    return c.json({
      ...(await options(access.orgId, c.var.branchId, row.channelAccountId)),
      numbers: await branchNumbers(access, c.var.branchId),
    });
  });

  app.patch("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.manage"))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, patchBody);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.manage");
    if (!row) return fail(c, 404, "not_found");
    let draft: AutomationDefinition | undefined;
    if (body.draft !== undefined) {
      const d = definitionSchema.safeParse(body.draft);
      if (!d.success)
        return fail(c, 422, "invalid_draft", d.error.issues[0]?.message ?? "The draft isn't valid.");
      draft = d.data;
    }
    if (body.channelAccountId && body.channelAccountId !== row.channelAccountId) {
      // The live trigger and every waiting run use the number, and steps pick templates per number:
      // moving a live automation would change it without a publish and without these checks.
      if (row.status === "live")
        return fail(c, 409, "number_locked", "Pause the automation to move it to another number.");
      const numbers = await branchNumbers(access, c.var.branchId, "automations.manage");
      if (!numbers.some((n) => n.id === body.channelAccountId))
        return fail(c, 422, "wrong_number", "That number isn't connected to this branch.");
    }
    // Two people editing: the second save with an old revision is refused instead of overwriting.
    const [saved] = await ctx.db
      .update(a)
      .set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.channelAccountId ? { channelAccountId: body.channelAccountId } : {}),
        ...(draft ? { draft } : {}),
        draftRevision: sql`${a.draftRevision} + 1`,
        updatedByUserId: access.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(a.id, row.id), eq(a.draftRevision, body.revision)))
      .returning();
    if (!saved)
      return fail(
        c,
        409,
        "stale_revision",
        "Someone else changed this automation. Reload to see their changes.",
      );
    const def = migrateDefinition(saved.draft);
    const opts = await options(access.orgId, c.var.branchId, saved.channelAccountId);
    return c.json({ automation: view(saved), issues: await check(saved, def, opts) });
  });

  app.post("/:id/publish", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.publish"))) return fail(c, 403, "forbidden");
    const ack = !!(await c.req.json().catch(() => ({})))?.acknowledgeWarnings;
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.publish");
    if (!row) return fail(c, 404, "not_found");
    if (row.status === "archived")
      return fail(c, 409, "archived", "This automation is archived, so it can't be published.");
    const def = migrateDefinition(row.draft);
    const opts = await options(access.orgId, c.var.branchId, row.channelAccountId);
    const issues = await check(row, def, opts);
    if (hasErrors(issues))
      return c.json({ error: "has_errors", message: "Fix the problems before publishing.", issues }, 422);
    if (issues.length && !ack)
      return c.json(
        { error: "has_warnings", message: "Check these warnings, then publish anyway.", issues },
        409,
      );
    const sum = checksum(def);
    const result = await ctx.db.transaction(async (tx) => {
      // One publish of an automation at a time (a double click sends two).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`automation.publish:${row.id}`}))`);
      const [current] = await tx
        .select({ status: a.status, live: v })
        .from(a)
        .leftJoin(v, eq(v.id, a.liveVersionId))
        .where(eq(a.id, row.id));
      // A paused automation stays paused: publishing saves the version it runs on when resumed.
      const status = current?.status === "paused" ? "paused" : "live";
      // Nothing changed since the live version: keep it instead of a copy.
      if (current?.live && current.live.checksum === sum)
        return { ver: current.live, unchanged: true, status };
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${v.number}), 0)::int` })
        .from(v)
        .where(eq(v.automationId, row.id));
      const [ver] = await tx
        .insert(v)
        .values({
          id: newId("automationVersion"),
          automationId: row.id,
          organizationId: row.organizationId,
          number: Math.max(0, last?.n ?? 0) + 1,
          definition: def,
          checksum: sum,
          publishedByUserId: access.userId,
        })
        .returning();
      if (!ver) throw new Error("version not saved");
      await tx
        .update(a)
        .set({
          status,
          liveVersionId: ver.id,
          triggerType: def.trigger.type,
          priority: triggerPriority(def.trigger),
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(a.id, row.id));
      return { ver, unchanged: false, status };
    });
    return c.json({
      version: { id: result.ver.id, number: result.ver.number },
      unchanged: result.unchanged,
      status: result.status,
      issues,
    });
  });

  for (const action of ["pause", "resume", "archive"] as const)
    app.post(`/:id/${action}`, async (c) => {
      const access = c.var.access;
      if (!(await canManage(access, c.var.branchId, "automations.publish"))) return fail(c, 403, "forbidden");
      const row = await find(access, c.var.branchId, c.req.param("id"), "automations.publish");
      if (!row) return fail(c, 404, "not_found");
      if (action === "resume" && !row.liveVersionId)
        return fail(c, 409, "never_published", "Publish it first.");
      if (action !== "archive" && row.status === "archived")
        return fail(c, 409, "archived", "This automation is archived.");
      if (action === "resume") {
        // The number may have changed while it was paused: check the live version against it again.
        const [live] = await ctx.db
          .select({ definition: v.definition })
          .from(v)
          .where(eq(v.id, row.liveVersionId as string));
        const opts = await options(access.orgId, c.var.branchId, row.channelAccountId);
        const issues = live ? await check(row, migrateDefinition(live.definition), opts) : [];
        if (hasErrors(issues))
          return c.json(
            {
              error: "has_errors",
              message: `It can't run as published: ${issues.find((i) => i.level === "error")?.message ?? "fix the problems"} Publish a fixed version.`,
              issues,
            },
            422,
          );
      }
      // Pausing stops new runs; runs already going finish (stop them from the Runs tab if needed).
      const status = action === "pause" ? "paused" : action === "resume" ? "live" : "archived";
      const [saved] = await ctx.db
        .update(a)
        .set({ status, updatedAt: new Date() })
        .where(eq(a.id, row.id))
        .returning();
      // Archiving ends it: runs still waiting for a reply or a timer stop now, and their chats are free.
      // (A run in the middle of a step stops at its next one, so it can still show as going for a moment.)
      let stopped = 0;
      if (action === "archive") {
        const going = await ctx.kairos.listRuns({
          tenantId: access.orgId,
          workflow: automationWorkflows.run.name,
          labels: { automationId: row.id },
          status: LIVE,
          limit: 500,
        });
        for (const r of going) {
          await stopRun(ctx, r.id, (r.labels as Partial<AutomationRunLabels>).conversationId ?? null);
          stopped++;
        }
      }
      return c.json({ automation: saved ? view(saved) : null, stoppedRuns: stopped });
    });

  app.delete("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.manage"))) return fail(c, 403, "forbidden");
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.manage");
    if (!row) return fail(c, 404, "not_found");
    if (row.liveVersionId)
      return fail(
        c,
        409,
        "published",
        "Published automations are archived, not deleted, so their runs stay.",
      );
    await ctx.db.delete(a).where(eq(a.id, row.id));
    return c.body(null, 204);
  });

  app.post("/:id/versions/:n/restore", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.manage"))) return fail(c, 403, "forbidden");
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.manage");
    if (!row) return fail(c, 404, "not_found");
    const [ver] = await ctx.db
      .select()
      .from(v)
      .where(and(eq(v.automationId, row.id), eq(v.number, Number(c.req.param("n")))))
      .limit(1);
    if (!ver) return fail(c, 404, "version_not_found");
    const [saved] = await ctx.db
      .update(a)
      .set({
        draft: migrateDefinition(ver.definition),
        draftRevision: sql`${a.draftRevision} + 1`,
        updatedByUserId: access.userId,
        updatedAt: new Date(),
      })
      .where(eq(a.id, row.id))
      .returning();
    return c.json({ automation: saved ? view(saved) : null });
  });

  // ---- runs

  async function runRows(orgId: string, runs: { labels: unknown }[]) {
    const contactIds = [
      ...new Set(runs.map((r) => (r.labels as Partial<AutomationRunLabels>).contactId).filter(Boolean)),
    ] as string[];
    const contacts = contactIds.length
      ? await ctx.db
          .select({ id: schema.contact.id, name: schema.contact.name, phone: schema.contact.phone })
          .from(schema.contact)
          .where(and(eq(schema.contact.organizationId, orgId), inArray(schema.contact.id, contactIds)))
      : [];
    return new Map(contacts.map((x) => [x.id, x]));
  }

  /** Names for "Started by": who ran it from a chat, which tag was added. */
  async function triggerNames(orgId: string, runs: { input: unknown }[]) {
    const triggers = runs.map((r) => (r.input as Partial<AutomationRunInput> | null)?.trigger);
    const userIds = [...new Set(triggers.map((t) => t?.startedByUserId).filter(Boolean))] as string[];
    const tagIds = [...new Set(triggers.map((t) => t?.tagId).filter(Boolean))] as string[];
    const [users, tags] = await Promise.all([
      userIds.length
        ? ctx.db
            .select({ id: schema.user.id, name: schema.user.name })
            .from(schema.user)
            .where(inArray(schema.user.id, userIds))
        : [],
      tagIds.length
        ? ctx.db
            .select({ id: schema.tag.id, name: schema.tag.name })
            .from(schema.tag)
            .where(and(eq(schema.tag.organizationId, orgId), inArray(schema.tag.id, tagIds)))
        : [],
    ]);
    const user = new Map(users.map((u) => [u.id, u.name]));
    const tag = new Map(tags.map((t) => [t.id, t.name]));
    return (input: unknown) => {
      const t = (input as Partial<AutomationRunInput> | null)?.trigger;
      if (!t) return { label: "—", names: {} };
      const names = {
        user: t.startedByUserId ? (user.get(t.startedByUserId) ?? null) : null,
        tag: t.tagId ? (tag.get(t.tagId) ?? null) : null,
      };
      return { label: startedBy(t, names), names };
    };
  }

  /** What was really sent, to quote in a run's history (only messages of this organization). */
  async function messagePreviews(orgId: string, steps: { result: unknown }[]) {
    const ids = [
      ...new Set(
        steps
          .map((s) => (s.result as { messageId?: unknown } | null)?.messageId)
          .filter((x): x is string => typeof x === "string"),
      ),
    ];
    if (!ids.length) return {};
    const rows = await ctx.db
      .select({ id: schema.message.id, type: schema.message.type, content: schema.message.content })
      .from(schema.message)
      .where(and(eq(schema.message.organizationId, orgId), inArray(schema.message.id, ids)));
    const out: Record<string, MessagePreview> = {};
    for (const r of rows) {
      const c = (r.content ?? {}) as {
        text?: string;
        body?: string;
        caption?: string | null;
        name?: string | null;
        address?: string | null;
      };
      out[r.id] = { type: r.type, text: c.text ?? c.body ?? c.caption ?? c.name ?? c.address ?? "" };
    }
    return out;
  }

  /** First taps on a run's link buttons, by "node#visit" (from the step key "runId:node#visit"). */
  async function linkTaps(runId: string) {
    const rows = await ctx.db
      .select({ stepKey: schema.trackedLink.stepKey, at: schema.trackedLink.firstTappedAt })
      .from(schema.trackedLink)
      .where(eq(schema.trackedLink.runId, runId));
    const out: Record<string, Date> = {};
    for (const r of rows) if (r.at) out[r.stepKey.slice(r.stepKey.indexOf(":") + 1)] = r.at;
    return out;
  }

  app.get("/:id/runs", async (c) => {
    const access = c.var.access;
    const row = await find(access, c.var.branchId, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    const status = c.req.query("status");
    const before = c.req.query("before");
    const runs = await ctx.kairos
      .listRuns({
        tenantId: access.orgId,
        workflow: automationWorkflows.run.name,
        labels: { automationId: row.id },
        status: status === "live" ? LIVE : status ? ([status] as RunStatus[]) : undefined,
        before: before ? new Date(before) : undefined,
        limit: 50,
      })
      .catch(() => []);
    const contacts = await runRows(access.orgId, runs);
    const started = await triggerNames(access.orgId, runs);
    return c.json({
      runs: runs.map((r) => {
        const l = r.labels as Partial<AutomationRunLabels>;
        return {
          id: r.id,
          status: r.status,
          test: !!l.test,
          startedBy: started(r.input).label,
          versionId: l.versionId,
          conversationId: l.conversationId,
          contact: l.contactId ? (contacts.get(l.contactId) ?? null) : null,
          error: (r.error as { message?: string } | null)?.message ?? null,
          createdAt: r.created_at,
          finishedAt: r.finished_at,
        };
      }),
    });
  });

  app.get("/:id/runs/:runId", async (c) => {
    const access = c.var.access;
    const row = await find(access, c.var.branchId, c.req.param("id"));
    if (!row) return fail(c, 404, "not_found");
    const found = await ctx.kairos.getRun(c.req.param("runId"));
    const l = (found?.run.labels ?? {}) as Partial<AutomationRunLabels>;
    if (!found || found.run.tenant_id !== access.orgId || l.automationId !== row.id)
      return fail(c, 404, "not_found");
    const [ver] = l.versionId
      ? await ctx.db
          .select({ number: v.number, definition: v.definition })
          .from(v)
          .where(eq(v.id, l.versionId))
      : [];
    const contacts = await runRows(access.orgId, [found.run]);
    const started = (await triggerNames(access.orgId, [found.run]))(found.run.input);
    const history = ver
      ? describeRun({
          def: migrateDefinition(ver.definition),
          input: found.run.input as AutomationRunInput,
          steps: found.steps.map((s) => ({
            name: s.name,
            kind: s.kind,
            status: s.status,
            result: s.result,
            error: s.error as { message?: string } | null,
            startedAt: s.started_at,
            completedAt: s.completed_at,
            wakeAt: s.wake_at,
          })),
          messages: await messagePreviews(access.orgId, found.steps),
          status: found.run.status,
          error: found.run.error as { message?: string } | null,
          createdAt: found.run.created_at,
          finishedAt: found.run.finished_at,
          names: started.names,
          linkTaps: await linkTaps(found.run.id),
        })
      : [];
    return c.json({
      run: {
        id: found.run.id,
        status: found.run.status,
        test: !!l.test,
        conversationId: l.conversationId,
        contact: l.contactId ? (contacts.get(l.contactId) ?? null) : null,
        output: found.run.output,
        error: found.run.error,
        createdAt: found.run.created_at,
        finishedAt: found.run.finished_at,
        nextWakeAt: found.wakeup?.wake_at ?? null,
        startedBy: started.label,
      },
      history,
      steps: found.steps.map((s) => ({
        seq: s.seq,
        kind: s.kind,
        name: s.name,
        status: s.status,
        result: s.result,
        error: s.error,
        attempt: s.attempt,
        startedAt: s.started_at,
        completedAt: s.completed_at,
        wakeAt: s.wake_at,
      })),
      version: ver ? { number: ver.number, definition: ver.definition } : null,
    });
  });

  app.post("/:id/runs/:runId/stop", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.publish"))) return fail(c, 403, "forbidden");
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.publish");
    if (!row) return fail(c, 404, "not_found");
    const found = await ctx.kairos.getRun(c.req.param("runId"));
    const l = (found?.run.labels ?? {}) as Partial<AutomationRunLabels>;
    if (!found || found.run.tenant_id !== access.orgId || l.automationId !== row.id)
      return fail(c, 404, "not_found");
    await stopRun(ctx, found.run.id, l.conversationId ?? null);
    return c.json({ ok: true });
  });

  // ---- testing the draft

  app.get("/:id/test-chats", async (c) => {
    const access = c.var.access;
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.manage");
    if (!row?.channelAccountId) return fail(c, 404, "not_found");
    const q = c.req.query("q")?.trim();
    const cv = schema.conversation;
    const ct = schema.contact;
    const chats = await ctx.db
      .select({
        conversationId: cv.id,
        name: ct.name,
        phone: ct.phone,
        windowExpiresAt: cv.windowExpiresAt,
        lastMessageAt: cv.lastMessageAt,
      })
      .from(cv)
      .innerJoin(ct, eq(ct.id, cv.contactId))
      .where(
        and(
          eq(cv.channelAccountId, row.channelAccountId),
          eq(cv.kind, "direct"),
          visibleTo(access, c.var.branchId),
          q ? or(ilike(ct.name, `%${q}%`), ilike(ct.phone, `%${q.replace(/\D/g, "") || q}%`)) : undefined,
        ),
      )
      .orderBy(desc(cv.lastMessageAt))
      .limit(10);
    return c.json({ chats });
  });

  app.post("/:id/test", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access, c.var.branchId, "automations.manage"))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, z.object({ conversationId: z.string().min(1) }));
    if ("error" in parsed) return parsed.error;
    const row = await find(access, c.var.branchId, c.req.param("id"), "automations.manage");
    if (!row) return fail(c, 404, "not_found");
    const testChat = await findConversation(ctx, access, parsed.data.conversationId);
    if (
      !testChat ||
      testChat.branchId !== c.var.branchId ||
      testChat.channelAccountId !== row.channelAccountId ||
      !(await canWork(ctx, access, testChat))
    )
      return fail(c, 404, "not_found", "Pick one of this number's chats you can reply in.");
    const def = migrateDefinition(row.draft);
    const opts = await options(access.orgId, c.var.branchId, row.channelAccountId);
    const issues = await check(row, def, opts);
    if (hasErrors(issues))
      return c.json({ error: "has_errors", message: "Fix the problems before testing.", issues }, 422);
    // The draft is frozen as a test version (negative number, never live) so the run is pinned like any.
    const ver = await ctx.db.transaction(async (tx) => {
      const [low] = await tx
        .select({ n: sql<number>`coalesce(min(${v.number}), 0)::int` })
        .from(v)
        .where(eq(v.automationId, row.id));
      const [created] = await tx
        .insert(v)
        .values({
          id: newId("automationVersion"),
          automationId: row.id,
          organizationId: row.organizationId,
          number: Math.min(0, low?.n ?? 0) - 1,
          definition: def,
          checksum: checksum(def),
          publishedByUserId: access.userId,
        })
        .returning();
      return created;
    });
    if (!ver) throw new Error("test version not saved");
    const started = await startRunInChat(ctx, {
      automationId: row.id,
      versionId: ver.id,
      definition: def,
      conversationId: parsed.data.conversationId,
      organizationId: access.orgId,
      userId: access.userId,
      test: true,
    });
    if (!started.ok) return fail(c, started.status, started.code, started.message);
    return c.json({ runId: started.runId, issues }, 201);
  });

  // ---- from a chat in the inbox

  async function chatFor(access: Access, conversationId: string) {
    return findConversation(ctx, access, conversationId);
  }

  app.get("/chat/:conversationId", async (c) => {
    const access = c.var.access;
    const conv = await chatFor(access, c.req.param("conversationId"));
    if (!conv) return fail(c, 404, "not_found");
    let current: {
      kind: "automation" | "ai";
      runId: string;
      automationId: string | null;
      agentId: string | null;
      name: string;
      status: string;
      test: boolean;
    } | null = null;
    if (conv.automationRunId) {
      const found = await ctx.kairos.getRun(conv.automationRunId).catch(() => null);
      const l = (found?.run.labels ?? {}) as Partial<AutomationRunLabels> & {
        ai?: boolean;
        agentId?: string;
      };
      if (found && isLiveRun(found.run) && l.ai && l.agentId) {
        // The AI agent holds the chat.
        const [agent] = await ctx.db
          .select({ name: schema.aiAgent.name })
          .from(schema.aiAgent)
          .where(eq(schema.aiAgent.id, l.agentId));
        current = {
          kind: "ai",
          runId: found.run.id,
          automationId: null,
          agentId: l.agentId,
          name: agent?.name ?? "AI agent",
          status: found.run.status,
          test: false,
        };
      } else if (found && isLiveRun(found.run) && l.automationId) {
        const [auto] = await ctx.db.select({ name: a.name }).from(a).where(eq(a.id, l.automationId));
        current = {
          kind: "automation",
          runId: found.run.id,
          automationId: l.automationId,
          agentId: null,
          name: auto?.name ?? "Automation",
          status: found.run.status,
          test: !!l.test,
        };
      }
    }
    const runnable = await ctx.db
      .select({ id: a.id, name: a.name, description: a.description })
      .from(a)
      .where(
        and(
          eq(a.organizationId, access.orgId),
          eq(a.channelAccountId, conv.channelAccountId),
          eq(a.status, "live"),
          eq(a.triggerType, "run_from_chat"),
        ),
      )
      .orderBy(a.name);
    return c.json({
      current,
      runnable,
      canRun: can(access, "automations.run", { branchId: conv.branchId, channelId: conv.channelAccountId }),
    });
  });

  app.post("/chat/:conversationId/run", async (c) => {
    const access = c.var.access;
    const parsed = await parseBody(c, z.object({ automationId: z.string().min(1) }));
    if ("error" in parsed) return parsed.error;
    const conv = await chatFor(access, c.req.param("conversationId"));
    if (!conv) return fail(c, 404, "not_found");
    if (!can(access, "automations.run", { branchId: conv.branchId, channelId: conv.channelAccountId }))
      return fail(c, 403, "forbidden");
    const [row] = await ctx.db
      .select({ a, def: v.definition, versionId: v.id })
      .from(a)
      .innerJoin(v, eq(v.id, a.liveVersionId))
      .where(
        and(
          eq(a.id, parsed.data.automationId),
          eq(a.organizationId, access.orgId),
          eq(a.channelAccountId, conv.channelAccountId),
          eq(a.status, "live"),
          eq(a.triggerType, "run_from_chat"),
        ),
      )
      .limit(1);
    if (!row) return fail(c, 404, "not_found", "That automation can't run in this chat.");
    const started = await startRunInChat(ctx, {
      automationId: row.a.id,
      versionId: row.versionId,
      definition: row.def as AutomationDefinition,
      conversationId: conv.id,
      organizationId: access.orgId,
      userId: access.userId,
    });
    if (!started.ok) return fail(c, started.status, started.code, started.message);
    return c.json({ runId: started.runId }, 201);
  });

  app.post("/chat/:conversationId/stop", async (c) => {
    const access = c.var.access;
    const conv = await chatFor(access, c.req.param("conversationId"));
    if (!conv) return fail(c, 404, "not_found");
    if (!can(access, "automations.run", { branchId: conv.branchId, channelId: conv.channelAccountId }))
      return fail(c, 403, "forbidden");
    if (conv.automationRunId) await stopRun(ctx, conv.automationRunId, conv.id);
    return c.json({ ok: true });
  });

  return app;
}
