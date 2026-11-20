CREATE TABLE "invitation_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role_id" text NOT NULL,
	"all_branches" boolean DEFAULT false NOT NULL,
	"branch_ids" text[] DEFAULT '{}' NOT NULL,
	"all_numbers" boolean DEFAULT true NOT NULL,
	"number_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"all_branches" boolean DEFAULT false NOT NULL,
	"branch_ids" text[] DEFAULT '{}' NOT NULL,
	"all_numbers" boolean DEFAULT true NOT NULL,
	"number_ids" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"built_in" text,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A number belongs to exactly one branch: its default branch (or the first branch it was linked to, or the company's oldest branch).
UPDATE "channel_account" ca SET "default_branch_id" = COALESCE(
  (SELECT cab."branch_id" FROM "channel_account_branch" cab JOIN "branch" b ON b."id" = cab."branch_id" WHERE cab."channel_account_id" = ca."id" ORDER BY b."created_at" LIMIT 1),
  (SELECT b."id" FROM "branch" b WHERE b."organization_id" = ca."organization_id" ORDER BY b."archived_at" IS NOT NULL, b."created_at" LIMIT 1)
) WHERE ca."default_branch_id" IS NULL;--> statement-breakpoint
DELETE FROM "channel_account" WHERE "default_branch_id" IS NULL;--> statement-breakpoint
ALTER TABLE "channel_account_branch" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "channel_account_branch" CASCADE;--> statement-breakpoint
ALTER TABLE "channel_account" DROP CONSTRAINT "channel_account_default_branch_id_branch_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_account" RENAME COLUMN "default_branch_id" TO "branch_id";--> statement-breakpoint
ALTER TABLE "channel_account" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation_grant" ADD CONSTRAINT "invitation_grant_invitation_id_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_grant" ADD CONSTRAINT "invitation_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_grant" ADD CONSTRAINT "invitation_grant_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_grant" ADD CONSTRAINT "member_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_grant" ADD CONSTRAINT "member_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_grant" ADD CONSTRAINT "member_grant_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_grant" ADD CONSTRAINT "member_grant_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitation_grant_invitation_idx" ON "invitation_grant" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "member_grant_org_user_idx" ON "member_grant" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_grant_role_idx" ON "member_grant" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_org_name_uidx" ON "role" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "role_org_builtin_uidx" ON "role" USING btree ("organization_id","built_in");--> statement-breakpoint
ALTER TABLE "channel_account" ADD CONSTRAINT "channel_account_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_account_branch_idx" ON "channel_account" USING btree ("branch_id");--> statement-breakpoint
-- The four built-in roles in every company (their permissions come from code).
INSERT INTO "role" ("id", "organization_id", "name", "description", "built_in")
SELECT 'rol_' || substr(md5(o."id" || r.k), 1, 26), o."id", r.n, r.d, r.k
FROM "organization" o CROSS JOIN (VALUES
  ('admin', 'Admin', 'Everything, in every branch: numbers, team, roles and company settings.'),
  ('manager', 'Manager', 'Runs a branch: chats, broadcasts, automations, AI agent, catalogue, bookings and its people.'),
  ('agent', 'Agent', 'Works the chats: reply, assign, notes, contacts, bookings and quick replies.'),
  ('viewer', 'Viewer', 'Can look at everything in the branch but not change or send anything.')
) AS r(k, n, d);--> statement-breakpoint
-- Company admins keep everything: Admin in every branch and number.
INSERT INTO "member_grant" ("id", "organization_id", "user_id", "role_id", "all_branches", "all_numbers")
SELECT 'grt_' || substr(md5(m."id" || 'admin'), 1, 26), m."organization_id", m."user_id", r."id", true, true
FROM "member" m JOIN "role" r ON r."organization_id" = m."organization_id" AND r."built_in" = 'admin'
WHERE m."role" LIKE '%admin%' AND m."role" NOT LIKE '%owner%';--> statement-breakpoint
-- Branch people keep their branch role, on that branch, with all its numbers.
INSERT INTO "member_grant" ("id", "organization_id", "user_id", "role_id", "all_branches", "branch_ids", "all_numbers")
SELECT 'grt_' || substr(md5(bm."id"), 1, 26), bm."organization_id", bm."user_id", r."id", false, ARRAY[bm."branch_id"], true
FROM "branch_member" bm
JOIN "member" m ON m."organization_id" = bm."organization_id" AND m."user_id" = bm."user_id"
JOIN "role" r ON r."organization_id" = bm."organization_id" AND r."built_in" = bm."role"
WHERE m."role" NOT LIKE '%admin%' AND m."role" NOT LIKE '%owner%';