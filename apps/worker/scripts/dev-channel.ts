/*
 * Local development only: connects a FAKE WhatsApp number to a business so simulated webhooks have
 * somewhere to land. Uses the phone number id from the test fixtures and a dummy token.
 *   pnpm --filter @relay/worker dev:channel ["Business name"] [fake phone number id]
 * A second business needs its own fake id (any digits), e.g. 200000000000003; simulate with --phone-id.
 */
import { encryptSecret, env, newId } from "@relay/core";
import { asc, createDb, eq, schema } from "@relay/db";
import { PHONE_ID, WABA } from "../../../packages/channels/test/fixtures";

const config = env();
if (config.NODE_ENV === "production") throw new Error("dev-channel is for local development only");
if (!config.CHANNEL_SECRET_KEY) throw new Error("Set CHANNEL_SECRET_KEY in .env first");

const orgName = process.argv[2] ?? "Lumen Clinics";
const phoneId = process.argv[3] ?? PHONE_ID;
const { db, sql } = createDb(config.DATABASE_URL);

const [org] = await db
  .select()
  .from(schema.organization)
  .where(eq(schema.organization.name, orgName))
  .limit(1);
if (!org) throw new Error(`No business called "${orgName}"`);
const branches = await db
  .select({ id: schema.branch.id, name: schema.branch.name })
  .from(schema.branch)
  .where(eq(schema.branch.organizationId, org.id))
  .orderBy(asc(schema.branch.createdAt));

const [existing] = await db
  .select()
  .from(schema.channelAccount)
  .where(eq(schema.channelAccount.externalId, phoneId))
  .limit(1);
if (existing) {
  console.log(`Fake WhatsApp number already connected: ${existing.id} (${existing.displayName})`);
} else {
  const id = newId("channelAccount");
  await db.insert(schema.channelAccount).values({
    id,
    organizationId: org.id,
    type: "whatsapp",
    provider: "meta",
    externalId: phoneId,
    displayName: `${org.name} (fake)`,
    displayPhone: "+1 555 000 9999",
    credentials: encryptSecret({ accessToken: "fake-token" }, config.CHANNEL_SECRET_KEY),
    providerMeta: { wabaId: WABA, fake: true },
    branchId: branches[0]?.id ?? "",
  });
  console.log(
    `Connected fake WhatsApp number ${phoneId} to ${org.name} as ${id} (branch: ${branches[0]?.name ?? "none"})`,
  );
}
await sql.end();
