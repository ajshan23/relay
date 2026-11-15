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
    kind: "message" | "tag" | "manual";
    messageId?: string;
    text?: string;
    adId?: string | null;
    tagId?: string;
    startedByUserId?: string;
  };
};

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
