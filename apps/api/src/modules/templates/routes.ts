import { newId, publishInboxEvent } from "@relay/core";
import { templateLibrary } from "@relay/core/template-library";
import {
  checkTemplate,
  slugify,
  type TemplateContent,
  type TemplateLimits,
  templateVariables,
} from "@relay/core/templates";
import { and, asc, eq, inArray, isNotNull, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { accountRef, channels } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";

/*
 * Message templates. A template is written once and published to the channels a business picks;
 * each channel copy has its own review state. Owners, admins and branch managers manage templates;
 * everyone in the business can use ready ones in the inbox.
 */

const header = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string().max(200) }),
    z.object({ kind: z.enum(["image", "video", "document"]), attachmentId: z.string().nullable() }),
  ])
  .nullable();
const button = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reply"), text: z.string().max(60) }),
  z.object({ kind: z.literal("link"), text: z.string().max(60), url: z.string().max(2000) }),
  z.object({ kind: z.literal("call"), text: z.string().max(60), phone: z.string().max(30) }),
]);
const content = z.object({
  header,
  body: z.string().max(2000),
  footer: z.string().max(200).nullable(),
  buttons: z.array(button).max(10),
});
const templateBody = z.object({
  name: z.string().trim().min(1, "Give the template a name").max(80),
  language: z.string().trim().min(2).max(10).default("en"),
  purpose: z.enum(["updates", "marketing", "login"]),
  content,
  variables: z.array(z.object({ name: z.string().max(60), example: z.string().max(200) })).max(20),
  /** Channels to publish to now. Leave out to save a draft. */
  channelIds: z.array(z.string()).optional(),
});

type Template = typeof schema.messageTemplate.$inferSelect;
type Account = typeof schema.channelAccount.$inferSelect;

