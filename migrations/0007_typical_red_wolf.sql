CREATE TABLE "job_feedback_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_feedback_submissions_reason_valid" CHECK ("job_feedback_submissions"."reason" IN ('irrelevant', 'duplicate', 'incorrect', 'unavailable', 'suspicious')),
	CONSTRAINT "job_feedback_submissions_details_bounded" CHECK ("job_feedback_submissions"."details" IS NULL OR (char_length("job_feedback_submissions"."details") BETWEEN 1 AND 1000 AND "job_feedback_submissions"."details" = btrim("job_feedback_submissions"."details")))
);
--> statement-breakpoint
ALTER TABLE "job_feedback_submissions" ADD CONSTRAINT "job_feedback_submissions_owner_id_job_id_search_jobs_owner_id_id_fk" FOREIGN KEY ("owner_id","job_id") REFERENCES "public"."search_jobs"("owner_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_feedback_submissions_job_created" ON "job_feedback_submissions" USING btree ("owner_id","job_id","created_at");--> statement-breakpoint
CREATE INDEX "job_feedback_submissions_created" ON "job_feedback_submissions" USING btree ("created_at");