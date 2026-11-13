import { newId } from "@relay/core";
import {
  type ContactFieldDef,
  coerceFieldValue,
  defaultView,
  fieldKey,
  optionColours,
} from "@relay/core/contacts";
import { writeWorkbook } from "@relay/core/sheets";
import { and, asc, desc, eq, inArray, isNull, or, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type Access, type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { compileFilter, compileSort, FilterError } from "./filter";
import {
  canEditContacts,
  createField,
  listsById,
  activeFields as loadFields,
  ownChannel,
  setOptOut,
} from "./shared";

/*
 * Contacts: the business's people, their own fields (contact.attributes), tags (contact.tag_ids),
 * notes and saved table views. Everyone in the business can read; owners, admins, managers and agents
 * edit; owners and admins manage fields and delete contacts.
 */

const PAGE_SIZE_MAX = 100;
const EXPORT_MAX = 50_000;
const c = schema.contact;
/** contact.id spelled out: inside a subquery a bare "id" would mean the subquery's own row. */
const contactId = sql.raw('"contact"."id"');

const ruleSchema = z.object({
  field: z.string().max(80),
  op: z.string().max(20),
  value: z.unknown().optional(),
});
const filterSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(ruleSchema).max(30),
});
const sortSchema = z.object({ field: z.string().max(80), dir: z.enum(["asc", "desc"]) }).nullable();
const querySchema = z.object({
  filter: filterSchema.optional(),
  sort: sortSchema.optional(),
  q: z.string().max(200).optional(),
  /** Only contacts in this list (static or smart), on top of the filter. */
  listId: z.string().max(60).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX).default(50),
});

const optionSchema = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(60),
  colour: z.string().max(20),
});
const fieldTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multi_select",
  "email",
  "phone",
  "url",
]);

