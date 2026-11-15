/*
 * Names shared by the API (which starts and stops runs) and the worker (which runs them on Kairos).
 * Bump a version only together with keeping the old handler registered until its runs drain.
 */

export const automationWorkflows = {
  /** One per inbound event, serial per chat: hands a reply to the waiting run, or starts an automation. */
  router: { name: "relay.route", version: 1 },
  /** One per automation run: walks the pinned version's steps. */
  run: { name: "relay.automation", version: 1 },
} as const;

/** Kairos event keys. */
export const automationEvents = {
  messageReceived: "message.received",
} as const;

/** What an automation run starts with. */
export type AutomationRunInput = {
  automationId: string;
  versionId: string;
  organizationId: string;
  branchId: string;
  channelAccountId: string;
  conversationId: string;
  contactId: string;
  trigger: {
    /** "button": the customer tapped a button from an earlier run of this automation (see startAt). */
    kind: "message" | "tag" | "manual" | "button";
    messageId?: string;
    text?: string;
    adId?: string | null;
    tagId?: string;
    startedByUserId?: string;
  };
  /**
   * Show "typing…" and pause before each message (the rule, frozen when the run starts). Runs that
   * started before this existed don't have it, so their recorded steps replay unchanged.
   */
  typing?: boolean;
  /**
   * A tap on an older button of this automation (still on the customer's screen) jumps to that
   * choice. Frozen at start like `typing`, so runs from before this replay unchanged.
   */
  followTaps?: boolean;
  /** Start at this choice's exit instead of the trigger (a tap on a button from an ended run). */
  startAt?: { node: string; handle: string; value: string; saveAs?: string };
};

/**
 * How long "typing…" shows before a message: about as long as a quick typist takes, between 1.2 s
 * and 4 s. Photos and files without a caption take 1.5 s.
 */
export function typingPauseMs(text: string): number {
  const n = text.trim().length;
  if (!n) return 1_500;
  return Math.round(Math.min(4_000, Math.max(1_200, 800 + n * 30)));
}

/** Labels on every automation run (searchable in Kairos and by the API). */
export type AutomationRunLabels = {
  automationId: string;
  versionId: string;
  contactId: string;
  conversationId: string;
  stopOnAgentReply: boolean;
  stopOnOptOut: boolean;
  test?: boolean;
};

/** The payload of a message.received event. */
export type InboundEventPayload = {
  messageId: string;
  organizationId: string;
  branchId: string | null;
  channelAccountId: string;
  conversationId: string;
  contactId: string;
  type: string;
  text: string;
  /** A tap on one of our reply buttons or list rows. */
  reply: { id: string; title: string } | null;
  adId: string | null;
  optOut: "stop" | "start" | null;
};
