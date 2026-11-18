CREATE TYPE "public"."ai_agent_voice_notes" AS ENUM('off', 'accurate', 'best');--> statement-breakpoint
ALTER TYPE "public"."ai_usage_kind" ADD VALUE 'transcribe';--> statement-breakpoint
ALTER TABLE "ai_agent" ADD COLUMN "voice_notes" "ai_agent_voice_notes" DEFAULT 'accurate' NOT NULL;