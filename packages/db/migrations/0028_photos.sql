CREATE TYPE "public"."ai_agent_photos" AS ENUM('off', 'accurate', 'best');--> statement-breakpoint
ALTER TYPE "public"."ai_usage_kind" ADD VALUE 'vision';--> statement-breakpoint
ALTER TABLE "ai_agent" ADD COLUMN "photos" "ai_agent_photos" DEFAULT 'accurate' NOT NULL;