export function contactRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  /* ---------------------------------------------------------------- access */

  const canEdit = (access: Access) => canEditContacts(ctx.db, access);

  const activeFields = (orgId: string) => loadFields(ctx.db, orgId);
  const byKey = (rows: { key: string }[]) =>
    new Map(rows.map((f) => [f.key, f as unknown as ContactFieldDef]));

  /** Validates partial attribute updates against the business's fields. */
  function cleanAttributes(input: Record<string, unknown>, fields: Map<string, ContactFieldDef>) {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(input)) {
      const field = fields.get(key);
      if (!field) throw new FilterError(`Unknown field "${key}".`);
      const r = coerceFieldValue(field, raw);
      if (!r.ok) throw new FilterError(r.message);
      out[key] = r.value;
    }
    return out;
  }

  /** Merges values into contact.attributes; null removes a key. */
  const mergeAttributes = (values: Record<string, unknown>) => {
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
    const remove = Object.keys(values).filter((k) => values[k] === null);
    let expr = sql`${c.attributes} || ${JSON.stringify(set)}::jsonb`;
    for (const k of remove) expr = sql`(${expr}) - ${k}`;
    return expr;
  };

  /** Tag ids that exist in this business (unknown ones are dropped). */
  async function knownTags(orgId: string, ids: string[]) {
    if (!ids.length) return [];
    const rows = await ctx.db
      .select({ id: schema.tag.id })
      .from(schema.tag)
      .where(and(eq(schema.tag.organizationId, orgId), inArray(schema.tag.id, ids)));
    return rows.map((r) => r.id);
  }

  /**
   * Sorting or range-filtering a number or date field gets a typed index, created in the background the
   * first time it's needed. Partial per business, so one business's fields never slow another's.
   */
  async function ensureIndexes(orgId: string, fields: ContactFieldDef[], used: string[]) {
    for (const f of fields) {
      if (!used.includes(f.key) || (f.type !== "number" && f.type !== "date")) continue;
      const [row] = await ctx.db
        .select({ indexed: schema.contactField.indexed })
        .from(schema.contactField)
        .where(eq(schema.contactField.id, f.id))
        .limit(1);
      if (!row || row.indexed) continue;
      await ctx.db.update(schema.contactField).set({ indexed: true }).where(eq(schema.contactField.id, f.id));
      const fn = f.type === "number" ? "relay_attr_num" : "relay_attr_date";
      const name = `contact_attr_${f.id.replace(/[^a-z0-9_]/gi, "_")}`;
      // Identifiers can't be bound parameters; every part here is generated by Relay, never user text.
      const ddl = `create index concurrently if not exists "${name}" on contact (${fn}(attributes, '${f.key.replace(/'/g, "")}')) where organization_id = '${orgId.replace(/'/g, "")}'`;
      void ctx.db.execute(sql.raw(ddl)).catch((err) => console.warn("contact field index", name, err));
    }
  }

  /* ----------------------------------------------------------------- query */

  /** The WHERE and ORDER BY for the table's filters, sort and search. Throws FilterError. */
  async function tableQuery(orgId: string, b: z.infer<typeof querySchema>) {
    const { filter, sort, q } = b;
    const fields = await activeFields(orgId);
    const map = byKey(fields);
    const usesLists = !!b.listId || (filter?.rules ?? []).some((r) => r.field === "list");
    const lists = usesLists ? await listsById(ctx.db, orgId) : undefined;
    const where = compileFilter(filter as never, map, lists);
    const inList = b.listId
      ? compileFilter(
          { match: "all", rules: [{ field: "list", op: "has_any", value: [b.listId] }] },
          map,
          lists,
        )
      : undefined;
    const order = compileSort(sort === undefined ? defaultView.sort : sort, map);
    const search = q?.trim()
      ? (() => {
          const needle = `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`;
          const digits = q.replace(/[^\d]/g, "");
          return or(
            sql`${c.name} ilike ${needle}`,
            sql`${c.email} ilike ${needle}`,
            digits.length >= 3 ? sql`${c.phone} like ${`%${digits}%`}` : undefined,
            digits.length >= 3
              ? sql`exists (select 1 from ${schema.contactIdentity} i where i.contact_id = ${contactId} and i.phone like ${`%${digits}%`})`
              : undefined,
            sql`exists (select 1 from ${schema.contactIdentity} i where i.contact_id = ${contactId} and i.profile_name ilike ${needle})`,
          );
        })()
      : undefined;
    const used = [...(filter?.rules ?? []).map((r) => r.field), ...(sort?.field ? [sort.field] : [])]
      .filter((f) => f.startsWith("attr."))
      .map((f) => f.slice(5));
    void ensureIndexes(orgId, fields as unknown as ContactFieldDef[], used);
    return { fields, cond: and(eq(c.organizationId, orgId), inList, where, search), order };
  }

  const rowColumns = {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    branchId: c.branchId,
    tagIds: c.tagIds,
    attributes: c.attributes,
    source: c.source,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    /** Channels they opted out of marketing on; null means every channel. */
    optOuts: sql<(string | null)[]>`coalesce((
      select json_agg(o.channel_account_id order by o.created_at)
      from ${schema.contactOptOut} o where o.contact_id = ${contactId}), '[]'::json)`,
    channels: sql<
      { type: string; phone: string | null; username: string | null; profileName: string | null }[]
    >`coalesce((
      select json_agg(json_build_object('type', i.channel_type, 'phone', i.phone, 'username', i.username, 'profileName', i.profile_name) order by i.created_at)
      from ${schema.contactIdentity} i where i.contact_id = ${contactId}), '[]'::json)`,
  };

  // The table: filters, sort, search and paging, with the total count.
  app.post("/query", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, querySchema);
    if ("error" in parsed) return parsed.error;
    const { page, pageSize } = parsed.data;
    let query: Awaited<ReturnType<typeof tableQuery>>;
    try {
      query = await tableQuery(access.orgId, parsed.data);
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_filter", err.message);
      throw err;
    }
    const [rows, [total]] = await Promise.all([
      ctx.db
        .select(rowColumns)
        .from(c)
        .where(query.cond)
        .orderBy(query.order)
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      ctx.db.select({ n: sql<number>`count(*)::int` }).from(c).where(query.cond),
    ]);
    return c2.json({ contacts: rows, total: total?.n ?? 0, page, pageSize });
  });

  // The current view as an Excel or CSV file: its visible columns, filters, sort and search.
  app.post("/export", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(
      c2,
      querySchema.extend({
        columns: z.array(z.string().max(80)).max(200),
        format: z.enum(["xlsx", "csv"]).default("xlsx"),
      }),
    );
    if ("error" in parsed) return parsed.error;
    let query: Awaited<ReturnType<typeof tableQuery>>;
    try {
      query = await tableQuery(access.orgId, parsed.data);
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_filter", err.message);
      throw err;
    }
    const rows = await ctx.db
      .select(rowColumns)
      .from(c)
      .where(query.cond)
      .orderBy(query.order)
      .limit(EXPORT_MAX);
    const [tags, branches, channels] = await Promise.all([
      ctx.db
        .select({ id: schema.tag.id, name: schema.tag.name })
        .from(schema.tag)
        .where(eq(schema.tag.organizationId, access.orgId)),
      ctx.db
        .select({ id: schema.branch.id, name: schema.branch.name })
        .from(schema.branch)
        .where(eq(schema.branch.organizationId, access.orgId)),
      ctx.db
        .select({ id: schema.channelAccount.id, name: schema.channelAccount.displayName })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.organizationId, access.orgId)),
    ]);
    const tagName = new Map(tags.map((t) => [t.id, t.name]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const channelName = new Map(channels.map((ch) => [ch.id, ch.name]));
    const fields = byKey(query.fields);
    const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const cols = parsed.data.columns.filter((id) => !id.startsWith("attr.") || fields.has(id.slice(5)));
    const headers = cols.map((id) => {
      if (id.startsWith("attr.")) return fields.get(id.slice(5))?.label ?? id;
      return (
        (
          {
            name: "Name",
            phone: "Phone",
            email: "Email",
            tags: "Tags",
            branch: "Branch",
            lastMessageAt: "Last message",
            createdAt: "Added on",
            marketing: "Marketing opt-out",
          } as Record<string, string>
        )[id] ?? id
      );
    });
    const out = rows.map((r) =>
      cols.map((id) => {
        if (id.startsWith("attr.")) {
          const f = fields.get(id.slice(5));
          const v = r.attributes[id.slice(5)];
          if (v === undefined || v === null) return null;
          if (f?.type === "select") return f.options.find((o) => o.value === v)?.label ?? v;
          if (f?.type === "multi_select")
            return (v as string[]).map((x) => f.options.find((o) => o.value === x)?.label ?? x).join(", ");
          if (f?.type === "boolean") return v ? "Yes" : "No";
          return v;
        }
        switch (id) {
          case "phone":
            return r.phone ? `+${r.phone}` : null;
          case "tags":
            return (
              r.tagIds
                .map((t) => tagName.get(t))
                .filter(Boolean)
                .join(", ") || null
            );
          case "branch":
            return r.branchId ? (branchName.get(r.branchId) ?? null) : null;
          case "lastMessageAt":
            return day(r.lastMessageAt);
          case "createdAt":
            return day(r.createdAt);
          case "marketing":
            return r.optOuts.length
              ? r.optOuts.map((ch) => (ch ? (channelName.get(ch) ?? ch) : "All channels")).join(", ")
              : null;
          default:
            return (r as Record<string, unknown>)[id] ?? null;
        }
      }),
    );
    const format = parsed.data.format;
    const bytes = writeWorkbook(headers, out, format);
    const name = `contacts-${new Date().toISOString().slice(0, 10)}.${format}`;
    return c2.body(bytes as unknown as ArrayBuffer, 200, {
      "Content-Type":
        format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
    });
  });

  // Everything the table needs to draw itself: fields, tags, branches, channels and saved views.
  app.get("/meta", async (c2) => {
    const access = c2.var.access;
    const [fields, tags, branches, channels, views, lists] = await Promise.all([
      activeFields(access.orgId),
      ctx.db
        .select()
        .from(schema.tag)
        .where(eq(schema.tag.organizationId, access.orgId))
        .orderBy(asc(schema.tag.name)),
      ctx.db
        .select({ id: schema.branch.id, name: schema.branch.name })
        .from(schema.branch)
        .where(and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt)))
        .orderBy(asc(schema.branch.name)),
      ctx.db
        .select({
          id: schema.channelAccount.id,
          name: schema.channelAccount.displayName,
          type: schema.channelAccount.type,
        })
        .from(schema.channelAccount)
        .where(eq(schema.channelAccount.organizationId, access.orgId)),
      ctx.db
        .select()
        .from(schema.contactView)
        .where(
          and(
            eq(schema.contactView.organizationId, access.orgId),
            or(isNull(schema.contactView.ownerUserId), eq(schema.contactView.ownerUserId, access.userId)),
          ),
        )
        .orderBy(asc(schema.contactView.position), asc(schema.contactView.createdAt)),
      ctx.db
        .select({
          id: schema.contactList.id,
          name: schema.contactList.name,
          kind: schema.contactList.kind,
          filter: schema.contactList.filter,
        })
        .from(schema.contactList)
        .where(eq(schema.contactList.organizationId, access.orgId))
        .orderBy(asc(schema.contactList.name)),
    ]);
    return c2.json({
      fields: fields.map(({ organizationId: _, createdByUserId: __, ...f }) => f),
      tags,
      branches,
      channels,
      views: views.map((v) => ({ ...v, shared: v.ownerUserId === null })),
      lists,
      canEdit: await canEdit(access),
      canManage: isOrgAdmin(access.orgRole),
    });
  });

  /* ---------------------------------------------------------------- one contact */

  async function findContact(orgId: string, id: string) {
    const [row] = await ctx.db
      .select()
      .from(c)
      .where(and(eq(c.id, id), eq(c.organizationId, orgId)))
      .limit(1);
    return row ?? null;
  }

  app.get("/:id", async (c2) => {
    const access = c2.var.access;
    const contact = await findContact(access.orgId, c2.req.param("id"));
    if (!contact) return fail(c2, 404, "not_found");
    const [identities, notes, lists, conversations, optOuts] = await Promise.all([
      ctx.db
        .select()
        .from(schema.contactIdentity)
        .where(eq(schema.contactIdentity.contactId, contact.id))
        .orderBy(asc(schema.contactIdentity.createdAt)),
      ctx.db
        .select({
          id: schema.contactNote.id,
          body: schema.contactNote.body,
          createdAt: schema.contactNote.createdAt,
          authorName: schema.user.name,
          authorUserId: schema.contactNote.authorUserId,
        })
        .from(schema.contactNote)
        .leftJoin(schema.user, eq(schema.user.id, schema.contactNote.authorUserId))
        .where(eq(schema.contactNote.contactId, contact.id))
        .orderBy(desc(schema.contactNote.createdAt)),
      ctx.db
        .select({ id: schema.contactList.id, name: schema.contactList.name })
        .from(schema.contactListMember)
        .innerJoin(schema.contactList, eq(schema.contactList.id, schema.contactListMember.listId))
        .where(eq(schema.contactListMember.contactId, contact.id)),
      ctx.db
        .select({
          id: schema.conversation.id,
          status: schema.conversation.status,
          lastMessageAt: schema.conversation.lastMessageAt,
          channelName: schema.channelAccount.displayName,
        })
        .from(schema.conversation)
        .innerJoin(schema.channelAccount, eq(schema.channelAccount.id, schema.conversation.channelAccountId))
        .where(eq(schema.conversation.contactId, contact.id))
        .orderBy(desc(schema.conversation.lastMessageAt)),
      ctx.db
        .select({
          channelAccountId: schema.contactOptOut.channelAccountId,
          source: schema.contactOptOut.source,
          createdAt: schema.contactOptOut.createdAt,
        })
        .from(schema.contactOptOut)
        .where(eq(schema.contactOptOut.contactId, contact.id)),
    ]);
    return c2.json({ contact, identities, notes, lists, conversations, optOuts });
  });

  const contactBody = z.object({
    name: z.string().trim().max(120).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    branchId: z.string().nullable().optional(),
    tagIds: z.array(z.string()).max(50).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    /** Marketing on one channel (or every channel when channelAccountId is null): opt out or back in. */
    optOut: z.object({ channelAccountId: z.string().nullable(), optedOut: z.boolean() }).optional(),
  });

  /** Shared checks for create and update; returns the column values to write. */
  async function contactValues(orgId: string, b: z.infer<typeof contactBody>) {
    const out: Record<string, unknown> = {};
    if (b.name !== undefined) out.name = b.name || null;
    if (b.phone !== undefined) {
      const digits = (b.phone ?? "").replace(/[^\d]/g, "");
      if (digits && (digits.length < 6 || digits.length > 16))
        throw new FilterError("Phone numbers need 6 to 16 digits with country code.");
      out.phone = digits || null;
    }
    if (b.email !== undefined) {
      const e = (b.email ?? "").toLowerCase();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        throw new FilterError("That email address doesn't look right.");
      out.email = e || null;
    }
    if (b.branchId !== undefined) {
      if (b.branchId) {
        const [br] = await ctx.db
          .select({ id: schema.branch.id })
          .from(schema.branch)
          .where(and(eq(schema.branch.id, b.branchId), eq(schema.branch.organizationId, orgId)))
          .limit(1);
        if (!br) throw new FilterError("That branch doesn't exist.");
      }
      out.branchId = b.branchId;
    }
    if (b.tagIds) out.tagIds = await knownTags(orgId, b.tagIds);
    if (b.optOut?.channelAccountId && !(await ownChannel(ctx.db, orgId, b.optOut.channelAccountId)))
      throw new FilterError("That channel doesn't exist.");
    return out;
  }

  app.post("/", async (c2) => {
    const access = c2.var.access;
    if (!(await canEdit(access))) return fail(c2, 403, "forbidden", "Viewers can't add contacts.");
    const parsed = await parseBody(c2, contactBody);
    if ("error" in parsed) return parsed.error;
    try {
      const values = await contactValues(access.orgId, parsed.data);
      if (!values.name && !values.phone && !values.email)
        return fail(c2, 422, "invalid_input", "Give the contact a name, phone or email.");
      if (values.phone) {
        const [dupe] = await ctx.db
          .select({ id: c.id })
          .from(c)
          .where(and(eq(c.organizationId, access.orgId), eq(c.phone, values.phone as string)))
          .limit(1);
        if (dupe) return fail(c2, 409, "duplicate", "A contact with this phone number already exists.");
      }
      const attributes = parsed.data.attributes
        ? cleanAttributes(parsed.data.attributes, byKey(await activeFields(access.orgId)))
        : {};
      const [row] = await ctx.db
        .insert(c)
        .values({
          id: newId("contact"),
          organizationId: access.orgId,
          source: "manual",
          createdByUserId: access.userId,
          ...values,
          attributes: Object.fromEntries(Object.entries(attributes).filter(([, v]) => v !== null)),
        } as typeof c.$inferInsert)
        .returning();
      if (row && parsed.data.optOut)
        await setOptOut(
          ctx.db,
          access.orgId,
          [row.id],
          parsed.data.optOut.channelAccountId,
          parsed.data.optOut.optedOut,
          "manual",
          access.userId,
        );
      return c2.json({ contact: row }, 201);
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_input", err.message);
      throw err;
    }
  });

  // Edit fixed columns and any of the business's fields (attributes merge; null clears one).
  app.patch("/:id", async (c2) => {
    const access = c2.var.access;
    if (!(await canEdit(access))) return fail(c2, 403, "forbidden", "Viewers can't change contacts.");
    const parsed = await parseBody(c2, contactBody);
    if ("error" in parsed) return parsed.error;
    const contact = await findContact(access.orgId, c2.req.param("id"));
    if (!contact) return fail(c2, 404, "not_found");
    try {
      const values = await contactValues(access.orgId, parsed.data);
      const attrs = parsed.data.attributes
        ? cleanAttributes(parsed.data.attributes, byKey(await activeFields(access.orgId)))
        : null;
      const [row] = await ctx.db
        .update(c)
        .set({
          ...values,
          ...(attrs ? { attributes: mergeAttributes(attrs) } : {}),
          updatedAt: new Date(),
        } as never)
        .where(eq(c.id, contact.id))
        .returning();
      if (parsed.data.optOut)
        await setOptOut(
          ctx.db,
          access.orgId,
          [contact.id],
          parsed.data.optOut.channelAccountId,
          parsed.data.optOut.optedOut,
          "manual",
          access.userId,
        );
      return c2.json({ contact: row });
    } catch (err) {
      if (err instanceof FilterError) return fail(c2, 422, "invalid_input", err.message);
      throw err;
    }
  });

  const bulkSchema = z.object({
    ids: z.array(z.string()).min(1).max(5000),
    action: z.enum([
      "add_tags",
      "remove_tags",
      "opt_out",
      "opt_in",
      "set_branch",
      "add_to_list",
      "remove_from_list",
      "delete",
    ]),
    /** opt_out / opt_in: one channel, or every channel when left out. */
    channelAccountId: z.string().nullable().optional(),
    tagIds: z.array(z.string()).optional(),
    branchId: z.string().nullable().optional(),
    listId: z.string().optional(),
  });

  // Several contacts at once: tags, opt-out, branch, add to a list, delete.
  app.post("/bulk", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, bulkSchema);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    if (b.action === "delete" ? !isOrgAdmin(access.orgRole) : !(await canEdit(access)))
      return fail(c2, 403, "forbidden");
    const scope = and(eq(c.organizationId, access.orgId), inArray(c.id, b.ids));
    const now = new Date();
    let affected = 0;
    if (b.action === "add_tags" || b.action === "remove_tags") {
      const ids = await knownTags(access.orgId, b.tagIds ?? []);
      if (!ids.length) return fail(c2, 422, "invalid_input", "Pick at least one tag.");
      const arr = sql`array[${sql.join(
        ids.map((t) => sql`${t}`),
        sql`, `,
      )}]::text[]`;
      const res = await ctx.db
        .update(c)
        .set({
          tagIds:
            b.action === "add_tags"
              ? sql`array(select distinct unnest(${c.tagIds} || ${arr}))`
              : sql`array(select unnest(${c.tagIds}) except select unnest(${arr}))`,
          updatedAt: now,
        } as never)
        .where(scope)
        .returning({ id: c.id });
      affected = res.length;
    } else if (b.action === "opt_out" || b.action === "opt_in") {
      const channelId = b.channelAccountId ?? null;
      if (channelId && !(await ownChannel(ctx.db, access.orgId, channelId)))
        return fail(c2, 422, "invalid_input", "That channel doesn't exist.");
      const found = (await ctx.db.select({ id: c.id }).from(c).where(scope)).map((r) => r.id);
      await setOptOut(
        ctx.db,
        access.orgId,
        found,
        channelId,
        b.action === "opt_out",
        "manual",
        access.userId,
      );
      affected = found.length;
    } else if (b.action === "set_branch") {
      const res = await ctx.db
        .update(c)
        .set({ branchId: b.branchId ?? null, updatedAt: now })
        .where(scope)
        .returning({ id: c.id });
      affected = res.length;
    } else if (b.action === "remove_from_list") {
      const res = await ctx.db
        .delete(schema.contactListMember)
        .where(
          and(
            eq(schema.contactListMember.listId, b.listId ?? ""),
            eq(schema.contactListMember.organizationId, access.orgId),
            inArray(schema.contactListMember.contactId, b.ids),
          ),
        )
        .returning({ id: schema.contactListMember.contactId });
      affected = res.length;
    } else if (b.action === "add_to_list") {
      const [list] = await ctx.db
        .select()
        .from(schema.contactList)
        .where(
          and(eq(schema.contactList.id, b.listId ?? ""), eq(schema.contactList.organizationId, access.orgId)),
        )
        .limit(1);
      if (!list || list.kind !== "static")
        return fail(c2, 422, "invalid_input", "Pick a list you add contacts to by hand.");
      const found = await ctx.db.select({ id: c.id }).from(c).where(scope);
      if (found.length)
        await ctx.db
          .insert(schema.contactListMember)
          .values(found.map((f) => ({ listId: list.id, contactId: f.id, organizationId: access.orgId })))
          .onConflictDoNothing();
      affected = found.length;
    } else {
      const res = await ctx.db.delete(c).where(scope).returning({ id: c.id });
      affected = res.length;
    }
    return c2.json({ affected });
  });

  app.delete("/:id", async (c2) => {
    const access = c2.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c2, 403, "forbidden", "Only owners and admins can delete contacts.");
    const res = await ctx.db
      .delete(c)
      .where(and(eq(c.id, c2.req.param("id")), eq(c.organizationId, access.orgId)))
      .returning({ id: c.id });
    if (!res.length) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  /* ------------------------------------------------------------------ notes */

  app.post("/:id/notes", async (c2) => {
    const access = c2.var.access;
    if (!(await canEdit(access))) return fail(c2, 403, "forbidden");
    const parsed = await parseBody(c2, z.object({ body: z.string().trim().min(1).max(5000) }));
    if ("error" in parsed) return parsed.error;
    const contact = await findContact(access.orgId, c2.req.param("id"));
    if (!contact) return fail(c2, 404, "not_found");
    const [note] = await ctx.db
      .insert(schema.contactNote)
      .values({
        id: newId("contactNote"),
        organizationId: access.orgId,
        contactId: contact.id,
        authorUserId: access.userId,
        body: parsed.data.body,
      })
      .returning();
    return c2.json({ note }, 201);
  });

  app.delete("/:id/notes/:noteId", async (c2) => {
    const access = c2.var.access;
    const where = and(
      eq(schema.contactNote.id, c2.req.param("noteId")),
      eq(schema.contactNote.contactId, c2.req.param("id")),
      eq(schema.contactNote.organizationId, access.orgId),
      // Your own notes, or anyone's for owners and admins.
      isOrgAdmin(access.orgRole) ? undefined : eq(schema.contactNote.authorUserId, access.userId),
    );
    const res = await ctx.db.delete(schema.contactNote).where(where).returning({ id: schema.contactNote.id });
    if (!res.length) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  return app;
}

/* ===================================================================== fields */

export function contactFieldRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const f = schema.contactField;

  const fieldBody = z.object({
    label: z.string().trim().min(1, "Give the field a name").max(60),
    type: fieldTypeSchema,
    options: z.array(optionSchema).max(50).optional(),
  });

  const tidyOptions = (opts: z.infer<typeof optionSchema>[] | undefined) =>
    (opts ?? []).map((o, i) => ({
      value: fieldKey(o.value || o.label),
      label: o.label,
      colour: (optionColours as readonly string[]).includes(o.colour)
        ? o.colour
        : (optionColours[i % optionColours.length] ?? "gray"),
    }));

  app.post("/", async (c2) => {
    const access = c2.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c2, 403, "forbidden", "Only owners and admins can add fields.");
    const parsed = await parseBody(c2, fieldBody);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    if ((b.type === "select" || b.type === "multi_select") && !b.options?.length)
      return fail(c2, 422, "invalid_input", "Add at least one option.");
    const row = await createField(ctx.db, access.orgId, access.userId, b);
    return c2.json({ field: row }, 201);
  });

  // Rename, change options, reorder. The type and key never change (stored values depend on them).
  app.patch("/:id", async (c2) => {
    const access = c2.var.access;
    if (!isOrgAdmin(access.orgRole)) return fail(c2, 403, "forbidden");
    const parsed = await parseBody(
      c2,
      z.object({
        label: z.string().trim().min(1).max(60).optional(),
        options: z.array(optionSchema).max(50).optional(),
        position: z.number().int().optional(),
      }),
    );
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const [row] = await ctx.db
      .update(f)
      .set({
        ...(b.label ? { label: b.label } : {}),
        ...(b.options ? { options: tidyOptions(b.options) } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(f.id, c2.req.param("id")), eq(f.organizationId, access.orgId)))
      .returning();
    if (!row) return fail(c2, 404, "not_found");
    return c2.json({ field: row });
  });

  // Archive: the column disappears, the values stay on the contacts (restorable later).
  app.delete("/:id", async (c2) => {
    const access = c2.var.access;
    if (!isOrgAdmin(access.orgRole)) return fail(c2, 403, "forbidden");
    const [row] = await ctx.db
      .update(f)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(f.id, c2.req.param("id")), eq(f.organizationId, access.orgId)))
      .returning();
    if (!row) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  return app;
}

/* ======================================================================= tags */

export function tagRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const t = schema.tag;

  const tagBody = z.object({
    name: z.string().trim().min(1, "Give the tag a name").max(40),
    colour: z.string().max(20).optional(),
    branchId: z.string().nullable().optional(),
    channelAccountId: z.string().nullable().optional(),
  });

  async function checkScope(orgId: string, branchId?: string | null, channelId?: string | null) {
    if (branchId) {
      const [b] = await ctx.db
        .select({ id: schema.branch.id })
        .from(schema.branch)
        .where(and(eq(schema.branch.id, branchId), eq(schema.branch.organizationId, orgId)))
        .limit(1);
      if (!b) return "That branch doesn't exist.";
    }
    if (channelId) {
      const [ch] = await ctx.db
        .select({ id: schema.channelAccount.id })
        .from(schema.channelAccount)
        .where(and(eq(schema.channelAccount.id, channelId), eq(schema.channelAccount.organizationId, orgId)))
        .limit(1);
      if (!ch) return "That channel doesn't exist.";
    }
    return null;
  }

  app.get("/", async (c2) => {
    const rows = await ctx.db
      .select({
        id: t.id,
        name: t.name,
        colour: t.colour,
        branchId: t.branchId,
        channelAccountId: t.channelAccountId,
        contacts: sql<number>`(select count(*)::int from ${schema.contact} ct where ${t.id} = any(ct.tag_ids))`,
      })
      .from(t)
      .where(eq(t.organizationId, c2.var.access.orgId))
      .orderBy(asc(t.name));
    return c2.json({ tags: rows });
  });

  app.post("/", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, tagBody);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const problem = await checkScope(access.orgId, b.branchId, b.channelAccountId);
    if (problem) return fail(c2, 422, "invalid_input", problem);
    const [row] = await ctx.db
      .insert(t)
      .values({
        id: newId("tag"),
        organizationId: access.orgId,
        name: b.name,
        colour: (optionColours as readonly string[]).includes(b.colour ?? "") ? (b.colour as string) : "gray",
        branchId: b.branchId ?? null,
        channelAccountId: b.channelAccountId ?? null,
        createdByUserId: access.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) return fail(c2, 409, "duplicate", "A tag with that name already exists here.");
    return c2.json({ tag: row }, 201);
  });

  app.patch("/:id", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, tagBody.partial());
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    const problem = await checkScope(access.orgId, b.branchId, b.channelAccountId);
    if (problem) return fail(c2, 422, "invalid_input", problem);
    const [row] = await ctx.db
      .update(t)
      .set({ ...b, updatedAt: new Date() })
      .where(and(eq(t.id, c2.req.param("id")), eq(t.organizationId, access.orgId)))
      .returning();
    if (!row) return fail(c2, 404, "not_found");
    return c2.json({ tag: row });
  });

  // Deleting a tag also takes it off every contact, in one transaction.
  app.delete("/:id", async (c2) => {
    const access = c2.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c2, 403, "forbidden", "Only owners and admins can delete tags.");
    const id = c2.req.param("id");
    const done = await ctx.db.transaction(async (tx) => {
      const res = await tx
        .delete(t)
        .where(and(eq(t.id, id), eq(t.organizationId, access.orgId)))
        .returning({ id: t.id });
      if (!res.length) return false;
      await tx
        .update(schema.contact)
        .set({ tagIds: sql`array_remove(${schema.contact.tagIds}, ${id})` } as never)
        .where(
          and(eq(schema.contact.organizationId, access.orgId), sql`${id} = any(${schema.contact.tagIds})`),
        );
      return true;
    });
    if (!done) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  return app;
}

