CREATE TABLE "resume_version_groups" (
	"owner_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"target_role" text NOT NULL,
	"next_version_number" integer DEFAULT 2 NOT NULL,
	CONSTRAINT "resume_version_groups_owner_id_id_pk" PRIMARY KEY("owner_id","id"),
	CONSTRAINT "resume_version_group_role_valid" CHECK (length(btrim("resume_version_groups"."target_role")) BETWEEN 1 AND 80 AND "resume_version_groups"."target_role" = btrim("resume_version_groups"."target_role")),
	CONSTRAINT "resume_version_group_next_number_valid" CHECK ("resume_version_groups"."next_version_number" >= 2)
);
--> statement-breakpoint
ALTER TABLE "resume_version_groups" ADD CONSTRAINT "resume_version_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "resume_version_groups" ("owner_id", "id", "target_role", "next_version_number")
SELECT "owner_id", "version_group_id", max("target_role"), max("version_number") + 1
FROM "resume_uploads"
WHERE "target_role" IS NOT NULL
GROUP BY "owner_id", "version_group_id";
