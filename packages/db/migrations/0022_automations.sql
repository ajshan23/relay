CREATE TYPE "public"."automation_status" AS ENUM('draft', 'live', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "automation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"channel_account_id" text,
	"status" "automation_status" DEFAULT 'draft' NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"live_version_id" text,
	"trigger_type" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"updated_by_user_id" text,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_version" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"number" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"published_by_user_id" text,
	"published_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "automation_run_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "automation_step_key" text;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation" ADD CONSTRAINT "automation_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version" ADD CONSTRAINT "automation_version_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version" ADD CONSTRAINT "automation_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_version" ADD CONSTRAINT "automation_version_published_by_user_id_user_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_branch_idx" ON "automation" USING btree ("organization_id","branch_id","updated_at");--> statement-breakpoint
CREATE INDEX "automation_route_idx" ON "automation" USING btree ("channel_account_id","trigger_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_version_number_uidx" ON "automation_version" USING btree ("automation_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "message_automation_step_uidx" ON "message" USING btree ("automation_step_key") WHERE "message"."automation_step_key" is not null;