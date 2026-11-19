CREATE TYPE "public"."ai_tool_call_status" AS ENUM('ok', 'error', 'declined', 'not_sent');--> statement-breakpoint
CREATE TYPE "public"."ai_tool_kind" AS ENUM('http', 'mcp');--> statement-breakpoint
CREATE TABLE "ai_tool" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" "ai_tool_kind" NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"confirm" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"secret" text,
	"secret_hint" text,
	"last_test_ok" boolean,
	"last_tested_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_tool_call" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool_id" text,
	"conversation_id" text,
	"step_key" text,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"status" "ai_tool_call_status" NOT NULL,
	"http_status" integer,
	"ms" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_tool" ADD CONSTRAINT "ai_tool_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool" ADD CONSTRAINT "ai_tool_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool" ADD CONSTRAINT "ai_tool_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_call" ADD CONSTRAINT "ai_tool_call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_call" ADD CONSTRAINT "ai_tool_call_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_call" ADD CONSTRAINT "ai_tool_call_tool_id_ai_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."ai_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_call" ADD CONSTRAINT "ai_tool_call_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tool_agent_idx" ON "ai_tool" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tool_agent_name_uidx" ON "ai_tool" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "ai_tool_call_agent_idx" ON "ai_tool_call" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tool_call_step_uidx" ON "ai_tool_call" USING btree ("step_key");