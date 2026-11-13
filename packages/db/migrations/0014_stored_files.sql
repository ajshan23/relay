CREATE TABLE "provider_media" (
	"file_id" text NOT NULL,
	"channel_account_id" text NOT NULL,
	"provider_media_id" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_media_file_id_channel_account_id_pk" PRIMARY KEY("file_id","channel_account_id")
);
--> statement-breakpoint
CREATE TABLE "stored_file" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text,
	"storage_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "file_id" text;--> statement-breakpoint
ALTER TABLE "provider_media" ADD CONSTRAINT "provider_media_file_id_stored_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_media" ADD CONSTRAINT "provider_media_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stored_file_org_sha_uidx" ON "stored_file" USING btree ("organization_id","sha256");--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_file_id_stored_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_file_idx" ON "attachment" USING btree ("file_id");