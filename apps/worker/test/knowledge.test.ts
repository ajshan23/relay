import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { searchTerms } from "@relay/agent";
import { createDb, eq, schema, searchKnowledge } from "@relay/db";
import { htmlToText, isPrivateAddress, pageText } from "../src/agent/extract";
import { createKnowledgeProcessor } from "../src/agent/knowledge";

/*
 * Knowledge on the local drill database: sources are indexed into pieces, the word search and the
 * meaning search both find them, an edit replaces the old pieces, and a bad web address is refused.
 * The embedder is a fake that turns words into a vector, so nothing is sent anywhere.
 */
const URL = process.env.AUTOMATION_TEST_DATABASE_URL ?? "postgres://relay:relay@localhost:5544/relay_drill";
const { db, sql: pg } = createDb(URL);
const T = Date.now().toString(36);
const org = `org_k${T}`;
const branch = `br_k${T}`;

function fakeVector(text: string): number[] {
  const v = new Array(1536).fill(0);
  for (const w of text
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)) {
    let h = 0;
    for (const ch of w) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 1536;
    v[h] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
let embedCalls = 0;
const embed = async (values: string[]) => {
  embedCalls++;
  return {
    embeddings: values.map(fakeVector),
    tokens: Math.ceil(values.join(" ").length / 4),
    model: "text-embedding-3-small",
  };
};
const storage = { get: async () => new Uint8Array() } as never;
const index = createKnowledgeProcessor({ db, storage, embed });

async function addSource(values: Partial<typeof schema.knowledgeSource.$inferInsert> & { id: string }) {
  await db.insert(schema.knowledgeSource).values({
    organizationId: org,
    branchId: branch,
    kind: "text",
    title: "Note",
    ...values,
  } as typeof schema.knowledgeSource.$inferInsert);
  await index({ data: { sourceId: values.id, revision: 1 } });
  const [row] = await db
    .select()
    .from(schema.knowledgeSource)
    .where(eq(schema.knowledgeSource.id, values.id));
  return row;
}

const search = (query: string, withMeaning = true) =>
  searchKnowledge(db, {
    orgId: org,
    branchId: branch,
    terms: searchTerms(query),
    embedding: withMeaning ? fakeVector(query) : null,
  });

before(async () => {
  await db
    .insert(schema.organization)
    .values({ id: org, name: "K test", slug: `k-${T}`, createdAt: new Date() });
  await db
    .insert(schema.branch)
    .values({ id: branch, organizationId: org, name: "Kochi", slug: "kochi" } as never);
});
after(async () => {
  await db.delete(schema.organization).where(eq(schema.organization.id, org));
  await pg.end();
});

describe("knowledge", () => {
  it("indexes a note and a Q&A pair and finds them by words and by meaning", async () => {
    const note = await addSource({
      id: `ks_n${T}`,
      title: "Timings",
      body: "We are open from 9am to 7pm, Monday to Saturday. Sunday closed.",
    });
    assert.equal(note?.status, "ready");
    assert.equal(note?.chunkCount, 1);
    const qa = await addSource({
      id: `ks_q${T}`,
      kind: "qa",
      title: "Parking",
      qa: { question: "Do you have parking?", answer: "Yes, free parking in the basement." },
    });
    assert.equal(qa?.status, "ready");

    const byWords = await search("parking", false);
    assert.equal(byWords[0]?.title, "Parking");
    assert.match(byWords[0]?.content ?? "", /basement/);
    const hybrid = await search("when are you open on Saturday");
    assert.equal(hybrid[0]?.title, "Timings");
    assert.ok(embedCalls >= 2);
    const usage = await db.select().from(schema.aiUsage).where(eq(schema.aiUsage.organizationId, org));
    assert.ok(usage.length >= 2 && usage.every((u) => u.kind === "embed" && u.credits === 0));
  });

  it("finds Hindi and Arabic text", async () => {
    await addSource({ id: `ks_h${T}`, title: "समय", body: "क्लिनिक सुबह नौ बजे खुलता है।" });
    await addSource({ id: `ks_a${T}`, title: "مواعيد", body: "العيادة مفتوحة من التاسعة صباحا" });
    assert.equal((await search("क्लिनिक कब खुलता है"))[0]?.title, "समय");
    assert.equal((await search("متى العيادة مفتوحة"))[0]?.title, "مواعيد");
  });

  it("replaces the pieces on an edit and ignores a stale job", async () => {
    const id = `ks_e${T}`;
    await addSource({ id, title: "Offer", body: "Ten percent off cleaning this month." });
    await db
      .update(schema.knowledgeSource)
      .set({ body: "Twenty percent off whitening this month.", revision: 2 })
      .where(eq(schema.knowledgeSource.id, id));
    await index({ data: { sourceId: id, revision: 1 } }); // stale: no change
    assert.match(
      (await search("percent off", false)).find((h) => h.title === "Offer")?.content ?? "",
      /Ten percent/,
    );
    await index({ data: { sourceId: id, revision: 2 } });
    const chunks = await db
      .select()
      .from(schema.knowledgeChunk)
      .where(eq(schema.knowledgeChunk.sourceId, id));
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]?.content ?? "", /Twenty percent/);
  });

  it("marks a source failed with a readable reason", async () => {
    const row = await addSource({
      id: `ks_w${T}`,
      kind: "website",
      title: "x",
      url: "http://127.0.0.1:5544/",
    });
    assert.equal(row?.status, "failed");
    assert.match(row?.error ?? "", /public internet/);
    const empty = await addSource({ id: `ks_x${T}`, title: "Empty", body: "   " });
    assert.equal(empty?.status, "failed");
  });
});

describe("web pages", () => {
  it("keeps readable text and drops scripts and navigation", () => {
    const { title, text } = htmlToText(
      `<html><head><title>Lumen &amp; Co</title><style>.x{}</style></head><body><nav>Home | About</nav>
       <h1>Our services</h1><p>Teeth&nbsp;cleaning &#8377;800</p><ul><li>Whitening</li><li>Braces</li></ul>
       <script>alert(1)</script><footer>© 2026</footer></body></html>`,
    );
    assert.equal(title, "Lumen & Co");
    assert.equal(text, "Our services\nTeeth cleaning ₹800\n- Whitening\n- Braces");
  });

  it("refuses private addresses", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "172.20.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      assert.ok(isPrivateAddress(ip), ip);
    assert.ok(!isPrivateAddress("8.8.8.8"));
    await assert.rejects(pageText("http://localhost:5544/"), /public internet/);
    await assert.rejects(pageText("file:///etc/passwd"), /Only web addresses/);
  });
});
