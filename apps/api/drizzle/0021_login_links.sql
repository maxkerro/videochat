ALTER TYPE "public"."auth_token_purpose" ADD VALUE 'login_link';--> statement-breakpoint
ALTER TYPE "public"."auth_token_purpose" ADD VALUE 'login_code';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_failed_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "login_code_failures" bigint DEFAULT 0 NOT NULL;