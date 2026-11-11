ALTER TABLE "resume_uploads" ADD COLUMN "target_role" text;--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD COLUMN "version_group_id" uuid;--> statement-breakpoint
UPDATE "resume_uploads" SET "version_group_id" = "id";--> statement-breakpoint
ALTER TABLE "resume_uploads" ALTER COLUMN "version_group_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD COLUMN "version_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_owner_group_version" ON "resume_uploads" USING btree ("owner_id","version_group_id","version_number");--> statement-breakpoint
CREATE INDEX "resume_upload_owner_role_created" ON "resume_uploads" USING btree ("owner_id","target_role","created_at");--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_upload_target_role_valid" CHECK ("resume_uploads"."target_role" IS NULL OR (length(btrim("resume_uploads"."target_role")) BETWEEN 1 AND 80 AND "resume_uploads"."target_role" = btrim("resume_uploads"."target_role")));--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_upload_version_number_valid" CHECK ("resume_uploads"."version_number" >= 1);