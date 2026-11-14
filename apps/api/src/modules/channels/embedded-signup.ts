import {
  type AppCredentials,
  describeWhatsAppPhone,
  exchangeSignupCode,
  GraphError,
  GraphUncertainError,
  inspectToken,
  listWhatsAppNumbers,
  newRegistrationPin,
  type PhoneDetails,
  registerPhone,
  subscribeApp,
} from "@relay/channels";
import { decryptSecretJson, encryptSecret } from "@relay/core";
import { and, eq, schema, sql } from "@relay/db";
import { z } from "zod";
import { metaGraph } from "../../channels";
import type { AppContext } from "../../context";
import { saveWhatsAppChannel } from "./save";

/*
 * Meta's Embedded Signup (v5): a business connects its own WhatsApp number from Settings → Channels.
 * The browser sends the popup's code (it works once, for about 30 s) and what the popup said; the
 * server checks every id with Meta itself before trusting it. Steps, in order:
 *   exchange the code → check the token's permissions and accounts → find the number on the account →
 *   save the channel (setting_up) → subscribe our app to its webhooks → register the number (not for
 *   coexistence) → active, then template import and, for coexistence, the contacts + history sync.
 * The channel is saved before the follow-up steps, so a failure there can be finished later
 * ("Finish setup") with the stored token instead of asking the business to start again.
 */

export const signupBody = z.object({
  attemptId: z.string().uuid(),
  code: z.string().min(10).max(2048),
  session: z
    .object({
      event: z.string().max(80).optional(),
      phoneNumberId: z.string().regex(/^\d+$/).optional(),
      messagingAccountIds: z.array(z.string().regex(/^\d+$/)).max(10).optional(),
      businessId: z.string().regex(/^\d+$/).optional(),
      isOnBizApp: z.boolean().optional(),
    })
    .default({}),
  reconnectChannelId: z.string().max(64).optional(),
});
export type SignupBody = z.infer<typeof signupBody>;

type Failure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 502 | 503 | 504;
  code: string;
  message: string;
};
export type SignupResult =
  | { ok: true; channelId: string; reconnected: boolean; setupError?: string }
  | Failure;

const fail = (status: Failure["status"], code: string, message: string): Failure => ({
  ok: false,
  status,
  code,
  message,
});

/** Meta's error turned into words for the business, without internal details. */
function metaFailure(err: unknown, during: string): Failure {
  if (err instanceof GraphUncertainError)
    return fail(
      504,
      "meta_unreachable",
      `Meta didn't answer while ${during}. Wait a minute and check this page; if the number isn't here, run the setup again.`,
    );
  if (err instanceof GraphError) {
    const said = (err.details?.error_user_msg as string | undefined) ?? err.message;
    return fail(502, "meta_rejected", `Meta refused while ${during}: ${said}`);
  }
  throw err;
}

async function step(ctx: AppContext, attemptId: string, name: string, extra: Record<string, unknown> = {}) {
  await ctx.db
    .update(schema.onboardingAttempt)
    .set({ step: name, updatedAt: new Date(), ...extra })
    .where(eq(schema.onboardingAttempt.id, attemptId));
}

