CREATE TYPE "public"."conversation_kind" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."group_status" AS ENUM('creating', 'active', 'suspended', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."group_join_request_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."group_participant_status" AS ENUM('active', 'left', 'removed');--> statement-breakpoint
CREATE TABLE "message_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"message_id" text NOT NULL,
	"contact_identity_id" text NOT NULL,
	"status" "message_status" NOT NULL,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"failed_at" timestamp,
	"error" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_group" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"channel_account_id" text NOT NULL,
	"branch_id" text,
	"external_id" text,
	"request_id" text,
	"subject" text,
	"description" text,
	"invite_link" text,
	"join_approval_mode" text,
	"status" "group_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "group_join_request" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"external_id" text NOT NULL,
	"contact_identity_id" text NOT NULL,
	"status" "group_join_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "group_participant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"contact_identity_id" text NOT NULL,
	"status" "group_participant_status" DEFAULT 'active' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
DROP INDEX "conversation_account_identity_uidx";--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ALTER COLUMN "contact_identity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "kind" "conversation_kind" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "group_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "sender_identity_id" text;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_contact_identity_id_contact_identity_id_fk" FOREIGN KEY ("contact_identity_id") REFERENCES "public"."contact_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_group" ADD CONSTRAINT "channel_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_group" ADD CONSTRAINT "channel_group_channel_account_id_channel_account_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_group" ADD CONSTRAINT "channel_group_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_request" ADD CONSTRAINT "group_join_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_request" ADD CONSTRAINT "group_join_request_group_id_channel_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_join_request" ADD CONSTRAINT "group_join_request_contact_identity_id_contact_identity_id_fk" FOREIGN KEY ("contact_identity_id") REFERENCES "public"."contact_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_participant" ADD CONSTRAINT "group_participant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_participant" ADD CONSTRAINT "group_participant_group_id_channel_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_participant" ADD CONSTRAINT "group_participant_contact_identity_id_contact_identity_id_fk" FOREIGN KEY ("contact_identity_id") REFERENCES "public"."contact_identity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_receipt_uidx" ON "message_receipt" USING btree ("message_id","contact_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_group_external_uidx" ON "channel_group" USING btree ("channel_account_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_group_request_uidx" ON "channel_group" USING btree ("channel_account_id","request_id");--> statement-breakpoint
CREATE INDEX "channel_group_org_idx" ON "channel_group" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_join_request_uidx" ON "group_join_request" USING btree ("group_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_participant_uidx" ON "group_participant" USING btree ("group_id","contact_identity_id");--> statement-breakpoint
CREATE INDEX "group_participant_identity_idx" ON "group_participant" USING btree ("contact_identity_id");--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_group_id_channel_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."channel_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_sender_identity_id_contact_identity_id_fk" FOREIGN KEY ("sender_identity_id") REFERENCES "public"."contact_identity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_direct_uidx" ON "conversation" USING btree ("channel_account_id","contact_identity_id") WHERE "conversation"."kind" = 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_group_uidx" ON "conversation" USING btree ("channel_account_id","group_id") WHERE "conversation"."kind" = 'group';--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_kind_complete" CHECK (("conversation"."kind" = 'direct' and "conversation"."contact_identity_id" is not null and "conversation"."contact_id" is not null) or ("conversation"."kind" = 'group' and "conversation"."group_id" is not null));