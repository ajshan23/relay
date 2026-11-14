import { GraphError } from "../meta/errors";
import type { GraphClient } from "../meta/graph";

/*
 * Embedded Signup (v5) and coexistence calls to Meta, used when a business connects its own number.
 * Order on our side: exchange the code, check what the token may reach, verify the number belongs to
 * the business account, subscribe our app to its webhooks, register the number (not for coexistence),
 * then, for coexistence, ask Meta to send the phone app's contacts and chat history.
 * Sources: developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/*
 */

export type AppCredentials = { appId: string; appSecret: string };

/** The app access token "<app id>|<app secret>", for calls made as the app itself (debug_token). */
const appToken = (app: AppCredentials) => `${app.appId}|${app.appSecret}`;

/**
 * Exchanges the code from the signup popup for the business's token (a business integration system
 * user token, scoped to the assets the business picked). The code lives about 30 seconds.
 */
export async function exchangeSignupCode(graph: GraphClient, app: AppCredentials, code: string) {
  const params = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, code });
  const res = await graph.request<{ access_token?: string; expires_in?: number }>(
    "GET",
    `oauth/access_token?${params}`,
    "",
  );
  if (!res.access_token)
    throw new GraphError("Meta returned no access token", "permanent", 200, undefined, undefined);
  return { accessToken: res.access_token, expiresIn: res.expires_in ?? null };
}

export type TokenGrants = {
  valid: boolean;
  /** Seconds since 1970; null or 0 means it does not expire. */
  expiresAt: number | null;
  scopes: string[];
  /** WhatsApp business (messaging) account ids the token may manage or message. */
  wabaIds: string[];
  /** The business portfolio the token was granted for, when Meta says. */
  businessIds: string[];
};

/** What a token may reach: its permissions and, per permission, the exact accounts. */
export async function inspectToken(
  graph: GraphClient,
  app: AppCredentials,
  token: string,
): Promise<TokenGrants> {
  const res = await graph.request<{
    data?: {
      is_valid?: boolean;
      expires_at?: number;
      scopes?: string[];
      granular_scopes?: { scope: string; target_ids?: string[] }[];
    };
  }>("GET", `debug_token?input_token=${encodeURIComponent(token)}`, appToken(app));
  const d = res.data ?? {};
  const targets = (scope: string) => d.granular_scopes?.find((g) => g.scope === scope)?.target_ids ?? [];
  const wabaIds = [
    ...new Set([...targets("whatsapp_business_management"), ...targets("whatsapp_business_messaging")]),
  ];
  return {
    valid: d.is_valid ?? false,
    expiresAt: d.expires_at || null,
    scopes: d.scopes ?? [],
    wabaIds,
    businessIds: targets("business_management"),
  };
}

export type PhoneDetails = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  status?: string;
  code_verification_status?: string;
  name_status?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  quality_rating?: string;
  throughput?: { level?: string };
  whatsapp_business_manager_messaging_limit?: string;
};

const phoneFields = [
  "display_phone_number",
  "verified_name",
  "status",
  "code_verification_status",
  "name_status",
  "platform_type",
  "is_on_biz_app",
  "quality_rating",
  "throughput",
  "whatsapp_business_manager_messaging_limit",
].join(",");

/** Every number on a WhatsApp business account (Meta pages the list). */
export async function listWhatsAppNumbers(graph: GraphClient, wabaId: string, token: string) {
  const out: PhoneDetails[] = [];
  let path: string | null = `${wabaId}/phone_numbers?fields=${phoneFields}&limit=100`;
  for (let page = 0; path && page < 20; page++) {
    const res: { data?: PhoneDetails[]; paging?: { cursors?: { after?: string }; next?: string } } =
      await graph.request("GET", path, token);
    out.push(...(res.data ?? []));
    const after = res.paging?.next ? res.paging.cursors?.after : undefined;
    path = after
      ? `${wabaId}/phone_numbers?fields=${phoneFields}&limit=100&after=${encodeURIComponent(after)}`
      : null;
  }
  return out;
}

