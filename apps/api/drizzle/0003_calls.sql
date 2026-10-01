CREATE TYPE "public"."call_end_reason" AS ENUM('missed', 'cancelled', 'declined', 'busy', 'completed', 'connection-lost', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."call_media" AS ENUM('audio', 'video');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('ringing', 'active', 'ended');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_id" uuid NOT NULL,
	"media" "call_media" NOT NULL,
	"status" "call_status" DEFAULT 'ringing' NOT NULL,
	"end_reason" "call_end_reason",
	"caller_connection_id" text NOT NULL,
	"callee_connection_id" text,
	"caller_disconnected_at" timestamp with time zone,
	"callee_disconnected_at" timestamp with time zone,
	"silenced" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "calls_ended_has_reason_ck" CHECK (("calls"."status" = 'ended') = ("calls"."end_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_users_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_open_idx" ON "calls" USING btree ("status","created_at") WHERE "calls"."status" <> 'ended';--> statement-breakpoint
CREATE INDEX "calls_open_caller_idx" ON "calls" USING btree ("caller_id") WHERE "calls"."status" <> 'ended';--> statement-breakpoint
CREATE INDEX "calls_open_callee_idx" ON "calls" USING btree ("callee_id") WHERE "calls"."status" <> 'ended';--> statement-breakpoint
CREATE INDEX "calls_conversation_idx" ON "calls" USING btree ("conversation_id","created_at");