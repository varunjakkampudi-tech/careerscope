CREATE TABLE "job_sightings" (
	"owner_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sightings" integer DEFAULT 1 NOT NULL,
	"first_posted_at" timestamp with time zone,
	"last_posted_at" timestamp with time zone,
	"repost_count" integer DEFAULT 0 NOT NULL,
	"last_run_id" uuid,
	CONSTRAINT "job_sightings_owner_id_fingerprint_pk" PRIMARY KEY("owner_id","fingerprint"),
	CONSTRAINT "sighting_count_positive" CHECK ("job_sightings"."sightings" > 0),
	CONSTRAINT "sighting_reposts_valid" CHECK ("job_sightings"."repost_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lead_history" DROP CONSTRAINT "lead_history_status_valid";--> statement-breakpoint
ALTER TABLE "saved_leads" DROP CONSTRAINT "lead_status_valid";--> statement-breakpoint
ALTER TABLE "saved_leads" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "job_sightings" ADD CONSTRAINT "job_sightings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sighting_owner_last_seen" ON "job_sightings" USING btree ("owner_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "sighting_owner_company" ON "job_sightings" USING btree ("owner_id","company");--> statement-breakpoint
ALTER TABLE "lead_history" ADD CONSTRAINT "lead_history_status_valid" CHECK ("lead_history"."status" IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'));--> statement-breakpoint
ALTER TABLE "saved_leads" ADD CONSTRAINT "lead_status_valid" CHECK ("saved_leads"."status" IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'archived'));