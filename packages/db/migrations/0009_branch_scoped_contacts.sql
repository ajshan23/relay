-- Contacts belong to one branch (the same person in two branches is two contacts). Lists, saved views
-- and imports belong to the branch they were made in. Anything without a branch moves to the
-- business's first active branch.
CREATE TEMP TABLE first_branch ON COMMIT DROP AS
SELECT DISTINCT ON (organization_id) organization_id, id AS branch_id
FROM "branch"
ORDER BY organization_id, (archived_at IS NOT NULL), created_at;--> statement-breakpoint

UPDATE "channel_account" a SET "default_branch_id" = f.branch_id
FROM first_branch f WHERE a.organization_id = f.organization_id AND a.default_branch_id IS NULL;--> statement-breakpoint
UPDATE "conversation" c SET "branch_id" = coalesce(a.default_branch_id, f.branch_id)
FROM "channel_account" a, first_branch f
WHERE a.id = c.channel_account_id AND f.organization_id = c.organization_id AND c.branch_id IS NULL;--> statement-breakpoint
UPDATE "contact" c SET "branch_id" = coalesce(
  (SELECT cv.branch_id FROM "conversation" cv WHERE cv.contact_id = c.id ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1),
  f.branch_id)
FROM first_branch f WHERE f.organization_id = c.organization_id AND c.branch_id IS NULL;--> statement-breakpoint

ALTER TABLE "contact" DROP CONSTRAINT "contact_branch_id_branch_id_fk";--> statement-breakpoint
ALTER TABLE "contact" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "contact_identity" ADD COLUMN "branch_id" text;--> statement-breakpoint
UPDATE "contact_identity" i SET "branch_id" = c.branch_id FROM "contact" c WHERE c.id = i.contact_id;--> statement-breakpoint
ALTER TABLE "contact_identity" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_identity" ADD CONSTRAINT "contact_identity_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "contact_identity_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "contact_identity_uidx" ON "contact_identity" USING btree ("organization_id","branch_id","channel_type","scope","external_id");--> statement-breakpoint

ALTER TABLE "contact_list" ADD COLUMN "branch_id" text;--> statement-breakpoint
UPDATE "contact_list" l SET "branch_id" = f.branch_id FROM first_branch f WHERE f.organization_id = l.organization_id;--> statement-breakpoint
ALTER TABLE "contact_list" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_list" ADD CONSTRAINT "contact_list_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "contact_list_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "contact_list_name_uidx" ON "contact_list" USING btree ("branch_id",lower("name"));--> statement-breakpoint

ALTER TABLE "contact_view" ADD COLUMN "branch_id" text;--> statement-breakpoint
UPDATE "contact_view" v SET "branch_id" = f.branch_id FROM first_branch f WHERE f.organization_id = v.organization_id;--> statement-breakpoint
ALTER TABLE "contact_view" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_view" ADD CONSTRAINT "contact_view_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "contact_view_org_idx";--> statement-breakpoint
CREATE INDEX "contact_view_branch_idx" ON "contact_view" USING btree ("branch_id","owner_user_id");--> statement-breakpoint

ALTER TABLE "contact_import" ADD COLUMN "branch_id" text;--> statement-breakpoint
UPDATE "contact_import" m SET "branch_id" = f.branch_id FROM first_branch f WHERE f.organization_id = m.organization_id;--> statement-breakpoint
ALTER TABLE "contact_import" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_import" ADD CONSTRAINT "contact_import_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;
