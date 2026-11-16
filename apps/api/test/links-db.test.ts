import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDb, eq, schema } from "@relay/db";
import { createKairos } from "@relay/kairos";
import type { AppContext } from "../src/context";
import { linkRoutes } from "../src/modules/automations/links";

/*
 * GET /l/<code> on a throwaway database (the local drill DB, never Relay's real data): a tap counts and
 * forwards, a link preview or HEAD forwards without counting, an unknown code says the link is gone.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql } = createDb(URL);
const kairos = createKairos({ sql, schema: "kairos", log: () => {} });
const app = linkRoutes({ db, kairos } as unknown as AppContext);

const T = Date.now().toString(36);
const org = `org_l${T}`;
const code = `code${T}xyz`;
const phone =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

before(async () => {
  await kairos.migrate();
  await db
    .insert(schema.organization)
    .values({ id: org, name: "Link test", slug: `link-t${T}`, createdAt: new Date() });
  await db.insert(schema.trackedLink).values({
    id: `lnk_${T}`,
    code,
    organizationId: org,
    runId: `run_${T}`,
    stepKey: `run_${T}:link#1`,
    url: "https://example.com/book?x=1",
  });
});

after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await sql.end();
});

const tapCount = async () =>
  (await db.select().from(schema.trackedLink).where(eq(schema.trackedLink.code, code)))[0]?.tapCount;

describe("GET /l/<code>", () => {
  it("forwards a preview fetch and a HEAD without counting them", async () => {
    const preview = await app.request(`/${code}`, { headers: { "user-agent": "WhatsApp/2.24.1 A" } });
    assert.equal(preview.status, 302);
    assert.equal(preview.headers.get("location"), "https://example.com/book?x=1");
    const head = await app.request(`/${code}`, { method: "HEAD", headers: { "user-agent": phone } });
    assert.equal(head.status, 302);
    assert.equal(await tapCount(), 0);
  });
  it("counts a tap from a phone, publishes the first one once, and forwards", async () => {
    const res = await app.request(`/${code}`, { headers: { "user-agent": phone } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.com/book?x=1");
    assert.equal(res.headers.get("cache-control"), "no-store");
    await app.request(`/${code}`, { headers: { "user-agent": phone } });
    assert.equal(await tapCount(), 2);
    const events =
      await sql`select count(*)::int as n from kairos.event where tenant_id = ${org} and key = 'link.tapped'`;
    assert.equal(events[0]?.n, 1);
  });
  it("says a link it doesn't know no longer works", async () => {
    const res = await app.request("/nosuchcode1", { headers: { "user-agent": phone } });
    assert.equal(res.status, 404);
    assert.match(await res.text(), /doesn't work any more/);
  });
});
