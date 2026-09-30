ALTER TABLE "run_events" DROP CONSTRAINT "run_events_run_id_search_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_events" DROP CONSTRAINT "run_events_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "search_jobs" DROP CONSTRAINT "search_jobs_run_id_search_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "search_jobs" DROP CONSTRAINT "search_jobs_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_owner_id_run_id_search_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."search_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_owner_id_run_id_search_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."search_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;