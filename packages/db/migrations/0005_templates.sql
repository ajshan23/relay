CREATE TYPE "public"."template_status" AS ENUM('draft', 'in_review', 'ready', 'needs_changes', 'paused', 'disabled');--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"purpose" text NOT NULL,
	"content" jsonb NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'relay' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" text NOT NULL,
	"channel_account_id" text NOT NULL,
	"scope" text NOT NULL,
	"external_id" text,
	"status" "template_status" DEFAULT 'draft' NOT NULL,
	"reason" text,
	"error" text,
	"submitted_at" timestamp,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_channel" ADD CONSTRAINT "template_channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_channel" ADD CONSTRAINT "template_channel_template_id_message_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."message_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_channel" ADD CONSTRAINT "template_channel_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_template_slug_uidx" ON "message_template" USING btree ("organization_id","slug","language");--> statement-breakpoint
CREATE UNIQUE INDEX "template_channel_uidx" ON "template_channel" USING btree ("template_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "template_channel_external_idx" ON "template_channel" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "template_channel_account_idx" ON "template_channel" USING btree ("channel_account_id","status");