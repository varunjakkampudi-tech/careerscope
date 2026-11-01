ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_counter" integer;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" IN ('candidate', 'admin'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_admin_requires_totp" CHECK ("users"."role" = 'candidate' OR "users"."totp_enabled_at" IS NOT NULL);