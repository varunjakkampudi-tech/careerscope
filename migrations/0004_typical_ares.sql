CREATE TABLE "lead_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"notes_changed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_history_status_valid" CHECK ("lead_history"."status" IN ('saved', 'archived')),
	CONSTRAINT "lead_history_notes_changed_valid" CHECK ("lead_history"."notes_changed" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "saved_leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"data" jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'saved' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_revision_positive" CHECK ("saved_leads"."revision" > 0),
	CONSTRAINT "lead_status_valid" CHECK ("saved_leads"."status" IN ('saved', 'archived')),
	CONSTRAINT "lead_notes_bounded" CHECK (length("saved_leads"."notes") <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_owner_id" ON "saved_leads" USING btree ("owner_id","id");--> statement-breakpoint
ALTER TABLE "lead_history" ADD CONSTRAINT "lead_history_owner_id_lead_id_saved_leads_owner_id_id_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."saved_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_leads" ADD CONSTRAINT "saved_leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_history_revision" ON "lead_history" USING btree ("owner_id","lead_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_owner_fingerprint" ON "saved_leads" USING btree ("owner_id","fingerprint");--> statement-breakpoint
CREATE INDEX "lead_owner_status_created" ON "saved_leads" USING btree ("owner_id","status","created_at","id");