export async function runEmbeddedSignup(
  ctx: AppContext,
  who: { orgId: string; branchId: string; userId: string },
  body: SignupBody,
): Promise<SignupResult> {
  const config = ctx.config;
  if (!config.META_APP_ID || !config.META_APP_SECRET || !config.CHANNEL_SECRET_KEY)
    return fail(503, "not_configured", "WhatsApp signup isn't set up on this server yet.");
  const app: AppCredentials = { appId: config.META_APP_ID, appSecret: config.META_APP_SECRET };
  const key = config.CHANNEL_SECRET_KEY;
  const graph = metaGraph();
  const oa = schema.onboardingAttempt;
  const session = body.session;

  // One attempt id runs once. A repeat (double click, retried request) gets the first run's answer.
  const inserted = await ctx.db
    .insert(oa)
    .values({
      id: body.attemptId,
      organizationId: who.orgId,
      branchId: who.branchId,
      userId: who.userId,
      session: { ...session, reconnectChannelId: body.reconnectChannelId ?? null },
    })
    .onConflictDoNothing()
    .returning({ id: oa.id });
  if (!inserted.length) {
    const [prev] = await ctx.db
      .select()
      .from(oa)
      .where(and(eq(oa.id, body.attemptId), eq(oa.organizationId, who.orgId)));
    if (prev?.status === "done" && prev.channelAccountId)
      return { ok: true, channelId: prev.channelAccountId, reconnected: false };
    if (prev?.status === "running") return fail(409, "busy", "This connection is still being set up.");
    return fail(
      409,
      prev?.errorCode ?? "failed",
      prev?.errorMessage ?? "This attempt already finished. Run the setup again.",
    );
  }

  const result = await connect().catch((err: unknown) => metaFailure(err, "connecting the number"));
  if (result.ok)
    await step(ctx, body.attemptId, "done", {
      status: "done",
      channelAccountId: result.channelId,
      errorMessage: result.setupError ?? null,
    });
  else
    await step(ctx, body.attemptId, "failed", {
      status: "failed",
      errorCode: result.code,
      errorMessage: result.message,
    });
  return result;

  async function connect(): Promise<SignupResult> {
    // 1. The code, straight away: it expires within seconds.
    await step(ctx, body.attemptId, "exchange");
    let token: string;
    try {
      token = (await exchangeSignupCode(graph, app, body.code)).accessToken;
    } catch (err) {
      if (err instanceof GraphError && err.kind !== "retryable")
        return fail(
          422,
          "code_rejected",
          "Meta didn't accept the sign-in (it may have taken too long). Run the setup again.",
        );
      return metaFailure(err, "confirming the sign-in");
    }

    // 2. What the token may reach. Never trust the browser's ids on their own.
    await step(ctx, body.attemptId, "grants");
    const grants = await inspectToken(graph, app, token);
    const needed = ["whatsapp_business_management", "whatsapp_business_messaging"];
    if (!grants.valid || needed.some((s) => !grants.scopes.includes(s)))
      return fail(
        403,
        "missing_permission",
        "Relay wasn't allowed to manage and send with this WhatsApp account. Run the setup again and leave every permission on.",
      );

    // 3. The business account: the one the popup named, if Meta confirms the token reaches it.
    let wabaId: string | undefined;
    const named = session.messagingAccountIds ?? [];
    if (named.length) {
      wabaId = named.find((id) => grants.wabaIds.includes(id));
      if (!wabaId)
        return fail(
          409,
          "account_mismatch",
          "Meta's answer didn't match the account you picked. Run the setup again.",
        );
    } else if (grants.wabaIds.length === 1) {
      wabaId = grants.wabaIds[0];
    } else if (!grants.wabaIds.length) {
      return fail(
        422,
        "no_account",
        "No WhatsApp business account was shared with Relay. Run the setup again.",
      );
    } else {
      return fail(
        409,
        "pick_one",
        "More than one WhatsApp account was shared. Run the setup again and pick one.",
      );
    }
    if (!wabaId) return fail(422, "no_account", "No WhatsApp business account was shared with Relay.");

    // 4. The number, which must be on that account.
    await step(ctx, body.attemptId, "number");
    const numbers = await listWhatsAppNumbers(graph, wabaId, token);
    let phone: PhoneDetails | undefined;
    if (session.phoneNumberId) {
      phone = numbers.find((n) => n.id === session.phoneNumberId);
      if (!phone)
        return fail(
          409,
          "number_mismatch",
          "That number isn't on the WhatsApp account you shared. Run the setup again.",
        );
    } else if (numbers.length === 1) {
      phone = numbers[0];
    } else if (!numbers.length) {
      return fail(
        422,
        "no_number",
        "Meta didn't share a phone number. Run the setup again and add a number.",
      );
    } else {
      return fail(409, "pick_one", "Several numbers were shared. Run the setup again and pick one.");
    }
    if (!phone) return fail(422, "no_number", "Meta didn't share a phone number.");
    const details = await describeWhatsAppPhone(graph, phone.id, token).catch(() => phone as PhoneDetails);
    const coexistence =
      session.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || details.is_on_biz_app === true;
    const businessId =
      (session.businessId && (!grants.businessIds.length || grants.businessIds.includes(session.businessId))
        ? session.businessId
        : grants.businessIds[0]) ?? null;

    // A reconnect must keep the same account too (the number check is in saveWhatsAppChannel).
    if (body.reconnectChannelId) {
      const [ch] = await ctx.db
        .select({ meta: schema.channelAccount.providerMeta })
        .from(schema.channelAccount)
        .where(
          and(
            eq(schema.channelAccount.id, body.reconnectChannelId),
            eq(schema.channelAccount.organizationId, who.orgId),
          ),
        );
      const before = (ch?.meta as { wabaId?: string } | undefined)?.wabaId;
      if (before && before !== wabaId)
        return fail(
          409,
          "different_account",
          "That number now sits on a different WhatsApp account. Disconnect it and connect it as new.",
        );
    }

    // 5. Save first (setting_up), so later steps can be finished without a new code.
    await step(ctx, body.attemptId, "save");
    const now = new Date();
    const saved = await saveWhatsAppChannel(ctx, key, {
      orgId: who.orgId,
      phoneNumberId: phone.id,
      credentials: { accessToken: token },
      displayName: details.verified_name ?? details.display_phone_number ?? "WhatsApp",
      displayPhone: details.display_phone_number ?? null,
      providerMeta: {
        wabaId,
        businessId,
        verifiedName: details.verified_name,
        qualityRating: details.quality_rating,
        messagingLimit: details.whatsapp_business_manager_messaging_limit,
        nameStatus: details.name_status,
        healthAt: now.toISOString(),
        onboarding: {
          method: "embedded_signup",
          version: "v5",
          coexistence,
          attemptId: body.attemptId,
          onboardedAt: now.toISOString(),
          tokenExpiresAt: grants.expiresAt ? new Date(grants.expiresAt * 1000).toISOString() : null,
        },
        registration: undefined,
        ...(coexistence
          ? {
              coexistence: {
                windowEndsAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
                contacts: { status: "pending" },
                history: { status: "pending" },
              },
            }
          : {}),
      },
      status: "setting_up",
      branchIds: [who.branchId],
      reconnectChannelId: body.reconnectChannelId ?? null,
      allowActive: true,
    });
    if (!saved.ok) return fail(saved.status, saved.code, saved.message);
    await step(ctx, body.attemptId, "subscribe", { channelAccountId: saved.id });

    // 6. Webhooks, registration and follow-up jobs.
    const finished = await finishSetup(ctx, saved.id, { phoneStatus: details.status });
    return { ok: true, channelId: saved.id, reconnected: saved.reconnected, setupError: finished.error };
  }
}

