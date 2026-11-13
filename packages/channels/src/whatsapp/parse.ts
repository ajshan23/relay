import type {
  ChannelIdentity,
  ConversationTarget,
  DeliveryStatus,
  GroupEvent,
  MediaRef,
  MessageContent,
  MessageContext,
  NormalizedEvent,
  ProviderError,
} from "../types";

/*
 * Turns a WhatsApp Cloud API webhook into Relay events. Iterates every entry, change, message and
 * status (never index 0 only), tolerates missing optional fields, and keeps unknown message types
 * as "unsupported" instead of dropping them. Field names: research/01-whatsapp-cloud-api.md and
 * ~/Desktop/flowflex/META_WHATSAPP_WEBHOOK_PAYLOADS.md.
 */

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asArray = (v: unknown): Json[] => (Array.isArray(v) ? v.map(asObject) : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const seconds = (v: unknown): Date => new Date((num(v) ?? 0) * 1000);

function errorsOf(v: unknown): ProviderError[] {
  return asArray(v).map((e) => ({
    code: num(e.code) ?? 0,
    title: str(e.title),
    message: str(e.message),
    details: str(asObject(e.error_data).details),
  }));
}

function media(v: unknown): MediaRef {
  const m = asObject(v);
  return {
    providerMediaId: str(m.id) ?? "",
    mimeType: str(m.mime_type),
    sha256: str(m.sha256),
    fileName: str(m.filename),
    caption: str(m.caption),
  };
}

function content(msg: Json): MessageContent {
  const type = str(msg.type) ?? "unsupported";
  switch (type) {
    case "text":
      return { type: "text", text: str(asObject(msg.text).body) ?? "" };
    case "image":
    case "video":
      return { type, media: media(msg[type]) };
    case "sticker":
      return {
        type: "sticker",
        media: media(msg.sticker),
        animated: asObject(msg.sticker).animated === true,
      };
    case "audio":
      return { type: "audio", media: media(msg.audio), voice: asObject(msg.audio).voice === true };
    case "document":
      return { type: "document", media: media(msg.document) };
    case "location": {
      const l = asObject(msg.location);
      return {
        type: "location",
        latitude: num(l.latitude) ?? 0,
        longitude: num(l.longitude) ?? 0,
        name: str(l.name),
        address: str(l.address),
        url: str(l.url),
      };
    }
    case "contacts":
      return { type: "contacts", contacts: asArray(msg.contacts) };
    case "button": {
      const b = asObject(msg.button);
      return { type: "button", payload: str(b.payload) ?? "", text: str(b.text) ?? "" };
    }
    case "interactive":
      return interactive(asObject(msg.interactive));
    case "order": {
      const o = asObject(msg.order);
      return {
        type: "order",
        catalogId: str(o.catalog_id),
        text: str(o.text),
        items: asArray(o.product_items).map((i) => ({
          productId: str(i.product_retailer_id) ?? "",
          quantity: num(i.quantity) ?? 0,
          price: num(i.item_price) ?? 0,
          currency: str(i.currency) ?? "",
        })),
      };
    }
    default: {
      const reason = str(asObject(msg.unsupported).type) ?? (type === "unsupported" ? null : type);
      return { type: "unsupported", reason };
    }
  }
}

function interactive(i: Json): MessageContent {
  const kind = str(i.type);
  if (kind === "button_reply" || kind === "list_reply") {
    const r = asObject(i[kind]);
    return {
      type: "interactive",
      kind,
      id: str(r.id) ?? "",
      title: str(r.title) ?? "",
      description: str(r.description),
    };
  }
  if (kind === "nfm_reply") {
    const r = asObject(i.nfm_reply);
    const raw = str(r.response_json) ?? "";
    let response: Record<string, unknown> | null = null;
    try {
      response = raw ? asObject(JSON.parse(raw)) : null;
    } catch {
      response = null;
    }
    return { type: "interactive", kind: "flow_reply", name: str(r.name) ?? "", response, responseRaw: raw };
  }
  if (kind === "call_permission_reply") {
    const r = asObject(i.call_permission_reply);
    return { type: "interactive", kind: "call_permission_reply", response: str(r.response) ?? "", data: r };
  }
  return { type: "unsupported", reason: kind ? `interactive:${kind}` : "interactive" };
}

function context(msg: Json): MessageContext {
  const c = asObject(msg.context);
  const product = asObject(c.referred_product);
  const referral = asObject(msg.referral);
  return {
    replyToExternalId: str(c.id),
    forwarded: c.forwarded === true,
    frequentlyForwarded: c.frequently_forwarded === true,
    referredProduct:
      str(product.catalog_id) && str(product.product_retailer_id)
        ? {
            catalogId: str(product.catalog_id) as string,
            productId: str(product.product_retailer_id) as string,
          }
        : null,
    adReferral: Object.keys(referral).length ? referral : null,
  };
}

/**
 * The sender of a message. The business-scoped user id (BSUID) is preferred because the phone
 * number can be hidden for username users; the phone is kept when Meta shares it.
 */
function identity(msg: Json, contacts: Json[], scope: string): ChannelIdentity | null {
  const fromUserId = str(msg.from_user_id);
  const from = str(msg.from);
  const contact =
    contacts.find((c) => (fromUserId && str(c.user_id) === fromUserId) || (from && str(c.wa_id) === from)) ??
    (contacts.length === 1 ? contacts[0] : undefined) ??
    {};
  const userId = fromUserId ?? str(contact.user_id);
  const phone = str(contact.wa_id) ?? from;
  const externalId = userId ?? phone;
  if (!externalId) return null;
  const profile = asObject(contact.profile);
  return { externalId, scope, phone, username: str(profile.username), profileName: str(profile.name) };
}

/** A group participant as the group webhooks describe them (BSUID always, phone sometimes). */
function participant(p: Json, scope: string): ChannelIdentity | null {
  const userId = str(p.user_id);
  const phone = str(p.wa_id) ?? (str(p.input)?.match(/^\+?\d+$/) ? str(p.input) : null);
  const externalId = userId ?? phone;
  if (!externalId) return null;
  return { externalId, scope, phone, username: str(p.username), profileName: null };
}

function conversationOf(msg: Json): ConversationTarget {
  const groupId = str(msg.group_id);
  return groupId ? { kind: "group", groupExternalId: groupId } : { kind: "direct" };
}

const groupFields = new Set([
  "group_lifecycle_update",
  "group_participants_update",
  "group_settings_update",
  "group_status_update",
]);

/** The four WhatsApp group webhook fields, turned into Relay's channel-agnostic group events. */
function groupEvents(
  base: { channel: "whatsapp"; accountExternalId: string },
  value: Json,
  scope: string,
): GroupEvent[] {
  const out: GroupEvent[] = [];
  for (const g of asArray(value.groups)) {
    const type = str(g.type);
    const common = {
      ...base,
      groupExternalId: str(g.group_id),
      requestId: str(g.request_id),
      at: seconds(g.timestamp),
    };
    const errors = errorsOf(g.errors);
    const people = (v: unknown) =>
      asArray(v)
        .map((p) => participant(p, scope))
        .filter((p): p is ChannelIdentity => !!p);

    if (type === "group_create") {
      if (errors.length) out.push({ ...common, kind: "group.failed", operation: "create", errors });
      else
        out.push({
          ...common,
          kind: "group.created",
          subject: str(g.subject),
          description: str(g.description),
          inviteLink: str(g.invite_link),
          joinApprovalMode: str(g.join_approval_mode),
        });
    } else if (type === "group_delete") {
      out.push(
        errors.length
          ? { ...common, kind: "group.failed", operation: "delete", errors }
          : { ...common, kind: "group.deleted" },
      );
    } else if (type === "group_participants_add") {
      out.push({
        ...common,
        kind: "group.participants_added",
        participants: people(g.added_participants),
        reason: str(g.reason),
      });
    } else if (type === "group_participants_remove") {
      const by = str(g.initiated_by);
      out.push({
        ...common,
        kind: "group.participants_removed",
        participants: people(g.removed_participants),
        initiatedBy: by === "business" || by === "participant" ? by : null,
        failed: asArray(g.failed_participants).flatMap((f) => {
          const p = participant(f, scope);
          return p ? [{ participant: p, errors: errorsOf(f.errors) }] : [];
        }),
      });
    } else if (type === "group_join_request_created" || type === "group_join_request_revoked") {
      const p = participant(g, scope);
      const requestExternalId = str(g.join_request_id);
      if (!p || !requestExternalId) continue;
      out.push({
        ...common,
        kind: type === "group_join_request_created" ? "group.join_requested" : "group.join_request_withdrawn",
        requestExternalId,
        participant: p,
      });
    } else if (type === "group_suspend") {
      out.push({ ...common, kind: "group.suspended" });
    } else if (type === "group_suspend_cleared") {
      out.push({ ...common, kind: "group.restored" });
    } else if (g.group_subject || g.group_description || g.profile_picture) {
      // Settings results: each section reports success on its own.
      const section = (v: unknown) => asObject(v);
      const subject = section(g.group_subject);
      const description = section(g.group_description);
      const picture = section(g.profile_picture);
      const ok = (x: Json) => Object.keys(x).length > 0 && x.update_successful !== false;
      const sectionErrors = [
        ...errorsOf(subject.errors),
        ...errorsOf(description.errors),
        ...errorsOf(picture.errors),
        ...errors,
      ];
      const changed = {
        ...(ok(subject) && str(subject.text) !== null ? { subject: str(subject.text) as string } : {}),
        ...(ok(description) && str(description.text) !== null
          ? { description: str(description.text) as string }
          : {}),
        ...(ok(picture) ? { iconChanged: true } : {}),
      };
      if (!Object.keys(changed).length && sectionErrors.length) {
        out.push({ ...common, kind: "group.failed", operation: "update", errors: sectionErrors });
      } else {
        out.push({ ...common, kind: "group.updated", ...changed, errors: sectionErrors });
      }
    }
  }
  return out;
}

export function parseWhatsAppWebhook(payload: unknown): NormalizedEvent[] {
  const body = asObject(payload);
  if (body.object !== "whatsapp_business_account") return [];
  const events: NormalizedEvent[] = [];

  for (const entry of asArray(body.entry)) {
    const scope = str(entry.id) ?? "";
    for (const change of asArray(entry.changes)) {
      const field = str(change.field) ?? "";
      const value = asObject(change.value);
      const metadata = asObject(value.metadata);
      const accountExternalId = str(metadata.phone_number_id) ?? "";
      const base = { channel: "whatsapp" as const, accountExternalId };

      if (groupFields.has(field)) {
        events.push(...groupEvents(base, value, scope));
        continue;
      }
      if (field !== "messages") {
        events.push({ ...base, kind: "account.update", field, data: value, errors: errorsOf(value.errors) });
        continue;
      }

      const contacts = asArray(value.contacts);

      for (const msg of asArray(value.messages)) {
        const externalId = str(msg.id) ?? "";
        const at = seconds(msg.timestamp);
        const type = str(msg.type);

        if (type === "system") {
          const s = asObject(msg.system);
          events.push({
            ...base,
            kind: "contact.changed",
            at,
            scope,
            previousExternalId: str(s.previous_user_id) ?? str(msg.from_user_id) ?? str(msg.from),
            newExternalId: str(s.user_id) ?? str(s.wa_id),
            newPhone: str(s.wa_id),
            description: str(s.body),
          });
          continue;
        }

        const from = identity(msg, contacts, scope);
        if (!from) continue;

        if (type === "reaction") {
          const r = asObject(msg.reaction);
          events.push({
            ...base,
            kind: "reaction",
            externalId,
            at,
            from,
            conversation: conversationOf(msg),
            targetExternalId: str(r.message_id) ?? "",
            emoji: str(r.emoji),
          });
          continue;
        }

        events.push({
          ...base,
          kind: "message.received",
          externalId,
          sentAt: at,
          from,
          conversation: conversationOf(msg),
          content: content(msg),
          context: context(msg),
          errors: errorsOf(msg.errors),
        });
      }

      for (const s of asArray(value.statuses)) {
        const status = str(s.status) as DeliveryStatus | null;
        if (!status || !["sent", "delivered", "read", "played", "failed"].includes(status)) continue;
        const pricing = asObject(s.pricing);
        events.push({
          ...base,
          kind: "message.status",
          externalId: str(s.id) ?? "",
          status,
          at: seconds(s.timestamp),
          ourMessageId: str(s.biz_opaque_callback_data),
          recipient:
            str(s.recipient_type) === "group"
              ? {
                  kind: "group",
                  groupExternalId: str(s.recipient_id) ?? "",
                  participant: participant(
                    { user_id: s.recipient_participant_user_id, wa_id: s.recipient_participant_id },
                    scope,
                  ),
                }
              : { kind: "direct", externalId: str(s.recipient_user_id) ?? str(s.recipient_id) },
          errors: errorsOf(s.errors),
          pricing: Object.keys(pricing).length
            ? { category: str(pricing.category), type: str(pricing.type) }
            : null,
        });
      }

      // Top-level errors without messages or statuses (account or app problems).
      if (
        !asArray(value.messages).length &&
        !asArray(value.statuses).length &&
        asArray(value.errors).length
      ) {
        events.push({
          ...base,
          kind: "account.update",
          field: "errors",
          data: value,
          errors: errorsOf(value.errors),
        });
      }
    }
  }
  return events;
}
