CREATE TABLE "e2ee_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "e2ee_groups" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"creator_device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_key_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"key_package" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_welcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"recipient_device_id" uuid NOT NULL,
	"sender_device_id" uuid,
	"welcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "e2ee_devices" ADD CONSTRAINT "e2ee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_groups" ADD CONSTRAINT "e2ee_groups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_groups" ADD CONSTRAINT "e2ee_groups_creator_device_id_e2ee_devices_id_fk" FOREIGN KEY ("creator_device_id") REFERENCES "public"."e2ee_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_key_packages" ADD CONSTRAINT "e2ee_key_packages_device_id_e2ee_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."e2ee_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_welcomes" ADD CONSTRAINT "e2ee_welcomes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_welcomes" ADD CONSTRAINT "e2ee_welcomes_recipient_device_id_e2ee_devices_id_fk" FOREIGN KEY ("recipient_device_id") REFERENCES "public"."e2ee_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_welcomes" ADD CONSTRAINT "e2ee_welcomes_sender_device_id_e2ee_devices_id_fk" FOREIGN KEY ("sender_device_id") REFERENCES "public"."e2ee_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "e2ee_devices_user_idx" ON "e2ee_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "e2ee_key_packages_device_idx" ON "e2ee_key_packages" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "e2ee_welcomes_recipient_idx" ON "e2ee_welcomes" USING btree ("recipient_device_id","created_at");