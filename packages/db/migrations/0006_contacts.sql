CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
-- Typed reads of custom contact fields. IMMUTABLE so Postgres can index them (a plain ::date cast is not).
CREATE OR REPLACE FUNCTION relay_attr_num(attrs jsonb, key text) RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(attrs -> key) = 'number' THEN (attrs ->> key)::numeric END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_attr_date(attrs jsonb, key text) RETURNS date
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN (attrs ->> key) ~ '^\d{4}-\d{2}-\d{2}$'
    THEN make_date(substr(attrs ->> key, 1, 4)::int, substr(attrs ->> key, 6, 2)::int, substr(attrs ->> key, 9, 2)::int)
  END
$$;--> statement-breakpoint
CREATE TYPE "public"."contact_field_type" AS ENUM('text', 'number', 'date', 'boolean', 'select', 'multi_select', 'email', 'phone', 'url');--> statement-breakpoint
CREATE TYPE "public"."contact_import_status" AS ENUM('mapping', 'queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."contact_list_kind" AS ENUM('static', 'smart');--> statement-breakpoint
CREATE TABLE "contact_field" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "contact_field_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"indexed" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_import" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"sheet" text,
	"mapping" jsonb,
	"on_match" text DEFAULT 'update' NOT NULL,
	"status" "contact_import_status" DEFAULT 'mapping' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "contact_list" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "contact_list_kind" NOT NULL,
	"filter" jsonb,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_list_member" (
	"list_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contact_list_member_list_id_contact_id_pk" PRIMARY KEY("list_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "contact_note" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"author_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_view" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text,
	"channel_account_id" text,
	"name" text NOT NULL,
	"colour" text DEFAULT 'gray' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "branch_id" text;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "tag_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "source" text DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "marketing_opt_out_at" timestamp;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "last_message_at" timestamp;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "contact_field" ADD CONSTRAINT "contact_field_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_field" ADD CONSTRAINT "contact_field_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_import" ADD CONSTRAINT "contact_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_import" ADD CONSTRAINT "contact_import_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list" ADD CONSTRAINT "contact_list_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list" ADD CONSTRAINT "contact_list_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_member" ADD CONSTRAINT "contact_list_member_list_id_contact_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_member" ADD CONSTRAINT "contact_list_member_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_member" ADD CONSTRAINT "contact_list_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_note" ADD CONSTRAINT "contact_note_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_note" ADD CONSTRAINT "contact_note_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_note" ADD CONSTRAINT "contact_note_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_view" ADD CONSTRAINT "contact_view_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_view" ADD CONSTRAINT "contact_view_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_field_key_uidx" ON "contact_field" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "contact_import_org_idx" ON "contact_import" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_list_name_uidx" ON "contact_list" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "contact_list_member_contact_idx" ON "contact_list_member" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_note_contact_idx" ON "contact_note" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_view_org_idx" ON "contact_view" USING btree ("organization_id","owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_scope_uidx" ON "tag" USING btree ("organization_id",lower("name"),coalesce("branch_id", ''),coalesce("channel_account_id", ''));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_org_last_message_idx" ON "contact" USING btree ("organization_id","last_message_at");--> statement-breakpoint
CREATE INDEX "contact_attributes_gin" ON "contact" USING gin ("attributes" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "contact_tags_gin" ON "contact" USING gin ("tag_ids");--> statement-breakpoint
CREATE INDEX "contact_name_trgm" ON "contact" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contact_email_trgm" ON "contact" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contact_identity_phone_trgm" ON "contact_identity" USING gin ("phone" gin_trgm_ops);
--> statement-breakpoint
-- Existing contacts: last message time and home branch from their conversations.
UPDATE "contact" c SET
  "last_message_at" = x.last_at,
  "branch_id" = COALESCE(c."branch_id", x.branch_id)
FROM (
  SELECT DISTINCT ON ("contact_id") "contact_id", "branch_id",
    max("last_message_at") OVER (PARTITION BY "contact_id") AS last_at
  FROM "conversation" WHERE "contact_id" IS NOT NULL
  ORDER BY "contact_id", "last_message_at" DESC NULLS LAST
) x WHERE x."contact_id" = c."id";
