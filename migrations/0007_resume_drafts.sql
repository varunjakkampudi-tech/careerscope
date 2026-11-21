CREATE TABLE "resume_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_role" text,
	"template" text NOT NULL,
	"content" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_drafts_revision_positive" CHECK ("resume_drafts"."revision" > 0),
	CONSTRAINT "resume_drafts_template_valid" CHECK ("resume_drafts"."template" IN ('classic', 'modern', 'compact')),
	CONSTRAINT "resume_drafts_title_bounded" CHECK (length(btrim("resume_drafts"."title")) BETWEEN 1 AND 120 AND "resume_drafts"."title" = btrim("resume_drafts"."title")),
	CONSTRAINT "resume_drafts_target_role_bounded" CHECK ("resume_drafts"."target_role" IS NULL OR (length(btrim("resume_drafts"."target_role")) BETWEEN 1 AND 80 AND "resume_drafts"."target_role" = btrim("resume_drafts"."target_role")))
);
--> statement-breakpoint
ALTER TABLE "resume_drafts" ADD CONSTRAINT "resume_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resume_drafts_owner_id" ON "resume_drafts" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "resume_drafts_owner_updated" ON "resume_drafts" USING btree ("owner_id","updated_at","id");