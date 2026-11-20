import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

/*
 * Roles and permissions end to end, over HTTP, on the local drill database (never real data). One
 * company, two branches (Marina with numbers n1 and n2, JBR with n3) and these people:
 *   - admin:       Admin in every branch and number
 *   - manager:     Manager in Marina
 *   - limited:     a custom "Own chats" role in Marina, number n1 only (own + unassigned chats, no assign)
 *   - viewer:      Viewer in Marina
 *   - broadcaster: a custom "Broadcaster" role in Marina, number n1 only
 * Run: DATABASE_URL=postgres://relay:relay@localhost:5544/relay_drill npx tsx --env-file=../../.env --test test/access.test.ts
 */
const DRILL = "postgres://relay:relay@localhost:5544/relay_drill";
process.env.DATABASE_URL = process.env.ACCESS_TEST_DATABASE_URL ?? DRILL;
process.env.NODE_ENV = "test";
assert.match(process.env.DATABASE_URL, /localhost|127\.0\.0\.1/, "access tests only run on a local database");

const { newId } = await import("@relay/core");
const { builtInRoles } = await import("@relay/core/permissions");
const { createDb, ensureBuiltInRoles, eq, schema } = await import("@relay/db");
const { createApp } = await import("../src/app");
const { createContext } = await import("../src/context");
const { auth } = await import("../src/modules/auth/auth");

const ctx = createContext();
const app = createApp(ctx);
const { db, sql } = createDb(process.env.DATABASE_URL);
const T = Date.now().toString(36);
const org = `org_ac${T}`;
const marina = `br_m${T}`;
const jbr = `br_j${T}`;
const n1 = `ch_1${T}`;
const n2 = `ch_2${T}`;
const n3 = `ch_3${T}`;
const PASSWORD = "Access-test-1234";
const who = ["owner", "admin", "manager", "limited", "viewer", "broadcaster"] as const;
type Who = (typeof who)[number];
const user: Record<Who, string> = {} as never;
const cookie: Record<Who, string> = {} as never;
const conv: Record<string, string> = {};
const roleId: Record<string, string> = {};

const call = async (as: Who, method: string, path: string, json?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { cookie: cookie[as], ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body };
};

async function signUp(w: Who) {
  const email = `${w}.${T}@access.test`;
  const r = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: `${w} ${T}` } });
  user[w] = r.user.id;
  await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, r.user.id));
  return email;
}

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "Access test", slug: `access-${T}`, createdAt: new Date() });
  await db.insert(schema.branch).values([
    { id: marina, organizationId: org, name: "Marina", slug: `marina-${T}`, timezone: "Asia/Dubai" },
    { id: jbr, organizationId: org, name: "JBR", slug: `jbr-${T}`, timezone: "Asia/Dubai" },
  ]);
  for (const [id, branchId] of [
    [n1, marina],
    [n2, marina],
    [n3, jbr],
  ] as const)
    await db.insert(schema.channelAccount).values({
      id,
      organizationId: org,
      type: "whatsapp",
      provider: "meta",
      externalId: `pn_${id}`,
      displayName: `Number ${id.slice(3, 4)}`,
      credentials: "test",
      status: "active",
      branchId,
      providerMeta: { wabaId: `waba_${T}` },
    });
  const roles = await ensureBuiltInRoles(db, org);
  for (const k of ["admin", "manager", "agent", "viewer"] as const) roleId[k] = roles[k].id;
  roleId.own = newId("role");
  roleId.broadcaster = newId("role");
  await db.insert(schema.role).values([
    {
      id: roleId.own,
      organizationId: org,
      name: "Own chats",
      permissions: ["chats.view", "chats.view_unassigned", "chats.reply", "chats.notes", "contacts.view"],
    },
    {
      id: roleId.broadcaster,
      organizationId: org,
      name: "Broadcaster",
      permissions: ["broadcasts.view", "broadcasts.manage", "broadcasts.send", "contacts.view"],
    },
  ]);
  for (const w of who) {
    const email = await signUp(w);
    await db.insert(schema.member).values({
      id: newId("member"),
      organizationId: org,
      userId: user[w],
      role: w === "owner" ? "owner" : "member",
      createdAt: new Date(),
    });
    const grant = {
      admin: { roleId: roleId.admin, allBranches: true, branchIds: [], allNumbers: true, numberIds: [] },
      manager: {
        roleId: roleId.manager,
        allBranches: false,
        branchIds: [marina],
        allNumbers: true,
        numberIds: [],
      },
      limited: {
        roleId: roleId.own,
        allBranches: false,
        branchIds: [marina],
        allNumbers: false,
        numberIds: [n1],
      },
      viewer: {
        roleId: roleId.viewer,
        allBranches: false,
        branchIds: [marina],
        allNumbers: true,
        numberIds: [],
      },
      broadcaster: {
        roleId: roleId.broadcaster,
        allBranches: false,
        branchIds: [marina],
        allNumbers: false,
        numberIds: [n1],
      },
      owner: null,
    }[w];
    if (grant)
      await db
        .insert(schema.memberGrant)
        .values({ id: newId("memberGrant"), organizationId: org, userId: user[w], ...grant });
    const res = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    cookie[w] = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""])
      .map((c) => c.split(";")[0])
      .join("; ");
  }
  // Chats: Marina n1 unassigned, n1 with the manager, n1 with the limited agent, n2 unassigned; JBR n3.
  const chats: [string, string, string, Who | null][] = [
    ["n1free", marina, n1, null],
    ["n1manager", marina, n1, "manager"],
    ["n1limited", marina, n1, "limited"],
    ["n2free", marina, n2, null],
    ["jbr", jbr, n3, null],
  ];
  for (const [key, branchId, channelId, assignee] of chats) {
    const contactId = newId("contact");
    const identityId = newId("contactIdentity");
    const phone = `9715${Math.floor(Math.random() * 1e8)}`;
    await db
      .insert(schema.contact)
      .values({ id: contactId, organizationId: org, branchId, name: key, phone });
    await db.insert(schema.contactIdentity).values({
      id: identityId,
      organizationId: org,
      contactId,
      branchId,
      channelType: "whatsapp",
      scope: "waba",
      externalId: phone,
    });
    conv[key] = newId("conversation");
    conv[`${key}:contact`] = contactId;
    await db.insert(schema.conversation).values({
      id: conv[key],
      organizationId: org,
      branchId,
      channelAccountId: channelId,
      kind: "direct",
      contactId,
      contactIdentityId: identityId,
      status: "open",
      assignedUserId: assignee ? user[assignee] : null,
      lastMessageAt: new Date(),
    });
  }
  // A template on JBR's number only, and one on Marina's n1.
  for (const [key, channelId] of [
    ["jbrTemplate", n3],
    ["marinaTemplate", n1],
  ] as const) {
    conv[key] = newId("template");
    await db.insert(schema.messageTemplate).values({
      id: conv[key],
      organizationId: org,
      name: key,
      slug: `${key.toLowerCase()}_${T}`,
      purpose: "marketing",
      content: { body: "Hello" },
    });
    await db.insert(schema.templateChannel).values({
      id: newId("templateChannel"),
      organizationId: org,
      templateId: conv[key],
      channelAccountId: channelId,
      scope: `waba_${T}`,
    });
  }
});

