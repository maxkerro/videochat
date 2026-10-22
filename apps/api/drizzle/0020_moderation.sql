CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"moderator_id" uuid,
	"action" text NOT NULL,
	"report_id" uuid,
	"target_user_id" uuid,
	"note" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "snapshot_from_reporter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "message_reports" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_moderator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_moderator_id_users_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_message_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."message_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_actions_created_idx" ON "moderation_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "moderation_actions_target_idx" ON "moderation_actions" USING btree ("target_user_id","created_at");--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reports_reporter_user_open_uq" ON "message_reports" USING btree ("reporter_id","reported_user_id") WHERE "message_reports"."message_id" IS NULL AND "message_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "message_reports_queue_idx" ON "message_reports" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_status_ck" CHECK ("message_reports"."status" in ('open', 'resolved', 'dismissed'));