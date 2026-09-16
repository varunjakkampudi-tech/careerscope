CREATE TABLE "resume_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"bucket" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"object_version" text,
	"command_id" uuid,
	"status" text DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_upload_key_valid" CHECK ("resume_uploads"."idempotency_key" ~ '^[a-zA-Z0-9_-]{8,128}$'),
	CONSTRAINT "resume_upload_bucket_valid" CHECK ("resume_uploads"."bucket" ~ '^[a-z][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "resume_upload_sha_valid" CHECK ("resume_uploads"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "resume_upload_bytes_valid" CHECK ("resume_uploads"."bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "resume_upload_type_valid" CHECK ("resume_uploads"."content_type" IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "resume_upload_state_valid" CHECK (
      ("resume_uploads"."status" = 'uploading' AND "resume_uploads"."object_version" IS NULL AND "resume_uploads"."command_id" IS NULL)
      OR ("resume_uploads"."status" = 'queued' AND "resume_uploads"."object_version" IS NOT NULL
        AND length("resume_uploads"."object_version") BETWEEN 1 AND 1024 AND "resume_uploads"."object_version" <> 'null'
        AND "resume_uploads"."command_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_uploads_command_id_outbox_events_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_owner_key" ON "resume_uploads" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_command" ON "resume_uploads" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "resume_upload_owner_created" ON "resume_uploads" USING btree ("owner_id","created_at","id");