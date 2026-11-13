ALTER TYPE "public"."contact_import_status" ADD VALUE 'reading' BEFORE 'mapping';--> statement-breakpoint
ALTER TABLE "contact_import" ADD COLUMN "sheets" jsonb;--> statement-breakpoint
ALTER TABLE "contact_import" ADD COLUMN "read_error" text;