export function templateRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  async function canManage(access: Access) {
    if (isOrgAdmin(access.orgRole)) return true;
    const [row] = await ctx.db
      .select({ n: sql<number>`1` })
      .from(schema.branchMember)
      .where(
        and(
          eq(schema.branchMember.organizationId, access.orgId),
          eq(schema.branchMember.userId, access.userId),
          eq(schema.branchMember.role, "manager"),
        ),
      )
      .limit(1);
    return !!row;
  }

  const announce = (organizationId: string, templateId: string) =>
    publishInboxEvent(ctx.redis, organizationId, { type: "template.updated", templateId });

  /** The business's channels with what their templates can hold (null: no templates). */
  async function orgChannels(orgId: string) {
    const rows = await ctx.db
      .select()
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.organizationId, orgId))
      .orderBy(asc(schema.channelAccount.createdAt));
    return rows.map((a) => ({ account: a, limits: channels().get(a.type)?.capabilities.templates ?? null }));
  }

  async function withChannels(templates: Template[]) {
    const ids = templates.map((t) => t.id);
    const copies = ids.length
      ? await ctx.db
          .select({
            templateId: schema.templateChannel.templateId,
            channelId: schema.templateChannel.channelAccountId,
            channelName: schema.channelAccount.displayName,
            channelType: schema.channelAccount.type,
            status: schema.templateChannel.status,
            reason: schema.templateChannel.reason,
            submittedAt: schema.templateChannel.submittedAt,
            decidedAt: schema.templateChannel.decidedAt,
          })
          .from(schema.templateChannel)
          .innerJoin(
            schema.channelAccount,
            eq(schema.channelAccount.id, schema.templateChannel.channelAccountId),
          )
          .where(inArray(schema.templateChannel.templateId, ids))
      : [];
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      language: t.language,
      purpose: t.purpose,
      content: t.content,
      variables: t.variables,
      source: t.source,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      channels: copies.filter((c) => c.templateId === t.id).map(({ templateId: _, ...c }) => c),
    }));
  }

  async function findTemplate(orgId: string, id: string) {
    const [t] = await ctx.db
      .select()
      .from(schema.messageTemplate)
      .where(and(eq(schema.messageTemplate.id, id), eq(schema.messageTemplate.organizationId, orgId)))
      .limit(1);
    return t ?? null;
  }

  /** A slug not used yet in this business and language: appointment_reminder, appointment_reminder_2… */
  async function freeSlug(orgId: string, base: string, language: string, except?: string) {
    const taken = await ctx.db
      .select({ slug: schema.messageTemplate.slug, id: schema.messageTemplate.id })
      .from(schema.messageTemplate)
      .where(
        and(eq(schema.messageTemplate.organizationId, orgId), eq(schema.messageTemplate.language, language)),
      );
    const used = new Set(taken.filter((t) => t.id !== except).map((t) => t.slug));
    if (!used.has(base)) return base;
    for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
  }

  /** Keep only examples for details the content uses, adding empty ones for new details. */
  function tidyVariables(c: TemplateContent, vars: { name: string; example: string }[]) {
    return templateVariables(c).map((name) => ({
      name,
      example: vars.find((v) => v.name === name)?.example ?? "",
    }));
  }

  /**
   * Publishes (or republishes) a template to channels. Checks it against each channel's rules first,
   * then queues one job per scope (accounts sharing templates are published together).
   */
  async function publish(template: Template, channelIds: string[]) {
    const all = await orgChannels(template.organizationId);
    const chosen = all.filter((c) => channelIds.includes(c.account.id));
    if (chosen.length !== channelIds.length) return { error: "Some of those channels were not found." };
    const unsupported = chosen.find((c) => !c.limits);
    if (unsupported) return { error: `${unsupported.account.displayName} doesn't support templates.` };
    for (const c of chosen) {
      const issues = checkTemplate(
        {
          name: template.name,
          content: template.content as unknown as TemplateContent,
          variables: template.variables,
        },
        c.limits as TemplateLimits,
      );
      if (issues.length) return { error: issues[0]?.message ?? "Check the template.", issues };
      if (!(c.limits as TemplateLimits).purposes.includes(template.purpose as never))
        return { error: `${c.account.displayName} doesn't accept that purpose.` };
    }
    const scopes = new Map<string, Account>();
    for (const { account } of chosen) {
      const adapter = channels().get(account.type);
      const scope = adapter?.templates?.scope(accountRef(account)) ?? account.id;
      scopes.set(scope, account);
      await ctx.db
        .insert(schema.templateChannel)
        .values({
          id: newId("templateChannel"),
          organizationId: template.organizationId,
          templateId: template.id,
          channelAccountId: account.id,
          scope,
          status: "in_review",
        })
        .onConflictDoUpdate({
          target: [schema.templateChannel.templateId, schema.templateChannel.channelAccountId],
          set: { status: "in_review", reason: null, error: null, scope, updatedAt: new Date() },
        });
    }
    for (const scope of scopes.keys()) {
      await ctx.queues.templates.add(
        "publish",
        { action: "publish", templateId: template.id, scope },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      );
    }
    await announce(template.organizationId, template.id);
    return { ok: true as const };
  }

  // The templates and the channels they can go to.
  app.get("/", async (c) => {
    const orgId = c.var.access.orgId;
    const rows = await ctx.db
      .select()
      .from(schema.messageTemplate)
      .where(eq(schema.messageTemplate.organizationId, orgId))
      .orderBy(sql`${schema.messageTemplate.updatedAt} desc`);
    const chans = await orgChannels(orgId);
    return c.json({
      templates: await withChannels(rows),
      channels: chans.map(({ account, limits }) => ({
        id: account.id,
        name: account.displayName,
        type: account.type,
        phone: account.displayPhone,
        status: account.status,
        limits,
      })),
      canManage: await canManage(c.var.access),
    });
  });

  app.get("/library", (c) => c.json({ library: templateLibrary }));

  app.get("/:id", async (c) => {
    const t = await findTemplate(c.var.access.orgId, c.req.param("id"));
    if (!t) return fail(c, 404, "not_found");
    const [one] = await withChannels([t]);
    return c.json({ template: one });
  });

  app.post("/", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access)))
      return fail(c, 403, "forbidden", "Only owners, admins and managers can add templates.");
    const parsed = await parseBody(c, templateBody);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const id = newId("template");
    const [template] = await ctx.db
      .insert(schema.messageTemplate)
      .values({
        id,
        organizationId: access.orgId,
        name: b.name,
        slug: await freeSlug(access.orgId, slugify(b.name), b.language),
        language: b.language,
        purpose: b.purpose,
        content: b.content as unknown as Record<string, unknown>,
        variables: tidyVariables(b.content as TemplateContent, b.variables),
        createdByUserId: access.userId,
      })
      .returning();
    if (!template) return fail(c, 500, "internal_error");
    if (b.channelIds?.length) {
      const result = await publish(template, b.channelIds);
      if ("error" in result) {
        // Keep the draft so nothing typed is lost; say what to fix.
        const [one] = await withChannels([template]);
        return c.json(
          { template: one, error: "not_published", message: result.error, issues: result.issues ?? [] },
          422,
        );
      }
    }
    await announce(access.orgId, id);
    const [one] = await withChannels([template]);
    return c.json({ template: one }, 201);
  });

  // Change a template. Published copies are sent for review again.
  app.patch("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(c, templateBody);
    if ("error" in parsed) return parsed.error;
    const t = await findTemplate(access.orgId, c.req.param("id"));
    if (!t) return fail(c, 404, "not_found");
    const b = parsed.data;
    const published = await ctx.db
      .select({ channelId: schema.templateChannel.channelAccountId })
      .from(schema.templateChannel)
      .where(and(eq(schema.templateChannel.templateId, t.id), isNotNull(schema.templateChannel.externalId)));
    // Channels know a template by its name, so the name and language are fixed once it is published.
    const fixed = published.length > 0;
    const [template] = await ctx.db
      .update(schema.messageTemplate)
      .set({
        name: b.name,
        purpose: b.purpose,
        content: b.content as unknown as Record<string, unknown>,
        variables: tidyVariables(b.content as TemplateContent, b.variables),
        ...(fixed
          ? {}
          : { language: b.language, slug: await freeSlug(access.orgId, slugify(b.name), b.language, t.id) }),
        updatedAt: new Date(),
      })
      .where(eq(schema.messageTemplate.id, t.id))
      .returning();
    if (!template) return fail(c, 500, "internal_error");
    const targets = [...new Set([...published.map((p) => p.channelId), ...(b.channelIds ?? [])])];
    if (targets.length) {
      const result = await publish(template, targets);
      if ("error" in result) {
        const [one] = await withChannels([template]);
        return c.json(
          { template: one, error: "not_published", message: result.error, issues: result.issues ?? [] },
          422,
        );
      }
    }
    await announce(access.orgId, t.id);
    const [one] = await withChannels([template]);
    return c.json({ template: one });
  });

  app.post("/:id/publish", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access))) return fail(c, 403, "forbidden");
    const parsed = await parseBody(
      c,
      z.object({ channelIds: z.array(z.string()).min(1, "Choose a channel") }),
    );
    if ("error" in parsed) return parsed.error;
    const t = await findTemplate(access.orgId, c.req.param("id"));
    if (!t) return fail(c, 404, "not_found");
    const result = await publish(t, parsed.data.channelIds);
    if ("error" in result)
      return c.json({ error: "not_published", message: result.error, issues: result.issues ?? [] }, 422);
    const [one] = await withChannels([t]);
    return c.json({ template: one });
  });

  app.post("/:id/duplicate", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access))) return fail(c, 403, "forbidden");
    const t = await findTemplate(access.orgId, c.req.param("id"));
    if (!t) return fail(c, 404, "not_found");
    const name = `${t.name} (copy)`;
    const [copy] = await ctx.db
      .insert(schema.messageTemplate)
      .values({
        id: newId("template"),
        organizationId: access.orgId,
        name,
        slug: await freeSlug(access.orgId, slugify(name), t.language),
        language: t.language,
        purpose: t.purpose,
        content: t.content,
        variables: t.variables,
        createdByUserId: access.userId,
      })
      .returning();
    if (!copy) return fail(c, 500, "internal_error");
    await announce(access.orgId, copy.id);
    const [one] = await withChannels([copy]);
    return c.json({ template: one }, 201);
  });

  // Delete everywhere: from the channels it was published to, then from Relay.
  app.delete("/:id", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access))) return fail(c, 403, "forbidden");
    const t = await findTemplate(access.orgId, c.req.param("id"));
    if (!t) return fail(c, 404, "not_found");
    const copies = await ctx.db
      .select()
      .from(schema.templateChannel)
      .where(and(eq(schema.templateChannel.templateId, t.id), isNotNull(schema.templateChannel.externalId)));
    const seen = new Set<string>();
    for (const copy of copies) {
      if (!copy.externalId || seen.has(copy.externalId)) continue;
      seen.add(copy.externalId);
      await ctx.queues.templates.add(
        "remove",
        {
          action: "remove",
          channelAccountId: copy.channelAccountId,
          externalId: copy.externalId,
          slug: t.slug,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      );
    }
    await ctx.db.delete(schema.messageTemplate).where(eq(schema.messageTemplate.id, t.id));
    await announce(access.orgId, t.id);
    return c.body(null, 204);
  });

  // Bring in templates that already exist on the business's channels (e.g. made in WhatsApp Manager).
  app.post("/sync", async (c) => {
    const access = c.var.access;
    if (!(await canManage(access))) return fail(c, 403, "forbidden");
    const chans = (await orgChannels(access.orgId)).filter((x) => x.limits && x.account.status === "active");
    for (const { account } of chans)
      await ctx.queues.templates.add(
        "sync",
        { action: "sync", channelAccountId: account.id },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: 500,
        },
      );
    return c.json({ queued: chans.length }, 202);
  });

  return app;
}
