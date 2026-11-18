CREATE TYPE "public"."ai_agent_voice_replies" AS ENUM('off', 'voice_notes', 'always');--> statement-breakpoint
ALTER TYPE "public"."ai_usage_kind" ADD VALUE 'speech';--> statement-breakpoint
ALTER TABLE "ai_agent" ADD COLUMN "voice_replies" "ai_agent_voice_replies" DEFAULT 'off' NOT NULL;