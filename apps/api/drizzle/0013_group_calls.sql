CREATE TABLE "group_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"started_by" uuid,
	"participant_count" integer DEFAULT 0 NOT NULL,
	"peak_participants" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_calls" ADD CONSTRAINT "group_calls_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_calls_one_running_idx" ON "group_calls" USING btree ("conversation_id") WHERE "group_calls"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "group_calls_running_idx" ON "group_calls" USING btree ("started_at") WHERE "group_calls"."ended_at" IS NULL;