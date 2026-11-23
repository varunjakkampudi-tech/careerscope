CREATE TABLE "job_feedback_review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"feedback_id" uuid NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_feedback_review_events_status_valid" CHECK ("job_feedback_review_events"."status" IN ('confirmed', 'dismissed')),
	CONSTRAINT "job_feedback_review_events_note_bounded" CHECK ("job_feedback_review_events"."note" IS NULL OR length("job_feedback_review_events"."note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "job_feedback_reviews" (
	"feedback_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "job_feedback_reviews_status_valid" CHECK ("job_feedback_reviews"."status" IN ('confirmed', 'dismissed')),
	CONSTRAINT "job_feedback_reviews_note_bounded" CHECK ("job_feedback_reviews"."note" IS NULL OR length("job_feedback_reviews"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "job_feedback_review_events" ADD CONSTRAINT "job_feedback_review_events_feedback_id_job_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."job_feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback_review_events" ADD CONSTRAINT "job_feedback_review_events_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback_reviews" ADD CONSTRAINT "job_feedback_reviews_feedback_id_job_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."job_feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback_reviews" ADD CONSTRAINT "job_feedback_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_feedback_review_events_feedback_created" ON "job_feedback_review_events" USING btree ("feedback_id","created_at");--> statement-breakpoint
CREATE INDEX "job_feedback_reviews_status_reviewed" ON "job_feedback_reviews" USING btree ("status","reviewed_at");