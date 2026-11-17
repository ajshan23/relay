CREATE TYPE "public"."catalog_item_status" AS ENUM('active', 'draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."catalog_media_kind" AS ENUM('image', 'video', 'audio', 'document');--> statement-breakpoint
CREATE TYPE "public"."catalog_media_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."catalog_type_kind" AS ENUM('product', 'service', 'other');--> statement-breakpoint
CREATE TABLE "catalog_category" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_field" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "contact_field_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" text,
	"on_variant" boolean DEFAULT false NOT NULL,
	"filterable" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_import" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"user_id" text,
	"type_id" text,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"sheet" text,
	"sheets" jsonb,
	"read_error" text,
	"mapping" jsonb,
	"status" "contact_import_status" DEFAULT 'reading' NOT NULL,
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
CREATE TABLE "catalog_item" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"type_id" text NOT NULL,
	"category_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "catalog_item_status" DEFAULT 'active' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"search_text" text DEFAULT '' NOT NULL,
	"embedding" halfvec(512),
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(search_text, ''))) STORED,
	"revision" integer DEFAULT 1 NOT NULL,
	"embedded_revision" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_media" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"item_id" text NOT NULL,
	"variant_id" text,
	"file_id" text,
	"upload_key" text,
	"kind" "catalog_media_kind" NOT NULL,
	"mime_type" text,
	"file_name" text,
	"size_bytes" bigint,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"caption" text,
	"status" "catalog_media_status" DEFAULT 'processing' NOT NULL,
	"error" text,
	"duration_seconds" integer,
	"width" integer,
	"height" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_type" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "catalog_type_kind" DEFAULT 'product' NOT NULL,
	"template" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"sku" text,
	"price_minor" bigint,
	"currency" text NOT NULL,
	"sale_price_minor" bigint,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stock" integer,
	"available" boolean DEFAULT true NOT NULL,
	"duration_minutes" integer,
	"bookable" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "catalog" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_parent_id_catalog_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."catalog_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_field" ADD CONSTRAINT "catalog_field_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_field" ADD CONSTRAINT "catalog_field_type_id_catalog_type_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."catalog_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_type_id_catalog_type_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."catalog_type"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_type_id_catalog_type_id_fk" FOREIGN KEY ("type_id") REFERENCES "public"."catalog_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_category_id_catalog_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."catalog_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_media" ADD CONSTRAINT "catalog_media_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_media" ADD CONSTRAINT "catalog_media_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_media" ADD CONSTRAINT "catalog_media_item_id_catalog_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_media" ADD CONSTRAINT "catalog_media_variant_id_catalog_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."catalog_variant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_media" ADD CONSTRAINT "catalog_media_file_id_stored_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."stored_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_type" ADD CONSTRAINT "catalog_type_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_variant" ADD CONSTRAINT "catalog_variant_item_id_catalog_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_variant" ADD CONSTRAINT "catalog_variant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_variant" ADD CONSTRAINT "catalog_variant_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_category_branch_idx" ON "catalog_category" USING btree ("organization_id","branch_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_field_key_uidx" ON "catalog_field" USING btree ("type_id","key");--> statement-breakpoint
CREATE INDEX "catalog_import_org_idx" ON "catalog_import" USING btree ("organization_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "catalog_item_branch_idx" ON "catalog_item" USING btree ("organization_id","branch_id","status","category_id");--> statement-breakpoint
CREATE INDEX "catalog_item_updated_idx" ON "catalog_item" USING btree ("organization_id","branch_id","updated_at");--> statement-breakpoint
CREATE INDEX "catalog_item_attributes_idx" ON "catalog_item" USING gin ("attributes" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "catalog_item_tsv_idx" ON "catalog_item" USING gin ("tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_item_external_uidx" ON "catalog_item" USING btree ("organization_id","branch_id","source","external_id") WHERE "catalog_item"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_item_embed_idx" ON "catalog_item" USING btree ("organization_id","branch_id") WHERE "catalog_item"."embedded_revision" < "catalog_item"."revision";--> statement-breakpoint
CREATE INDEX "catalog_media_item_idx" ON "catalog_media" USING btree ("item_id","position");--> statement-breakpoint
CREATE INDEX "catalog_media_file_idx" ON "catalog_media" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_media_primary_uidx" ON "catalog_media" USING btree ("item_id") WHERE "catalog_media"."is_primary" and "catalog_media"."variant_id" is null;--> statement-breakpoint
CREATE INDEX "catalog_type_org_idx" ON "catalog_type" USING btree ("organization_id","position");--> statement-breakpoint
CREATE INDEX "catalog_variant_item_idx" ON "catalog_variant" USING btree ("item_id","position");--> statement-breakpoint
CREATE INDEX "catalog_variant_price_idx" ON "catalog_variant" USING btree ("organization_id","branch_id","price_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_variant_sku_uidx" ON "catalog_variant" USING btree ("organization_id","branch_id","sku") WHERE "catalog_variant"."sku" is not null;