CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_owner_id" uuid,
	"target_type" text,
	"target_id" text,
	"request_id" uuid,
	"outcome" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "audit_outcome_valid" CHECK ("audit_events"."outcome" IN ('allowed', 'denied', 'failed')),
	CONSTRAINT "audit_detail_bounded" CHECK ("audit_events"."detail" IS NULL OR octet_length("audit_events"."detail"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "error_diagnostics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid,
	"owner_id" uuid,
	"run_id" uuid,
	"execution_id" uuid,
	"service" text NOT NULL,
	"revision" text,
	"route" text,
	"method" text,
	"status" integer NOT NULL,
	"error_code" text NOT NULL,
	"error_class" text,
	"message" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diagnostic_status_valid" CHECK ("error_diagnostics"."status" BETWEEN 100 AND 599),
	CONSTRAINT "diagnostic_message_bounded" CHECK (length("error_diagnostics"."message") <= 1024)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_target_owner_id_users_id_fk" FOREIGN KEY ("target_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_diagnostics" ADD CONSTRAINT "error_diagnostics_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_actor_created" ON "audit_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_target_created" ON "audit_events" USING btree ("target_owner_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_action_created" ON "audit_events" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "diagnostic_owner_created" ON "error_diagnostics" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "diagnostic_code_created" ON "error_diagnostics" USING btree ("error_code","created_at");--> statement-breakpoint
CREATE INDEX "diagnostic_request" ON "error_diagnostics" USING btree ("request_id");