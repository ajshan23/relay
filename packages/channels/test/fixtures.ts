/*
 * WhatsApp webhook payloads in the documented shapes (see META_WHATSAPP_WEBHOOK_PAYLOADS.md in the
 * FlowFlex folder and research/01-whatsapp-cloud-api.md). Every id, number and name is fake.
 */

export const WABA = "100000000000001";
export const PHONE_ID = "200000000000002";
export const CUSTOMER = "15550001111";
export const CUSTOMER_BSUID = "US.1349000000000001";

type Json = Record<string, unknown>;

export function envelope(value: Json, field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field,
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550009999", phone_number_id: PHONE_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export const contacts = [{ profile: { name: "Hana Test" }, wa_id: CUSTOMER, user_id: CUSTOMER_BSUID }];

export function incoming(message: Json, extra: Json = {}) {
  return envelope({
    contacts,
    messages: [
      {
        from: CUSTOMER,
        from_user_id: CUSTOMER_BSUID,
        id: `wamid.${message.type}`,
        timestamp: "1789380000",
        ...message,
      },
    ],
    ...extra,
  });
}

const mediaFields = {
  id: "MEDIA_1",
  mime_type: "image/jpeg",
  sha256: "HASH",
  url: "https://lookaside.example/media",
};

export const messages: Record<string, Json> = {
  text: { type: "text", text: { body: "Hi, can I book a cleaning?" } },
  image: { type: "image", image: { ...mediaFields, caption: "my x-ray" } },
  video: { type: "video", video: { ...mediaFields, mime_type: "video/mp4" } },
  audio: { type: "audio", audio: { ...mediaFields, mime_type: "audio/ogg", voice: true } },
  document: {
    type: "document",
    document: { ...mediaFields, mime_type: "application/pdf", filename: "invoice.pdf", caption: "here" },
  },
  sticker: { type: "sticker", sticker: { ...mediaFields, mime_type: "image/webp", animated: true } },
  location: {
    type: "location",
    location: { latitude: 25.08, longitude: 55.14, name: "Marina", address: "Dubai" },
  },
  contacts: {
    type: "contacts",
    contacts: [{ name: { formatted_name: "Omar" }, phones: [{ phone: "+15550002222" }] }],
  },
  button: {
    type: "button",
    button: { payload: "ACTION_CONFIRM", text: "Confirm" },
    context: { id: "wamid.template" },
  },
  button_reply: {
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "confirm", title: "Confirm" } },
  },
  list_reply: {
    type: "interactive",
    interactive: {
      type: "list_reply",
      list_reply: { id: "delivery", title: "Delivery", description: "Send to my address" },
    },
  },
  nfm_reply: {
    type: "interactive",
    interactive: {
      type: "nfm_reply",
      nfm_reply: { name: "flow", body: "Sent", response_json: '{"flow_token":"T1","delivery":"home"}' },
    },
  },
  order: {
    type: "order",
    order: {
      catalog_id: "CAT1",
      text: "please",
      product_items: [{ product_retailer_id: "SKU1", quantity: 2, item_price: 7.99, currency: "AED" }],
    },
  },
  unsupported: {
    type: "unsupported",
    unsupported: { type: "edit" },
    errors: [{ code: 131051, title: "Message type unknown" }],
  },
};

export function status(s: Json) {
  return envelope({
    statuses: [
      {
        id: "wamid.out1",
        recipient_id: CUSTOMER,
        recipient_user_id: CUSTOMER_BSUID,
        timestamp: "1789380100",
        ...s,
      },
    ],
  });
}
