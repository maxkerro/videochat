ALTER TABLE "e2ee_devices" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "e2ee_key_packages" ADD COLUMN "last_resort" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_key_packages_last_resort_uq" ON "e2ee_key_packages" USING btree ("device_id") WHERE "e2ee_key_packages"."last_resort";