CREATE TYPE "public"."last_seen_visibility" AS ENUM('everyone', 'contacts', 'nobody');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_visibility" "last_seen_visibility" DEFAULT 'everyone' NOT NULL;