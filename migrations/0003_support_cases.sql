CREATE TABLE "support_cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_by" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "support_cases_reason_present" CHECK (length(btrim("support_cases"."reason")) BETWEEN 10 AND 500),
	CONSTRAINT "support_cases_window" CHECK ("support_cases"."expires_at" > "support_cases"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_cases_owner_open_idx" ON "support_cases" USING btree ("owner_id","expires_at");