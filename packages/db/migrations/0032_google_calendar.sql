CREATE TABLE "calendar_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"account_email" text,
	"refresh_token" text NOT NULL,
	"access_token" text,
	"access_expires_at" timestamp with time zone,
	"calendar_id" text,
	"calendar_name" text,
	"calendars" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pick_calendar' NOT NULL,
	"last_error" text,
	"connected_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connection_branch_id_unique" UNIQUE("branch_id")
);
--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "external_event_id" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "meet_url" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_sync" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_error" text;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "booking" ADD COLUMN "calendar_tried_at" timestamp;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD COLUMN "online_reminder_template_id" text;--> statement-breakpoint
ALTER TABLE "catalog_variant" ADD COLUMN "booking_online" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connection" ADD CONSTRAINT "calendar_connection_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_setting" ADD CONSTRAINT "booking_setting_online_reminder_template_id_message_template_id_fk" FOREIGN KEY ("online_reminder_template_id") REFERENCES "public"."message_template"("id") ON DELETE set null ON UPDATE no action;