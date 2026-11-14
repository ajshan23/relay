ALTER TYPE "public"."broadcast_recipient_status" ADD VALUE 'held_back' BEFORE 'skipped';--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"broadcast" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "kind" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "follow_up" jsonb;--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "test" jsonb;--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "winner" jsonb;--> statement-breakpoint
ALTER TABLE "broadcast" ADD COLUMN "held_back" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD COLUMN "holds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_recipient" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_parent_idx" ON "broadcast" USING btree ("parent_id");