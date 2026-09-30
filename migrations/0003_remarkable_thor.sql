ALTER TABLE "search_runs" ADD COLUMN "matching_profile" jsonb;--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "profile_revision" integer;