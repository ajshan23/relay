DROP INDEX "contact_org_last_message_idx";--> statement-breakpoint
DROP INDEX "contact_org_phone_idx";--> statement-breakpoint
DROP INDEX "contact_identity_phone_idx";--> statement-breakpoint
CREATE INDEX "contact_branch_last_message_idx" ON "contact" USING btree ("branch_id","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_branch_created_idx" ON "contact" USING btree ("branch_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_branch_phone_idx" ON "contact" USING btree ("branch_id","phone");--> statement-breakpoint
CREATE INDEX "contact_branch_email_idx" ON "contact" USING btree ("branch_id","email");--> statement-breakpoint
CREATE INDEX "contact_identity_phone_idx" ON "contact_identity" USING btree ("branch_id","phone");