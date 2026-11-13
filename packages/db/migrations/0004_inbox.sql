CREATE TABLE "conversation_read" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"last_read_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachment" ADD COLUMN "uploaded_by_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "assigned_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "last_message_preview" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_read" ADD CONSTRAINT "conversation_read_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_read_uidx" ON "conversation_read" USING btree ("user_id","conversation_id");--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploaded_by_user_id_user_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_assignee_idx" ON "conversation" USING btree ("organization_id","assigned_user_id","last_message_at");--> statement-breakpoint
UPDATE "conversation" c SET "last_message_preview" = jsonb_build_object(
  'type', m."type",
  'text', coalesce(m."content"->>'text', m."content"->>'caption'),
  'direction', m."direction",
  'senderName', null
) FROM (
  SELECT DISTINCT ON ("conversation_id") "conversation_id", "type", "content", "direction"
  FROM "message" WHERE "type" <> 'reaction' ORDER BY "conversation_id", "sent_at" DESC
) m WHERE m."conversation_id" = c."id";
