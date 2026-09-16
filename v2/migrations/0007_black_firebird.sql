ALTER TABLE "search_runs" DROP CONSTRAINT "search_status_valid";--> statement-breakpoint
ALTER TABLE "search_runs" ADD COLUMN "source_outcomes" jsonb;--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_outcomes_bounded" CHECK ("search_runs"."source_outcomes" IS NULL OR (jsonb_typeof("search_runs"."source_outcomes") = 'array'
        AND jsonb_array_length("search_runs"."source_outcomes") BETWEEN 1 AND 2
        AND octet_length("search_runs"."source_outcomes"::text) <= 2048));--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_partial_has_outcomes" CHECK ("search_runs"."status" <> 'partial' OR "search_runs"."source_outcomes" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_status_valid" CHECK ("search_runs"."status" IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled'));