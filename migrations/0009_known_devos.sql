ALTER TABLE "search_runs" DROP CONSTRAINT "search_outcomes_bounded";--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_outcomes_bounded" CHECK ("search_runs"."source_outcomes" IS NULL OR (jsonb_typeof("search_runs"."source_outcomes") = 'array'
        AND jsonb_array_length("search_runs"."source_outcomes") BETWEEN 1 AND 5
        AND octet_length("search_runs"."source_outcomes"::text) <= 2048));