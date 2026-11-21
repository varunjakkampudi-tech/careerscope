ALTER TABLE "lead_history" ADD COLUMN "follow_up_changed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_history" ADD COLUMN "follow_up_at" timestamp with time zone;