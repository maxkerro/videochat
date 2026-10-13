ALTER TABLE "devices" ADD COLUMN "session_family_id" uuid;--> statement-breakpoint
CREATE INDEX "devices_session_family_idx" ON "devices" USING btree ("session_family_id");