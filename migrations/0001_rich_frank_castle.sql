CREATE TABLE "search_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_run_id_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."search_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_job_fingerprint" ON "search_jobs" USING btree ("run_id","fingerprint");--> statement-breakpoint
CREATE INDEX "job_owner_run" ON "search_jobs" USING btree ("owner_id","run_id");--> statement-breakpoint
ALTER TABLE "command_executions" ADD CONSTRAINT "command_executions_id_outbox_events_id_fk" FOREIGN KEY ("id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_owner_created" ON "search_runs" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_status_valid" CHECK ("search_runs"."status" IN ('queued', 'running', 'completed', 'failed', 'cancelled'));