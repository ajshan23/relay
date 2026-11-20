/*
 * Who may do what. A company makes roles out of the permissions below; a person gets a role through
 * a grant that also says which branches and which numbers it covers. Every check in the API asks
 * `can()`, so the rules live here and nowhere else.
 *
 * The grant rule (as in FlowFlex): a permission counts only inside the branches and numbers of the
 * same grant. Permission from one grant and reach from another are never mixed.
 *
 * Company-wide actions (numbers, team, roles, branches create/delete, company settings, contact
 * fields...) need the permission from a grant that covers every branch and every number.
 */

export const permissionGroups = [
  {
    id: "chats",
    label: "Chats",
    permissions: [
      { key: "chats.view", label: "See chats assigned to them" },
      { key: "chats.view_unassigned", label: "See unassigned chats" },
      { key: "chats.view_all", label: "See every chat" },
      { key: "chats.reply", label: "Reply, react and take a chat" },
      { key: "chats.assign", label: "Assign chats to others, close and snooze" },
      { key: "chats.start", label: "Start new chats" },
      { key: "chats.notes", label: "Write internal notes" },
    ],
  },
  {
    id: "contacts",
    label: "Contacts",
    permissions: [
      { key: "contacts.view", label: "See contacts and lists" },
      { key: "contacts.edit", label: "Add and change contacts and lists" },
      { key: "contacts.delete", label: "Delete contacts" },
      { key: "contacts.import", label: "Import contacts" },
      { key: "contacts.export", label: "Export contacts" },
      { key: "contacts.fields", label: "Manage fields, tags and shared views", company: true },
    ],
  },
  {
    id: "broadcasts",
    label: "Broadcasts",
    permissions: [
      { key: "broadcasts.view", label: "See broadcasts and results" },
      { key: "broadcasts.manage", label: "Create and change broadcasts" },
      { key: "broadcasts.send", label: "Start, pause, stop and test broadcasts" },
      { key: "broadcasts.export", label: "Export broadcast results" },
    ],
  },
  {
    id: "templates",
    label: "Templates",
    permissions: [
      { key: "templates.view", label: "See templates" },
      { key: "templates.manage", label: "Add, change and submit templates" },
    ],
  },
  {
    id: "automations",
    label: "Automations",
    permissions: [
      { key: "automations.view", label: "See automations and runs" },
      { key: "automations.manage", label: "Build and change automations" },
      { key: "automations.publish", label: "Publish, pause and stop automations" },
      { key: "automations.run", label: "Start or stop an automation in a chat" },
    ],
  },
  {
    id: "agent",
    label: "AI agent",
    permissions: [
      { key: "agent.view", label: "See the AI agent" },
      { key: "agent.manage", label: "Teach and change the AI agent" },
      { key: "agent.try", label: "Try the AI agent" },
    ],
  },
  {
    id: "catalogue",
    label: "Catalogue",
    permissions: [
      { key: "catalogue.view", label: "See the catalogue" },
      { key: "catalogue.manage", label: "Add and change items" },
      { key: "catalogue.types", label: "Manage catalogue types and fields", company: true },
    ],
  },
  {
    id: "bookings",
    label: "Bookings",
    permissions: [
      { key: "bookings.view", label: "See bookings" },
      { key: "bookings.manage", label: "Add, move and cancel bookings" },
      { key: "bookings.settings", label: "Change booking hours, reminders and calendars" },
    ],
  },
  {
    id: "extras",
    label: "Quick replies and groups",
    permissions: [
      { key: "quick_replies.manage", label: "Add and change quick replies" },
      { key: "groups.view", label: "See groups" },
      { key: "groups.manage", label: "Create and run groups" },
    ],
  },
  {
    id: "branches",
    label: "Branch",
    permissions: [
      { key: "branches.edit", label: "Rename the branch" },
      { key: "branches.people", label: "Add and change people in the branch" },
      { key: "branches.create", label: "Add branches", company: true },
      { key: "branches.delete", label: "Close branches", company: true },
    ],
  },
  {
    id: "numbers",
    label: "Numbers",
    permissions: [
      { key: "numbers.view", label: "See numbers and their health" },
      { key: "numbers.manage", label: "Connect, change and disconnect numbers", company: true },
    ],
  },
  {
    id: "team",
    label: "Team",
    permissions: [
      { key: "team.view", label: "See the team and roles", company: true },
      { key: "team.invite", label: "Invite people", company: true },
      { key: "team.edit_access", label: "Change anyone's access", company: true },
      { key: "team.remove", label: "Remove people", company: true },
      { key: "roles.manage", label: "Create and change roles", company: true },
    ],
  },
  {
    id: "company",
    label: "Company",
    permissions: [
      { key: "settings.manage", label: "Change company settings", company: true },
      { key: "usage.view", label: "See AI usage and storage", company: true },
    ],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  permissions: readonly { key: string; label: string; company?: boolean }[];
}[];

export type Permission = (typeof permissionGroups)[number]["permissions"][number]["key"];

export const allPermissions: Permission[] = permissionGroups.flatMap((g) => g.permissions.map((p) => p.key));
const known = new Set<string>(allPermissions);
export const isPermission = (p: string): p is Permission => known.has(p);

/** Permissions that only mean something across the whole company. */
export const companyPermissions = new Set<Permission>(
  permissionGroups.flatMap((g) =>
    g.permissions.filter((p) => "company" in p && p.company).map((p) => p.key as Permission),
  ),
);

const labels = new Map<string, string>(
  permissionGroups.flatMap((g) => g.permissions.map((x): [string, string] => [x.key, x.label])),
);
export const permissionLabel = (p: Permission) => labels.get(p) ?? p;

// ---------------------------------------------------------------------------------------------
// Built-in roles. Their permissions live here (not in the database), so a new permission reaches
// Admin without a migration. They match what owner/admin and manager/agent/viewer allowed before.

export const builtInRoleKeys = ["admin", "manager", "agent", "viewer"] as const;
export type BuiltInRole = (typeof builtInRoleKeys)[number];

const views: Permission[] = [
  "chats.view",
  "chats.view_unassigned",
  "chats.view_all",
  "contacts.view",
  "broadcasts.view",
  "templates.view",
  "automations.view",
  "agent.view",
  "catalogue.view",
  "bookings.view",
  "groups.view",
  "numbers.view",
];

const agentPermissions: Permission[] = [
  ...views,
  "chats.reply",
  "chats.assign",
  "chats.start",
  "chats.notes",
  "contacts.edit",
  "contacts.import",
  "contacts.export",
  "broadcasts.export",
  "automations.run",
  "bookings.manage",
  "quick_replies.manage",
];

const managerPermissions: Permission[] = [
  ...agentPermissions,
  "broadcasts.manage",
  "broadcasts.send",
  "templates.manage",
  "automations.manage",
  "automations.publish",
  "agent.manage",
  "agent.try",
  "catalogue.manage",
  "bookings.settings",
  "groups.manage",
  "branches.edit",
  "branches.people",
];

export const builtInRoles: Record<
  BuiltInRole,
  { name: string; description: string; permissions: Permission[] }
> = {
  admin: {
    name: "Admin",
    description: "Everything, in every branch: numbers, team, roles and company settings.",
    permissions: allPermissions,
  },
  manager: {
    name: "Manager",
    description:
      "Runs a branch: chats, broadcasts, automations, AI agent, catalogue, bookings and its people.",
    permissions: managerPermissions,
  },
  agent: {
    name: "Agent",
    description: "Works the chats: reply, assign, notes, contacts, bookings and quick replies.",
    permissions: agentPermissions,
  },
  viewer: {
    name: "Viewer",
    description: "Can look at everything in the branch but not change or send anything.",
    permissions: [...views, "contacts.export"],
  },
};

// ---------------------------------------------------------------------------------------------
// Access: what a person holds in the active company.

export type Grant = {
  id: string;
  roleId: string;
  roleName: string;
  permissions: ReadonlySet<Permission>;
  /** Every branch, including ones added later. */
  allBranches: boolean;
  branchIds: ReadonlySet<string>;
  /** Every number in those branches, including ones added later. */
  allNumbers: boolean;
  numberIds: ReadonlySet<string>;
};

export type Access = {
  orgId: string;
  userId: string;
  /** The company owner can always do everything. */
  owner: boolean;
  grants: readonly Grant[];
};

/** Where an action happens. No branch: a company-wide action. */
export type Place = { branchId?: string | null; channelId?: string | null };

const coversBranch = (g: Grant, branchId: string) => g.allBranches || g.branchIds.has(branchId);
const coversNumber = (g: Grant, channelId: string) => g.allNumbers || g.numberIds.has(channelId);
const companyWide = (g: Grant) => g.allBranches && g.allNumbers;

function grantAllows(g: Grant, perm: Permission, place: Place) {
  if (!g.permissions.has(perm)) return false;
  if (companyPermissions.has(perm) || !place.branchId) return companyWide(g);
  if (!coversBranch(g, place.branchId)) return false;
  return !place.channelId || coversNumber(g, place.channelId);
}

/** May this person do `perm` here? A company-wide permission ignores the place. */
export function can(a: Access, perm: Permission, place: Place = {}): boolean {
  if (a.owner) return true;
  return a.grants.some((g) => grantAllows(g, perm, place));
}

/** True when they hold `perm` in at least one branch (for showing a menu item, say). */
export function canAnywhere(a: Access, perm: Permission): boolean {
  if (a.owner) return true;
  return a.grants.some((g) => g.permissions.has(perm) && (!companyPermissions.has(perm) || companyWide(g)));
}

/** The branches where they hold `perm`: "all", or a set (maybe empty). */
export function branchesFor(a: Access, perm: Permission): "all" | Set<string> {
  if (a.owner) return "all";
  const out = new Set<string>();
  for (const g of a.grants) {
    if (!g.permissions.has(perm)) continue;
    if (g.allBranches) return "all";
    for (const b of g.branchIds) out.add(b);
  }
  return out;
}

/** Branches they can reach at all (any grant covers them). */
export function reachableBranchIds(a: Access): "all" | Set<string> {
  if (a.owner || a.grants.some((g) => g.allBranches)) return "all";
  return new Set(a.grants.flatMap((g) => [...g.branchIds]));
}

/** The numbers of a branch where they hold `perm`: "all" or a set (maybe empty). */
export function numbersFor(a: Access, perm: Permission, branchId: string): "all" | Set<string> {
  if (a.owner) return "all";
  const out = new Set<string>();
  for (const g of a.grants) {
    if (!g.permissions.has(perm) || !coversBranch(g, branchId)) continue;
    if (g.allNumbers) return "all";
    for (const n of g.numberIds) out.add(n);
  }
  return out;
}

/** Which chats they may see in a branch: one entry per grant that lets them see any. */
export type ChatScope = { numbers: "all" | ReadonlySet<string>; see: "all" | "unassigned" | "own" };

export function chatScopes(a: Access, branchId: string): ChatScope[] {
  if (a.owner) return [{ numbers: "all", see: "all" }];
  const out: ChatScope[] = [];
  for (const g of a.grants) {
    if (!coversBranch(g, branchId)) continue;
    const p = g.permissions;
    const see = p.has("chats.view_all")
      ? "all"
      : p.has("chats.view_unassigned")
        ? "unassigned"
        : p.has("chats.view")
          ? "own"
          : null;
    if (see) out.push({ numbers: g.allNumbers ? "all" : g.numberIds, see });
  }
  return out;
}

/** May they see this chat? (The same rule as the SQL filter, for live updates.) */
export function canSeeChat(
  a: Access,
  chat: { branchId: string | null; channelId: string; assignedUserId: string | null },
): boolean {
  if (a.owner) return true;
  if (!chat.branchId) return a.grants.some((g) => companyWide(g) && g.permissions.has("chats.view_all"));
  return chatScopes(a, chat.branchId).some(
    (s) =>
      (s.numbers === "all" || s.numbers.has(chat.channelId)) &&
      (s.see === "all" ||
        chat.assignedUserId === a.userId ||
        (s.see === "unassigned" && chat.assignedUserId === null)),
  );
}

/**
 * Can `a` hand out a grant with these permissions and this reach? Only what they hold themselves,
 * in every branch and number the grant covers, so nobody can give more than they have.
 */
export function canGrant(
  a: Access,
  grant: {
    permissions: Iterable<Permission>;
    allBranches: boolean;
    branchIds: Iterable<string>;
    allNumbers: boolean;
    numberIds: Iterable<string>;
  },
): boolean {
  if (a.owner) return true;
  const perms = [...grant.permissions];
  if (grant.allBranches || perms.some((p) => companyPermissions.has(p)))
    return can(a, "team.edit_access") && perms.every((p) => can(a, p));
  const branches = [...grant.branchIds];
  if (branches.length === 0) return false;
  const numbers = [...grant.numberIds];
  return branches.every((b) => {
    if (!can(a, "branches.people", { branchId: b }) && !can(a, "team.edit_access")) return false;
    return perms.every((p) => {
      const mine = numbersFor(a, p, b);
      if (mine === "all") return true;
      // Their own reach in this branch is limited: they can only pass on those numbers.
      return !grant.allNumbers && numbers.every((n) => mine.has(n));
    });
  });
}

/** Owner access, for the worker and tests. */
export const ownerAccess = (orgId: string, userId: string): Access => ({
  orgId,
  userId,
  owner: true,
  grants: [],
});
