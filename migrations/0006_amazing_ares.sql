CREATE TABLE "resume_results" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"status" text NOT NULL,
	"parsed" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_result_state_valid" CHECK (
      ("resume_results"."status" = 'parsed' AND "resume_results"."parsed" IS NOT NULL AND "resume_results"."error_code" IS NULL
        AND jsonb_typeof("resume_results"."parsed") = 'object' AND octet_length("resume_results"."parsed"::text) <= 1048576)
      OR ("resume_results"."status" = 'rejected' AND "resume_results"."parsed" IS NULL
        AND "resume_results"."error_code" IS NOT NULL AND "resume_results"."error_code" IN ('invalid_document', 'processing_failed')))
);
--> statement-breakpoint
ALTER TABLE "resume_results" ADD CONSTRAINT "resume_results_command_id_outbox_events_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_owner_id" ON "resume_uploads" USING btree ("owner_id","id");--> statement-breakpoint
ALTER TABLE "resume_results" ADD CONSTRAINT "resume_results_owner_id_upload_id_resume_uploads_owner_id_id_fk" FOREIGN KEY ("owner_id","upload_id") REFERENCES "public"."resume_uploads"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_result_command" ON "resume_results" USING btree ("command_id");