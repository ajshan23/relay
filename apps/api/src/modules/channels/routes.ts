import { and, asc, eq, inArray, isNull, schema, sql } from "@relay/db";
import { Hono } from "hono";
import { z } from "zod";
import { providerFailure, channels as registry } from "../../channels";
import type { AppContext } from "../../context";
import { requireSession } from "../auth/session";
import { type AccessEnv, fail, isOrgAdmin, requireOrg } from "../branches/access";
import { parseBody } from "../branches/routes";
import { requireBranch } from "../contacts/shared";
import { finishSetup, runEmbeddedSignup, signupBody } from "./embedded-signup";
import { saveWhatsAppChannel } from "./save";

/*
 * Connected channels of the active business. WhatsApp numbers are connected by the business itself
 * through Meta's Embedded Signup (embedded-signup.ts), or by pasting ids and a token (support use).
 * Tokens are checked with Meta, stored encrypted and never returned.
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

    const saved = await saveWhatsAppChannel(ctx, key, {
      orgId: access.orgId,
      phoneNumberId: body.phoneNumberId,
      credentials: { accessToken: body.accessToken },
      displayName: body.displayName ?? connected.displayName,
      displayPhone: connected.displayPhone,
      providerMeta: {
        ...connected.providerMeta,
        onboarding: { method: "manual", coexistence: false, onboardedAt: new Date().toISOString() },
      },
      status: "active",
      branchIds,
      allowActive: false,
    });
    if (!saved.ok)
      return fail(c, saved.status, saved.code === "taken" ? "already_connected" : saved.code, saved.message);
    const [channel] = await ctx.db
      .select(publicColumns)
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, saved.id));
    return c.json({ channel: { ...channel, branchIds } }, saved.reconnected ? 200 : 201);
  });

  // Embedded Signup: what the browser needs to open Meta's window (nothing secret).
  app.get("/whatsapp/signup-config", (c) => {
    const cfg = ctx.config;
    // Meta ids are numbers; anything else (a placeholder left in .env) would open a broken Meta window.
    const numeric = (v?: string) => !!v && /^\d+$/.test(v);
    const enabled =
      numeric(cfg.META_APP_ID) &&
      numeric(cfg.META_CONFIG_ID) &&
      !!cfg.META_APP_SECRET &&
      !!cfg.CHANNEL_SECRET_KEY;
    if (cfg.META_CONFIG_ID && !numeric(cfg.META_CONFIG_ID))
      console.warn("META_CONFIG_ID is not a number; Embedded Signup stays off until it is fixed");
    return c.json({
      enabled,
      appId: enabled ? cfg.META_APP_ID : null,
      configId: enabled ? cfg.META_CONFIG_ID : null,
      graphVersion: cfg.META_GRAPH_VERSION,
    });
  });

  // Embedded Signup: the popup finished. Connects the number to the current branch (?branch=).
  app.post("/whatsapp/embedded-signup", requireBranch(ctx), async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can connect channels.");
    const parsed = await parseBody(c, signupBody);
    if ("error" in parsed) return parsed.error;
    const result = await runEmbeddedSignup(
      ctx,
      { orgId: access.orgId, branchId: c.var.branchId, userId: access.userId },
      parsed.data,
    );
    if (!result.ok) return fail(c, result.status, result.code, result.message);
    const [channel] = await ctx.db
      .select(publicColumns)
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, result.channelId));
    return c.json({ channel, setupError: result.setupError ?? null }, result.reconnected ? 200 : 201);
  });

  // Embedded Signup: "did it finish?" after a dropped answer (the popup's code can't be used twice).
  app.get("/whatsapp/embedded-signup/:attemptId", async (c) => {
    const oa = schema.onboardingAttempt;
    const [row] = await ctx.db
      .select({
        status: oa.status,
        step: oa.step,
        errorCode: oa.errorCode,
        errorMessage: oa.errorMessage,
        channelAccountId: oa.channelAccountId,
      })
      .from(oa)
      .where(and(eq(oa.id, c.req.param("attemptId")), eq(oa.organizationId, c.var.access.orgId)));
    if (!row) return fail(c, 404, "not_found");
    return c.json({ attempt: row });
  });

  // Retries the steps after saving (webhooks, registration) with the stored token.
  app.post("/:id/finish-setup", async (c) => {
    const access = c.var.access;
    if (!isOrgAdmin(access.orgRole))
      return fail(c, 403, "forbidden", "Only owners and admins can change channels.");
    const [ch] = await ctx.db
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.id, c.req.param("id")),
          eq(schema.channelAccount.organizationId, access.orgId),
        ),
      );
    if (!ch) return fail(c, 404, "not_found");
    const done = await finishSetup(ctx, ch.id);
    const [channel] = await ctx.db
      .select(publicColumns)
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.id, ch.id));
    return c.json({ channel, setupError: done.error ?? null }, done.ok ? 200 : 502);
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
