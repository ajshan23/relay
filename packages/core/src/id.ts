import { ulid } from "ulid";

/** Entity prefixes. Every row ID is `<prefix>_<ulid>`: readable in logs and sortable by creation time. */
export const idPrefixes = {
  organization: "org",
  branch: "br",
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  member: "mem",
  invitation: "inv",
  branchMember: "brm",
  channelAccount: "ch",
  contact: "ct",
  contactIdentity: "cid",
  conversation: "conv",
  message: "msg",
  attachment: "att",
  webhookEvent: "whe",
  outbox: "out",
  email: "eml",
  group: "grp",
  groupParticipant: "gpt",
  groupJoinRequest: "gjr",
  receipt: "rcp",
  template: "tpl",
  templateChannel: "tpc",
} as const;

export type IdKind = keyof typeof idPrefixes;

export function newId(kind: IdKind): string {
  return `${idPrefixes[kind]}_${ulid().toLowerCase()}`;
}