/* ====================================================================== views */

export function contactViewRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));
  const v = schema.contactView;
  const viewBody = z.object({
    name: z.string().trim().min(1).max(60),
    shared: z.boolean().default(false),
    config: z.object({
      columns: z
        .array(z.object({ id: z.string(), width: z.number().optional(), hidden: z.boolean().optional() }))
        .max(80),
      filter: filterSchema,
      sort: sortSchema,
    }),
  });
  // Your own views, or shared ones (owners and admins may change shared views).
  const mine = (access: Access, id: string) =>
    and(
      eq(v.id, id),
      eq(v.organizationId, access.orgId),
      isOrgAdmin(access.orgRole)
        ? or(isNull(v.ownerUserId), eq(v.ownerUserId, access.userId))
        : eq(v.ownerUserId, access.userId),
    );

  app.post("/", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, viewBody);
    if ("error" in parsed) return parsed.error;
    const b = parsed.data;
    if (b.shared && !isOrgAdmin(access.orgRole))
      return fail(c2, 403, "forbidden", "Only owners and admins can share views with everyone.");
    const [row] = await ctx.db
      .insert(v)
      .values({
        id: newId("contactView"),
        organizationId: access.orgId,
        ownerUserId: b.shared ? null : access.userId,
        name: b.name,
        config: b.config,
      })
      .returning();
    return c2.json({ view: row }, 201);
  });

  app.patch("/:id", async (c2) => {
    const access = c2.var.access;
    const parsed = await parseBody(c2, viewBody.partial());
    if ("error" in parsed) return parsed.error;
    const { shared: _, ...b } = parsed.data;
    const [row] = await ctx.db
      .update(v)
      .set({ ...b, updatedAt: new Date() })
      .where(mine(access, c2.req.param("id")))
      .returning();
    if (!row) return fail(c2, 404, "not_found");
    return c2.json({ view: row });
  });

  app.delete("/:id", async (c2) => {
    const res = await ctx.db
      .delete(v)
      .where(mine(c2.var.access, c2.req.param("id")))
      .returning({ id: v.id });
    if (!res.length) return fail(c2, 404, "not_found");
    return c2.body(null, 204);
  });

  return app;
}