after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  for (const w of who) if (user[w]) await db.delete(schema.user).where(eq(schema.user.id, user[w]));
  await sql.end();
  await ctx.redis.quit().catch(() => {});
  process.exit(0);
});

const ids = (body: Record<string, unknown>, key: string) =>
  ((body[key] as { id: string }[] | undefined) ?? []).map((x) => x.id);

describe("roles and permissions", () => {
  it("a person limited to one number and their own chats sees only those", async () => {
    const list = await call("limited", "GET", `/conversations?branch=${marina}&view=open`);
    assert.equal(list.status, 200);
    assert.deepEqual(ids(list.body, "conversations").sort(), [conv.n1free, conv.n1limited].sort());
    const counts = await call("limited", "GET", `/conversations/counts?branch=${marina}`);
    assert.equal(counts.body.open, 2);
    assert.equal(counts.body.partial, true);
    for (const hidden of [conv.n1manager, conv.n2free, conv.jbr])
      assert.equal((await call("limited", "GET", `/conversations/${hidden}`)).status, 404);
    const all = await call("manager", "GET", `/conversations?branch=${marina}&view=open`);
    assert.equal(ids(all.body, "conversations").length, 4, "the manager sees every Marina chat");
    assert.equal((await call("manager", "GET", `/conversations?branch=${jbr}&view=open`)).status, 403);
  });

  it("taking a chat needs reply; giving it to someone else or closing needs assign", async () => {
    const give = await call("limited", "PATCH", `/conversations/${conv.n1free}`, {
      assignedUserId: user.manager,
    });
    assert.equal(give.status, 403);
    const close = await call("limited", "PATCH", `/conversations/${conv.n1free}`, { status: "closed" });
    assert.equal(close.status, 403);
    const take = await call("limited", "PATCH", `/conversations/${conv.n1free}`, {
      assignedUserId: user.limited,
    });
    assert.equal(take.status, 200);
    const viewer = await call("viewer", "PATCH", `/conversations/${conv.n2free}`, {
      assignedUserId: user.viewer,
    });
    assert.equal(viewer.status, 403, "a viewer can't take chats");
  });

  it("only people who can reply on that number can be assigned", async () => {
    const res = await call("manager", "GET", `/conversations/${conv.n2free}/assignees`);
    const people = ids(res.body, "users");
    assert.ok(people.includes(user.manager) && people.includes(user.admin) && people.includes(user.owner));
    assert.ok(!people.includes(user.limited), "limited to n1");
    assert.ok(!people.includes(user.viewer), "viewers can't reply");
    const bad = await call("manager", "PATCH", `/conversations/${conv.n2free}`, {
      assignedUserId: user.limited,
    });
    assert.equal(bad.status, 422);
  });

  it("broadcasts offer only the numbers the person has", async () => {
    const opts = await call("broadcaster", "GET", `/broadcasts/options?branch=${marina}`);
    assert.equal(opts.status, 200);
    assert.deepEqual(ids(opts.body, "channels"), [n1]);
    assert.equal((await call("viewer", "GET", `/broadcasts/options?branch=${marina}`)).body.canManage, false);
    assert.equal(
      (await call("limited", "GET", `/broadcasts?branch=${marina}`)).status,
      403,
      "no broadcasts.view",
    );
  });

  it("templates are scoped by number", async () => {
    const list = await call("manager", "GET", "/templates");
    assert.equal(list.status, 200);
    const seen = ids(list.body, "templates");
    assert.ok(seen.includes(conv.marinaTemplate) && !seen.includes(conv.jbrTemplate));
    assert.equal((await call("manager", "GET", `/templates/${conv.jbrTemplate}`)).status, 404);
    assert.equal((await call("manager", "DELETE", `/templates/${conv.jbrTemplate}`)).status, 403);
    assert.equal((await call("broadcaster", "GET", "/templates")).status, 403);
  });

  it("company-wide actions need a grant on every branch and number", async () => {
    for (const [method, path, json] of [
      ["GET", "/team", undefined],
      ["POST", "/roles", { name: "x", permissions: ["chats.view"] }],
      ["PATCH", `/channels/${n1}`, { settings: { readReceipts: false } }],
      ["POST", "/branches", { name: "New" }],
      ["PUT", "/settings/broadcasts", {}],
    ] as const) {
      assert.equal((await call("manager", method, path, json)).status, 403, `${method} ${path}`);
    }
    assert.equal((await call("admin", "GET", "/team")).status, 200);
    const role = await call("admin", "POST", "/roles", { name: `Reader ${T}`, permissions: ["chats.view"] });
    assert.equal(role.status, 201);
  });

  it("closes the holes found in the audit", async () => {
    // Automations' chat routes only reach chats the person can see.
    assert.equal(
      (await call("manager", "GET", `/automations/chat/${conv.jbr}?branch=${marina}`)).status,
      404,
    );
    // A booking can't use another branch's customer.
    const booking = await call("manager", "POST", `/bookings?branch=${marina}`, {
      variantId: "ctv_none",
      contactId: conv["jbr:contact"],
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    assert.equal(booking.status, 422);
    // Viewers can't add bookings, try the AI agent, or add tags.
    assert.equal(
      (
        await call("viewer", "POST", `/bookings?branch=${marina}`, {
          variantId: "ctv_none",
          contactId: conv["n1free:contact"],
          startsAt: new Date().toISOString(),
        })
      ).status,
      403,
    );
    assert.equal((await call("viewer", "POST", `/agents/agt_none/try?branch=${marina}`, {})).status, 403);
    assert.equal((await call("viewer", "POST", "/tags", { name: "vip" })).status, 403);
    assert.equal((await call("manager", "GET", `/agents/usage?branch=${marina}`)).status, 403);
  });

  it("nobody hands out more than they hold", async () => {
    const asAgent = await call("manager", "PUT", `/branches/${marina}/members/${user.viewer}`, {
      role: "agent",
    });
    assert.equal(asAgent.status, 200);
    const asAdmin = await call("manager", "PUT", `/branches/${marina}/members/${user.viewer}`, {
      role: "admin",
    });
    assert.equal(asAdmin.status, 403, "Admin includes more than a manager has");
    const otherBranch = await call("manager", "PUT", `/branches/${jbr}/members/${user.viewer}`, {
      role: "agent",
    });
    assert.equal(otherBranch.status, 404);
    const self = await call("manager", "PUT", `/branches/${marina}/members/${user.manager}`, {
      role: "admin",
    });
    assert.equal(self.status, 409);
    // The admin can give the limited agent a second role elsewhere; it keeps the first one apart.
    const two = await call("admin", "PUT", `/team/${user.limited}/access`, {
      grants: [
        { roleId: roleId.own, branchIds: [marina], allNumbers: false, numberIds: [n1] },
        { roleId: roleId.viewer, branchIds: [jbr] },
      ],
    });
    assert.equal(two.status, 200);
    const jbrChats = await call("limited", "GET", `/conversations?branch=${jbr}&view=open`);
    assert.deepEqual(ids(jbrChats.body, "conversations"), [conv.jbr]);
    const reply = await call("limited", "PATCH", `/conversations/${conv.jbr}`, {
      assignedUserId: user.limited,
    });
    assert.equal(reply.status, 403, "viewer in JBR: reply from the Marina grant doesn't carry over");
    const numbersOutside = await call("admin", "PUT", `/team/${user.limited}/access`, {
      grants: [{ roleId: roleId.own, branchIds: [jbr], allNumbers: false, numberIds: [n1] }],
    });
    assert.equal(numbersOutside.status, 422, "numbers must sit in the chosen branches");
  });

  it("built-in roles match what the old roles allowed", () => {
    assert.ok(builtInRoles.admin.permissions.length > builtInRoles.manager.permissions.length);
  });
});
