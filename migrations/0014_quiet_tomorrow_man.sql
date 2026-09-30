ALTER TABLE "saved_leads" ADD COLUMN "liveness_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_leads" ADD COLUMN "liveness_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "lead_liveness_checked" ON "saved_leads" USING btree ("liveness_checked_at");--> statement-breakpoint
ALTER TABLE "saved_leads" ADD CONSTRAINT "lead_liveness_status_valid" CHECK ("saved_leads"."liveness_status" IN ('unknown', 'live', 'stale'));