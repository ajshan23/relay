CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"to" text NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"user_id" text,
	"organization_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "email_log_to_idx" ON "email_log" USING btree ("to","created_at");--> statement-breakpoint
CREATE INDEX "email_log_status_idx" ON "email_log" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "email_log_org_idx" ON "email_log" USING btree ("organization_id","created_at");