/** Everything we track about one number. */
export function describeWhatsAppPhone(graph: GraphClient, phoneNumberId: string, token: string) {
  return graph.request<PhoneDetails>("GET", `${phoneNumberId}?fields=${phoneFields}`, token);
}

/** Webhook fields we need from every connected business account. */
export const subscribedFields = [
  "messages",
  "account_update",
  "message_template_status_update",
  "message_template_quality_update",
  "phone_number_quality_update",
  "phone_number_name_update",
  "business_capability_update",
  "business_username_updates",
] as const;

/** Extra fields for numbers that stay on the WhatsApp Business app (coexistence). */
export const coexistenceFields = ["history", "smb_app_state_sync", "smb_message_echoes"] as const;

/**
 * Subscribes our app to the business account's webhooks. The field list is sent every time so Meta
 * never falls back to its defaults.
 */
export async function subscribeApp(graph: GraphClient, wabaId: string, token: string, coexistence: boolean) {
  const fields = [...subscribedFields, ...(coexistence ? coexistenceFields : [])];
  const res = await graph.request<{ success?: boolean }>("POST", `${wabaId}/subscribed_apps`, token, {
    subscribed_fields: fields,
  });
  if (res.success === false)
    throw new GraphError("Meta did not subscribe the account", "permanent", 200, undefined, undefined);
  return fields;
}

export async function unsubscribeApp(graph: GraphClient, wabaId: string, token: string) {
  await graph.request("DELETE", `${wabaId}/subscribed_apps`, token);
}

/** A random 6-digit PIN for registering a number (it becomes its two-step verification PIN). */
export function newRegistrationPin() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** Registers a number for the Cloud API. Not for coexistence numbers, which are already registered. */
export async function registerPhone(graph: GraphClient, phoneNumberId: string, token: string, pin: string) {
  await graph.request("POST", `${phoneNumberId}/register`, token, { messaging_product: "whatsapp", pin });
}

export type SmbSyncType = "smb_app_state_sync" | "history";

/**
 * Asks Meta to send a coexistence number's phone-app contacts (smb_app_state_sync) or chat history
 * (history) as webhooks. Each runs once per onboarding, within 24 hours of it.
 */
export async function requestSmbSync(
  graph: GraphClient,
  phoneNumberId: string,
  token: string,
  type: SmbSyncType,
) {
  const res = await graph.request<{ request_id?: string }>("POST", `${phoneNumberId}/smb_app_data`, token, {
    messaging_product: "whatsapp",
    sync_type: type,
  });
  return res.request_id ?? null;
}

/** Meta error codes the onboarding flow treats specially. */
export const onboardingErrors = {
  /** The business turned off history sharing in the phone app. */
  historyDeclined: 2593109,
  /** Registration rate limit: 10 per number per 72 hours. */
  registerRateLimited: 133016,
} as const;

/** Classifies a coexistence sync failure (from FlowFlex's tested handling). */
export function smbSyncFailure(
  err: unknown,
): "declined" | "expired" | "already_requested" | "failed" | "retry" {
  if (!(err instanceof GraphError)) return "retry";
  const text = err.message.toLowerCase();
  if (err.code === onboardingErrors.historyDeclined) return "declined";
  if (text.includes("outside of allowed time window") || text.includes("within 24 hours")) return "expired";
  if (text.includes("already") && text.includes("request")) return "already_requested";
  // A rejected token or request is a failure to show, not the 24-hour window closing.
  return err.kind === "permanent" || err.kind === "authFailed" ? "failed" : "retry";
}

/**
 * Where a WhatsApp user id (BSUID) is valid: the business portfolio. Numbers connected through
 * Embedded Signup know it (businessId); older ones fall back to the business account id, which the
 * webhooks carry. Lookups accept both, so identities move to the portfolio scope as people write in.
 */
export function identityScope(
  providerMeta: Record<string, unknown> | null | undefined,
  fallback: string,
): string {
  const businessId = providerMeta?.businessId;
  return typeof businessId === "string" && businessId ? businessId : fallback;
}
