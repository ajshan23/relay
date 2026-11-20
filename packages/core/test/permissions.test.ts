import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Access,
  allPermissions,
  branchesFor,
  builtInRoles,
  can,
  canAnywhere,
  canGrant,
  canSeeChat,
  chatScopes,
  type Grant,
  numbersFor,
  type Permission,
  reachableBranchIds,
} from "../src/permissions";

const grant = (
  perms: Permission[],
  reach: { branches?: string[] | "all"; numbers?: string[] | "all" } = {},
): Grant => ({
  id: `g${Math.random()}`,
  roleId: "r",
  roleName: "Test",
  permissions: new Set(perms),
  allBranches: reach.branches === "all" || reach.branches === undefined,
  branchIds: new Set(Array.isArray(reach.branches) ? reach.branches : []),
  allNumbers: reach.numbers === "all" || reach.numbers === undefined,
  numberIds: new Set(Array.isArray(reach.numbers) ? reach.numbers : []),
});
const person = (...grants: Grant[]): Access => ({ orgId: "o", userId: "me", owner: false, grants });

describe("permissions", () => {
  it("the owner can do everything", () => {
    const owner: Access = { orgId: "o", userId: "me", owner: true, grants: [] };
    assert.ok(allPermissions.every((p) => can(owner, p, { branchId: "x" }) && can(owner, p)));
  });

  it("a permission counts only inside its own grant's branches and numbers", () => {
    // Replies on number n1 in Marina, but only looks (no reply) on n2.
    const a = person(
      grant(["chats.reply"], { branches: ["marina"], numbers: ["n1"] }),
      grant(["chats.view_all"], { branches: ["marina"], numbers: ["n2"] }),
    );
    assert.ok(can(a, "chats.reply", { branchId: "marina", channelId: "n1" }));
    assert.ok(!can(a, "chats.reply", { branchId: "marina", channelId: "n2" }));
    assert.ok(!can(a, "chats.reply", { branchId: "jbr" }));
    assert.deepEqual(numbersFor(a, "chats.reply", "marina"), new Set(["n1"]));
  });

  it("company-wide actions need a grant covering every branch and number", () => {
    const branchAdmin = person(grant(builtInRoles.admin.permissions, { branches: ["marina"] }));
    assert.ok(!can(branchAdmin, "numbers.manage"));
    assert.ok(!can(branchAdmin, "contacts.fields", { branchId: "marina" }));
    assert.ok(can(branchAdmin, "contacts.delete", { branchId: "marina" }));
    const admin = person(grant(builtInRoles.admin.permissions));
    assert.ok(can(admin, "numbers.manage") && can(admin, "contacts.fields") && can(admin, "team.invite"));
    assert.ok(!canAnywhere(branchAdmin, "team.view"));
  });

  it('"all branches" and "all numbers" include ones added later', () => {
    const a = person(grant(["chats.view_all"]));
    assert.ok(can(a, "chats.view_all", { branchId: "brand-new", channelId: "new-number" }));
    assert.equal(branchesFor(a, "chats.view_all"), "all");
    assert.equal(reachableBranchIds(a), "all");
  });

  it("chat visibility: all, mine + unassigned, or mine only, per number", () => {
    const a = person(
      grant(["chats.view"], { branches: ["marina"], numbers: ["n1"] }),
      grant(["chats.view_unassigned"], { branches: ["marina"], numbers: ["n2"] }),
    );
    const chat = (channelId: string, assignedUserId: string | null) => ({
      branchId: "marina",
      channelId,
      assignedUserId,
    });
    assert.ok(canSeeChat(a, chat("n1", "me")));
    assert.ok(!canSeeChat(a, chat("n1", null)));
    assert.ok(canSeeChat(a, chat("n2", null)));
    assert.ok(!canSeeChat(a, chat("n2", "someone")));
    assert.ok(!canSeeChat(a, chat("n3", "me")), "not their number");
    assert.ok(!canSeeChat(a, { branchId: "jbr", channelId: "n1", assignedUserId: "me" }));
    assert.equal(chatScopes(a, "marina").length, 2);
  });

  it("built-in roles keep what manager, agent and viewer could do before", () => {
    const at = { branchId: "marina", channelId: "n1" };
    const as = (role: keyof typeof builtInRoles) =>
      person(grant(builtInRoles[role].permissions, { branches: ["marina"] }));
    const viewer = as("viewer");
    assert.ok(can(viewer, "chats.view_all", at) && !can(viewer, "chats.reply", at));
    assert.ok(!can(viewer, "contacts.edit", at) && !can(viewer, "bookings.manage", at));
    const agent = as("agent");
    assert.ok(
      can(agent, "chats.reply", at) && can(agent, "chats.assign", at) && can(agent, "contacts.edit", at),
    );
    assert.ok(!can(agent, "broadcasts.manage", at) && !can(agent, "automations.manage", at));
    const manager = as("manager");
    assert.ok(
      can(manager, "broadcasts.send", at) &&
        can(manager, "agent.manage", at) &&
        can(manager, "branches.people", at),
    );
    assert.ok(!can(manager, "contacts.delete", at), "deleting contacts stays with admins");
    assert.ok(!can(manager, "numbers.manage") && !can(manager, "team.invite"));
  });

  it("nobody can hand out more than they hold", () => {
    const manager = person(grant(builtInRoles.manager.permissions, { branches: ["marina"] }));
    const agentGrant = {
      permissions: builtInRoles.agent.permissions,
      allBranches: false,
      branchIds: ["marina"],
      allNumbers: true,
      numberIds: [],
    };
    assert.ok(canGrant(manager, agentGrant));
    assert.ok(!canGrant(manager, { ...agentGrant, branchIds: ["jbr"] }), "not their branch");
    assert.ok(
      !canGrant(manager, { ...agentGrant, permissions: builtInRoles.admin.permissions }),
      "more than they hold",
    );
    assert.ok(!canGrant(manager, { ...agentGrant, allBranches: true }), "company-wide needs team access");
    const limited = person(
      grant(builtInRoles.manager.permissions, { branches: ["marina"], numbers: ["n1"] }),
    );
    assert.ok(!canGrant(limited, agentGrant), "can't give all numbers when limited to one");
    assert.ok(canGrant(limited, { ...agentGrant, allNumbers: false, numberIds: ["n1"] }));
  });
});
