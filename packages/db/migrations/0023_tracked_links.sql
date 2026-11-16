CREATE TABLE "tracked_link" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text,
	"automation_id" text,
	"run_id" text NOT NULL,
	"step_key" text NOT NULL,
	"url" text NOT NULL,
	"first_tapped_at" timestamp,
	"tap_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracked_link" ADD CONSTRAINT "tracked_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link" ADD CONSTRAINT "tracked_link_automation_id_automation_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_link_code_uidx" ON "tracked_link" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_link_step_uidx" ON "tracked_link" USING btree ("step_key");--> statement-breakpoint
CREATE INDEX "tracked_link_run_idx" ON "tracked_link" USING btree ("run_id");