CREATE TABLE "agent_task" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"title" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"due_date" text,
	"source" text DEFAULT 'agent' NOT NULL,
	"list_id" text,
	"external_task_id" text,
	"status" text DEFAULT 'sending' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"account_email" text,
	"refresh_token" text NOT NULL,
	"access_token" text,
	"access_expires_at" timestamp with time zone,
	"list_id" text,
	"list_name" text,
	"lists" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"on_handoff" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"connected_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_connection_branch_id_unique" UNIQUE("branch_id")
);
--> statement-breakpoint
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task" ADD CONSTRAINT "agent_task_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_connection" ADD CONSTRAINT "task_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_connection" ADD CONSTRAINT "task_connection_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_connection" ADD CONSTRAINT "task_connection_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_task_conversation_idx" ON "agent_task" USING btree ("conversation_id","created_at");