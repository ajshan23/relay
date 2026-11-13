import type { BroadcastStatus } from "./queries";

/** Channel display names, the same as the template samples page. */
export const channelNames: Record<string, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  email: "Email",
  instagram: "Instagram",
  messenger: "Messenger",
  rcs: "RCS",
};

export const statusLabel: Record<BroadcastStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  preparing: "Starting",
  sending: "Sending",
  paused: "Paused",
  completed: "Done",
  stopped: "Stopped",
  failed: "Couldn't start",
};

export const statusTone: Record<BroadcastStatus, "plain" | "primary" | "good" | "warning" | "danger"> = {
  draft: "plain",
  scheduled: "primary",
  preparing: "primary",
  sending: "primary",
  paused: "warning",
  completed: "good",
  stopped: "plain",
  failed: "danger",
};

/** The sidebar's sub-views (?view=) and the statuses each shows. */
export const views: Record<string, { label: string; statuses: BroadcastStatus[] | null }> = {
  all: { label: "All", statuses: null },
  drafts: { label: "Drafts", statuses: ["draft"] },
  scheduled: { label: "Scheduled", statuses: ["scheduled"] },
  sending: { label: "Sending", statuses: ["preparing", "sending", "paused"] },
  done: { label: "Done", statuses: ["completed", "stopped", "failed"] },
};

/** Why a broadcast is paused or stopped, for people. */
export const pauseText: Record<string, string> = {
  manual: "Paused by your team.",
  template_paused:
    "Meta paused the template for low quality. It's usually lifted after 3–6 hours; then resume.",
  template_disabled: "Meta disabled the template. Make a new template and start a new broadcast.",
  template_quality:
    "The template's quality is low (RED). Meta may pause it; check the message before resuming.",
  template_invalid: "The template can't be sent as set up.",
  number_quality: "The number's quality is low. Sending more could get it limited; wait until it recovers.",
  spam_limit: "Meta limited sending because of spam reports.",
  auth: "The channel's access stopped working. Reconnect it, then resume.",
  billing: "Meta reports a payment problem on the WhatsApp account.",
  account: "Meta restricted the account.",
  error_rate: "Too many messages were failing, so sending stopped to protect the number.",
  list_deleted: "A list it used was deleted before it started.",
};

/** Why someone wasn't sent to. */
export const skipText: Record<string, string> = {
  opted_out: "Opted out of marketing",
  no_address: "No phone number",
  missing_value: "A detail was empty",
  contact_deleted: "Contact deleted",
  stopped: "Broadcast stopped",
  unsupported: "Can't be sent on this channel",
};

export const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
