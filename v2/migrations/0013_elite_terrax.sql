CREATE TABLE "debug_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"target_owner_id" uuid,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "debug_session_reason_bounded" CHECK (length("debug_sessions"."reason") BETWEEN 3 AND 500),
	CONSTRAINT "debug_session_bounded" CHECK ("debug_sessions"."expires_at" > "debug_sessions"."started_at")
);
--> statement-breakpoint
ALTER TABLE "error_diagnostics" ADD COLUMN "fingerprint" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "command_executions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_executions" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "command_executions" ADD COLUMN "worker" text;--> statement-breakpoint
ALTER TABLE "debug_sessions" ADD CONSTRAINT "debug_sessions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debug_sessions" ADD CONSTRAINT "debug_sessions_target_owner_id_users_id_fk" FOREIGN KEY ("target_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "debug_session_expiry" ON "debug_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "diagnostic_fingerprint_created" ON "error_diagnostics" USING btree ("fingerprint","created_at");