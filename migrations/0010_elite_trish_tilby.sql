ALTER TABLE "resume_uploads" DROP CONSTRAINT "resume_upload_state_valid";--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_upload_state_valid" CHECK (
      ("resume_uploads"."status" IN ('uploading', 'cancelling', 'cancelled') AND "resume_uploads"."object_version" IS NULL AND "resume_uploads"."command_id" IS NULL)
      OR ("resume_uploads"."status" = 'queued' AND "resume_uploads"."object_version" IS NOT NULL
        AND length("resume_uploads"."object_version") BETWEEN 1 AND 1024 AND "resume_uploads"."object_version" <> 'null'
        AND "resume_uploads"."command_id" IS NOT NULL));