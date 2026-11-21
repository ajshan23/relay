CREATE TYPE "public"."ai_agent_engine" AS ENUM('gpt', 'claude');--> statement-breakpoint
ALTER TABLE "ai_agent" ADD COLUMN "engine" "ai_agent_engine" DEFAULT 'gpt' NOT NULL;