/**
 * The steps after saving, also run by "Finish setup": subscribe our app to the account's webhooks
 * (required: without it no message reaches Relay), register the number (not for coexistence numbers,
 * and only when it isn't connected yet), then mark it active and queue the follow-up jobs.
 */
export async function finishSetup(
  ctx: AppContext,
  channelId: string,
  hints: { phoneStatus?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const ca = schema.channelAccount;
  const key = ctx.config.CHANNEL_SECRET_KEY ?? "";
  const [ch] = await ctx.db.select().from(ca).where(eq(ca.id, channelId));
  if (!ch) return { ok: false, error: "Channel not found" };
  const meta = ch.providerMeta as {
    wabaId?: string;
    onboarding?: { coexistence?: boolean };
    registration?: { status?: string };
  };
  const secrets = decryptSecretJson(ch.credentials, key) as { accessToken: string; pin?: string };
  const coexistence = !!meta.onboarding?.coexistence;
  const graph = metaGraph();
  const at = new Date().toISOString();

  const setMeta = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ctx.db
      .update(ca)
      .set({
        providerMeta: sql`${ca.providerMeta} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
        ...extra,
      } as never)
      .where(eq(ca.id, channelId));

  // Webhooks: required.
  try {
    if (!meta.wabaId) throw new Error("No WhatsApp business account id on this channel");
    const fields = await subscribeApp(graph, meta.wabaId, secrets.accessToken, coexistence);
    await setMeta({
      onboarding: { ...(ch.providerMeta as { onboarding?: object }).onboarding, subscribedFields: fields },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.db
      .update(ca)
      .set({
        status: "setting_up",
        statusReason: `Meta didn't turn on messages for this number yet: ${msg}`,
        updatedAt: new Date(),
      })
      .where(eq(ca.id, channelId));
    return {
      ok: false,
      error: "Connected, but Meta didn't turn on incoming messages yet. Use “Finish setup” to try again.",
    };
  }

  // Registration: not for coexistence numbers (already registered by the phone app).
  if (!coexistence && meta.registration?.status !== "registered") {
    let phoneStatus = hints.phoneStatus;
    if (!phoneStatus)
      phoneStatus = (await describeWhatsAppPhone(graph, ch.externalId, secrets.accessToken).catch(() => null))
        ?.status;
    if (phoneStatus === "CONNECTED") {
      await setMeta({ registration: { status: "not_needed", at } });
    } else {
      const pin = secrets.pin ?? newRegistrationPin();
      try {
        await registerPhone(graph, ch.externalId, secrets.accessToken, pin);
        await ctx.db
          .update(ca)
          .set({ credentials: encryptSecret({ ...secrets, pin }, key), updatedAt: new Date() })
          .where(eq(ca.id, channelId));
        await setMeta({ registration: { status: "registered", at } });
      } catch (err) {
        // Not fatal: Meta may already have the number on the Cloud API, or limit retries (10 per 72 h).
        const msg = err instanceof Error ? err.message : String(err);
        await setMeta({ registration: { status: "failed", at, error: msg } });
      }
    }
  } else if (coexistence) {
    await setMeta({ registration: { status: "not_needed", at } });
  }

  await ctx.db
    .update(ca)
    .set({ status: "active", statusReason: null, updatedAt: new Date() })
    .where(eq(ca.id, channelId));

  // Follow-ups: import its approved templates; coexistence asks for contacts and history.
  await ctx.queues.templates.add(
    "sync",
    { action: "sync", channelAccountId: channelId },
    { jobId: `sync_${channelId}_${Date.now()}` },
  );
  if (coexistence) {
    await ctx.queues.onboarding.add(
      "coexistence-sync",
      { channelAccountId: channelId },
      {
        jobId: `coexistence_${channelId}_${Date.now()}`,
        delay: 30_000,
        attempts: 5,
        backoff: { type: "exponential", delay: 15_000 },
      },
    );
    await ctx.queues.onboarding.add(
      "coexistence-expire",
      { channelAccountId: channelId },
      { jobId: `coexistence-expire_${channelId}_${Date.now()}`, delay: 24 * 3600 * 1000 },
    );
  }
  return { ok: true };
}
