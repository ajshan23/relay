ALTER TABLE "contact" ADD COLUMN "phone" text;--> statement-breakpoint
CREATE INDEX "contact_org_phone_idx" ON "contact" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX "contact_phone_trgm" ON "contact" USING gin ("phone" gin_trgm_ops);--> statement-breakpoint
UPDATE "contact" c SET "phone" = i."phone"
FROM (SELECT DISTINCT ON ("contact_id") "contact_id", "phone" FROM "contact_identity" WHERE "phone" IS NOT NULL ORDER BY "contact_id", "created_at") i
WHERE i."contact_id" = c."id" AND c."phone" IS NULL;
