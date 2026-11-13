CREATE TYPE "public"."broadcast_status" AS ENUM('draft', 'scheduled', 'preparing', 'sending', 'paused', 'completed', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."broadcast_recipient_status" AS ENUM('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "broadcast" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_type" text NOT NULL,
	"channel_account_id" text,
	"content" jsonb NOT NULL,
	"audience" jsonb NOT NULL,
	"schedule" jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'draft' NOT NULL,
	"pause_reason" text,
	"pause_detail" text,
	"total" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"read" integer DEFAULT 0 NOT NULL,
	"replied" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipient" (
	"id" text PRIMARY KEY NOT NULL,
	"broadcast_id" text NOT NULL,
	"contact_id" text,
	"address" text NOT NULL,
	"status" "broadcast_recipient_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"message_id" text,
	"error_code" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp,
	"sent_at" timestamp,
	"replied_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "broadcast_id" text;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast" ADD CONSTRAINT "broadcast_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_broadcast_id_broadcast_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcast"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD CONSTRAINT "broadcast_recipient_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_branch_idx" ON "broadcast" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcast_status_idx" ON "broadcast" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcast_recipient_address_uidx" ON "broadcast_recipient" USING btree ("broadcast_id","address");--> statement-breakpoint
CREATE INDEX "broadcast_recipient_status_idx" ON "broadcast_recipient" USING btree ("broadcast_id","status","retry_at");--> statement-breakpoint
CREATE INDEX "broadcast_recipient_message_idx" ON "broadcast_recipient" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_broadcast_idx" ON "message" USING btree ("broadcast_id");