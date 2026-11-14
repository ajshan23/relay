ALTER TYPE "public"."channel_status" ADD VALUE 'setting_up';--> statement-breakpoint
CREATE TABLE "onboarding_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text,
	"user_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"step" text DEFAULT 'start' NOT NULL,
	"error_code" text,
	"error_message" text,
	"channel_account_id" text,
	"session" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_attempt" ADD CONSTRAINT "onboarding_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_attempt" ADD CONSTRAINT "onboarding_attempt_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_attempt" ADD CONSTRAINT "onboarding_attempt_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_attempt_org_idx" ON "onboarding_attempt" USING btree ("organization_id","created_at");