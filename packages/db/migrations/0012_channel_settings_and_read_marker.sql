ALTER TABLE "channel_account" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "provider_read_message_id" text;