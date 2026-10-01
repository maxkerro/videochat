ALTER TYPE "public"."message_type" ADD VALUE 'call';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb;