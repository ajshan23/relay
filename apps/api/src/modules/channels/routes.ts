import { encryptSecret, newId } from "@relay/core";
import { and, asc, eq, inArray, isNull, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { providerFailure, channels as registry } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";

/*
 * Connected channels of the active business. Plumbing for now: WhatsApp numbers are connected by
 * pasting their ids and a token (Embedded Signup comes in step 5). Tokens are checked with Meta,
 * stored encrypted and never returned.
 */

const connectBody = z.object({
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d+$/, "phoneNumberId is the numeric id from WhatsApp > API Setup"),
  wabaId: z.string().trim().regex(/^\d+$/, "wabaId is the numeric WhatsApp Business Account id"),
  accessToken: z.string().trim().min(20, "accessToken looks too short"),
  displayName: z.string().trim().max(80).optional(),
  branchIds: z.array(z.string()).optional(),
});

/** What the browser may see of a channel: never the credentials. */
const publicColumns = {
  id: schema.channelAccount.id,
  type: schema.channelAccount.type,
  displayName: schema.channelAccount.displayName,
  displayPhone: schema.channelAccount.displayPhone,
  externalId: schema.channelAccount.externalId,
  status: schema.channelAccount.status,
  statusReason: schema.channelAccount.statusReason,
  defaultBranchId: schema.channelAccount.defaultBranchId,
  providerMeta: schema.channelAccount.providerMeta,
  settings: schema.channelAccount.settings,
  createdAt: schema.channelAccount.createdAt,
};

export function channelRoutes(ctx: AppContext) {
  const app = new Hono<AccessEnv>();
  app.use(requireSession, requireOrg(ctx));

  app.get("/", async (c) => {
    const channels = await ctx.db
      .select(publicColumns)
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.organizationId, c.var.access.orgId))
      .orderBy(asc(schema.channelAccount.createdAt));
    const links = channels.length
      ? await ctx.db
          .select()
          .from(schema.channelAccountBranch)
          .where(
            inArray(
              schema.channelAccountBranch.channelAccountId,
              channels.map((ch) => ch.id),
            ),
          )
      : [];
    return c.json({
      channels: channels.map((ch) => ({
        ...ch,
        branchIds: links.filter((l) => l.channelAccountId === ch.id).map((l) => l.branchId),
        /** Whether this kind of channel can show customers read receipts and "typing…". */
        canShowRead: !!registry().get(ch.type)?.capabilities.readReceipts,
      })),
    });
  });

  // A channel's settings. Owners and admins only.
  app.patch("/:id", async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can change channel settings.");
    const parsed = await parseBody(
      c,
      z.object({ settings: z.object({ readReceipts: z.boolean().optional() }) }),
    );
    if ("error" in parsed) return parsed.error;
    const ca = schema.channelAccount;
    const [row] = await ctx.db
      .update(ca)
      .set({
        settings: sql`${ca.settings} || ${JSON.stringify(parsed.data.settings)}::jsonb`,
        updatedAt: new Date(),
      } as never)
      .where(and(eq(ca.id, c.req.param("id")), eq(ca.organizationId, access.orgId)))
      .returning(publicColumns);
    if (!row) return fail(c, 404, "not_found");
    return c.json({ channel: row });
  });

  app.post("/whatsapp", async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can connect channels.");
    const key = ctx.config.CHANNEL_SECRET_KEY;
    if (!key) return fail(c, 503, "not_configured", "CHANNEL_SECRET_KEY is not set on the server.");
    const parsed = await parseBody(c, connectBody);
    if ("error" in parsed) return parsed.error;
    const body = parsed.data;

    const [taken] = await ctx.db
      .select({ organizationId: schema.channelAccount.organizationId, status: schema.channelAccount.status })
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.type, "whatsapp"),
          eq(schema.channelAccount.externalId, body.phoneNumberId),
        ),
      )
      .limit(1);
    if (taken && (taken.organizationId !== access.orgId || taken.status !== "disconnected")) {
      return fail(c, 409, "already_connected", "This WhatsApp number is already connected to Relay.");
    }

    // Branches: the given ones (must belong to this business), or every active branch.
    const branches = await ctx.db
      .select({ id: schema.branch.id })
      .from(schema.branch)
      .where(and(eq(schema.branch.organizationId, access.orgId), isNull(schema.branch.archivedAt)))
      .orderBy(asc(schema.branch.createdAt));
    const branchIds = body.branchIds?.length ? body.branchIds : branches.map((b) => b.id);
    if (branchIds.some((id) => !branches.find((b) => b.id === id)))
      return fail(c, 422, "invalid_input", "Unknown branch in branchIds.");

    // Check the credentials with the channel (and subscribe to its webhooks) before storing anything.
    const adapter = registry().get("whatsapp");
    if (!adapter) return fail(c, 501, "not_supported", "WhatsApp is not available.");
    let connected: Awaited<ReturnType<typeof adapter.connect>>;
    try {
      connected = await adapter.connect({
        externalId: body.phoneNumberId,
        credentials: { accessToken: body.accessToken },
        providerMeta: { wabaId: body.wabaId },
      });
    } catch (err) {
      const answer = providerFailure(c, err);
      if (answer) return answer;
      throw err;
    }

    const values = {
      organizationId: access.orgId,
      type: "whatsapp" as const,
      provider: "meta",
      externalId: body.phoneNumberId,
      displayName: body.displayName ?? connected.displayName,
      displayPhone: connected.displayPhone,
      status: "active" as const,
      statusReason: null,
      credentials: encryptSecret({ accessToken: body.accessToken }, key),
      providerMeta: connected.providerMeta,
      defaultBranchId: branchIds[0] ?? null,
      updatedAt: new Date(),
    };

    const id = await ctx.db.transaction(async (tx) => {
      let channelId: string;
      if (taken) {
        // Reconnecting a number this business disconnected before: keep its history.
        const [row] = await tx
          .update(schema.channelAccount)
          .set(values)
          .where(
            and(
              eq(schema.channelAccount.type, "whatsapp"),
              eq(schema.channelAccount.externalId, body.phoneNumberId),
            ),
          )
          .returning({ id: schema.channelAccount.id });
        channelId = row?.id ?? "";
        await tx
          .delete(schema.channelAccountBranch)
          .where(eq(schema.channelAccountBranch.channelAccountId, channelId));
      } else {
        channelId = newId("channelAccount");
        await tx.insert(schema.channelAccount).values({ id: channelId, ...values });
      }
      if (branchIds.length) {
        await tx.insert(schema.channelAccountBranch).values(
          branchIds.map((branchId) => ({
            channelAccountId: channelId,
            branchId,
            organizationId: access.orgId,
          })),
        );
      }
      return channelId;
    });

    const [channel] = await ctx.db
      .select(publicColumns)
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, id));
    return c.json({ channel: { ...channel, branchIds } }, taken ? 200 : 201);
  });

  // Disconnect: stops sending and receiving, keeps every conversation and message.
  app.delete("/:id", async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can disconnect channels.");
    const [row] = await ctx.db
      .update(schema.channelAccount)
      .set({ status: "disconnected", statusReason: "Disconnected by a person", updatedAt: new Date() })
      .where(
        and(
          eq(schema.channelAccount.id, c.req.param("id")),
          eq(schema.channelAccount.organizationId, access.orgId),
        ),
      )
      .returning({ id: schema.channelAccount.id });
    if (!row) return fail(c, 404, "not_found");
    return c.body(null, 204);
  });

  return app;
}
