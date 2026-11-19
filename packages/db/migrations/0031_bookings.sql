CREATE TYPE "public"."booking_by" AS ENUM('ai', 'team');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('booked', 'confirmed', 'arrived', 'no_show', 'cancelled');--> statement-breakpoint
CREATE TABLE "booking" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"item_id" text,
	"variant_id" text,
	"contact_id" text,
	"conversation_id" text,
	"title" text NOT NULL,
	"reference" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"party_size" integer,
	"notes" text DEFAULT '' NOT NULL,
	"status" "booking_status" DEFAULT 'booked' NOT NULL,
	"booked_by" "booking_by" NOT NULL,
	"booked_by_user_id" text,
	"confirmed_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_reminder" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"hours_before" real NOT NULL,
	"outcome" text NOT NULL,
	"note" text,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_setting" (
	"branch_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"hours" jsonb NOT NULL,
	"closed_dates" text[] DEFAULT '{}'::text[] NOT NULL,
	"step_minutes" integer DEFAULT 30 NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"min_notice_minutes" integer DEFAULT 60 NOT NULL,
	"max_days_ahead" integer DEFAULT 30 NOT NULL,
	"reminders" jsonb NOT NULL,
	"reminder_template_id" text,
	"source" text DEFAULT 'relay' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_variant" ADD COLUMN "booking_capacity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_item_id_catalog_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_variant_id_catalog_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking" ADD CONSTRAINT "booking_booked_by_user_id_user_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."booking"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_reminder" ADD CONSTRAINT "booking_reminder_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_reminder_template_id_message_template_id_fk" FOREIGN KEY ("reminder_template_id") REFERENCES "public"."message_template"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_branch_time_idx" ON "booking" USING btree ("organization_id","branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_variant_time_idx" ON "booking" USING btree ("variant_id","starts_at");--> statement-breakpoint
CREATE INDEX "booking_contact_idx" ON "booking" USING btree ("contact_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_reference_uidx" ON "booking" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_reminder_uidx" ON "booking_reminder" USING btree ("booking_id","starts_at","hours_before");