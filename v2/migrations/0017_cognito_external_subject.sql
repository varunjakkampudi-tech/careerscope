ALTER TABLE "users" ADD COLUMN "external_subject" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_subject_unique" ON "users" USING btree ("external_subject");
