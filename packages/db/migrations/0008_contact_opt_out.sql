CREATE TYPE "public"."contact_opt_out_source" AS ENUM('reply', 'manual', 'import');--> statement-breakpoint
CREATE TABLE "contact_opt_out" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"channel_account_id" text,
	"source" "contact_opt_out_source" NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact_opt_out" ADD CONSTRAINT "contact_opt_out_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_out" ADD CONSTRAINT "contact_opt_out_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_out" ADD CONSTRAINT "contact_opt_out_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_opt_out" ADD CONSTRAINT "contact_opt_out_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_opt_out_scope_uidx" ON "contact_opt_out" USING btree ("contact_id",coalesce("channel_account_id", ''));--> statement-breakpoint
CREATE INDEX "contact_opt_out_org_channel_idx" ON "contact_opt_out" USING btree ("organization_id","channel_account_id");--> statement-breakpoint
-- Existing opt-outs become "all channels" opt-outs (they were never tied to a channel).
INSERT INTO "contact_opt_out" ("id", "organization_id", "contact_id", "channel_account_id", "source", "created_at")
SELECT 'opt_' || replace(gen_random_uuid()::text, '-', ''), "organization_id", "id", NULL, 'manual', "marketing_opt_out_at"
FROM "contact" WHERE "marketing_opt_out_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" DROP COLUMN "marketing_opt_out_at";