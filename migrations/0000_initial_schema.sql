CREATE OR REPLACE FUNCTION public.careerscope_valid_lead_tags(tag_values text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
SET search_path = pg_catalog
AS $function$
  SELECT cardinality(tag_values) <= 12
    AND coalesce(array_ndims(tag_values), 0) <= 1
    AND array_position(tag_values, NULL) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(tag_values) AS item(tag)
      WHERE item.tag IS NULL
        OR char_length(item.tag) NOT BETWEEN 1 AND 32
        OR item.tag <> btrim(
          item.tag,
          U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
        )
        OR position(',' IN item.tag) > 0
        OR item.tag ~ '[[:cntrl:]]'
    )
    AND (
      SELECT count(*) = count(DISTINCT lower(item.tag))
      FROM unnest(tag_values) AS item(tag)
    )
$function$;--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE "account_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"document" text NOT NULL,
	"version" text NOT NULL,
	"accepted" boolean NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence" bigserial NOT NULL,
	CONSTRAINT "account_acceptances_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "account_acceptance_document_valid" CHECK ("account_acceptances"."document" IN ('terms', 'privacy_notice', 'marketing')),
	CONSTRAINT "account_acceptance_version_nonempty" CHECK (length(btrim("account_acceptances"."version")) BETWEEN 1 AND 128),
	CONSTRAINT "account_acceptance_required_grant" CHECK ("account_acceptances"."document" = 'marketing' OR "account_acceptances"."accepted")
);
--> statement-breakpoint
CREATE TABLE "email_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"current_email_hash" text NOT NULL,
	"new_email" text NOT NULL,
	"current_challenge_id" uuid NOT NULL,
	"current_digest" text NOT NULL,
	"current_attempts" integer DEFAULT 0 NOT NULL,
	"current_verified_at" timestamp with time zone,
	"new_challenge_id" uuid NOT NULL,
	"new_digest" text NOT NULL,
	"new_attempts" integer DEFAULT 0 NOT NULL,
	"new_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_change_requests_current_challenge_id_unique" UNIQUE("current_challenge_id"),
	CONSTRAINT "email_change_requests_new_challenge_id_unique" UNIQUE("new_challenge_id"),
	CONSTRAINT "email_change_current_hash_hex" CHECK ("email_change_requests"."current_email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_change_current_digest_hex" CHECK ("email_change_requests"."current_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_change_new_digest_hex" CHECK ("email_change_requests"."new_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_change_current_attempts_bounded" CHECK ("email_change_requests"."current_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "email_change_new_attempts_bounded" CHECK ("email_change_requests"."new_attempts" BETWEEN 0 AND 5),
	CONSTRAINT "email_change_address_present" CHECK (length(btrim("email_change_requests"."new_email")) BETWEEN 3 AND 254),
	CONSTRAINT "email_change_expiry_after_creation" CHECK ("email_change_requests"."expires_at" > "email_change_requests"."created_at")
);
--> statement-breakpoint
CREATE TABLE "email_otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"digest" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"intent" text DEFAULT 'sign-in' NOT NULL,
	"terms_version" text,
	"privacy_version" text,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"marketing_version" text,
	"age_screen_passed" boolean,
	CONSTRAINT "email_otp_email_hash_hex" CHECK ("email_otp_challenges"."email_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_otp_digest_hex" CHECK ("email_otp_challenges"."digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "email_otp_attempts_bounded" CHECK ("email_otp_challenges"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "email_otp_intent_valid" CHECK ("email_otp_challenges"."intent" IN ('sign-in', 'sign-up')),
	CONSTRAINT "email_otp_signup_acceptance_complete" CHECK (("email_otp_challenges"."intent" = 'sign-in' AND "email_otp_challenges"."terms_version" IS NULL AND "email_otp_challenges"."privacy_version" IS NULL AND NOT "email_otp_challenges"."marketing_opt_in") OR ("email_otp_challenges"."intent" = 'sign-up' AND "email_otp_challenges"."terms_version" IS NOT NULL AND "email_otp_challenges"."privacy_version" IS NOT NULL)),
	CONSTRAINT "email_otp_marketing_version_required" CHECK (NOT "email_otp_challenges"."marketing_opt_in" OR "email_otp_challenges"."marketing_version" IS NOT NULL),
	CONSTRAINT "email_otp_expiry_after_creation" CHECK ("email_otp_challenges"."expires_at" > "email_otp_challenges"."created_at")
);
--> statement-breakpoint
CREATE TABLE "employer_application_acknowledgements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"reference" text,
	CONSTRAINT "employer_ack_source_bounded" CHECK (length(btrim("employer_application_acknowledgements"."source")) BETWEEN 1 AND 160),
	CONSTRAINT "employer_ack_reference_bounded" CHECK ("employer_application_acknowledgements"."reference" IS NULL OR length("employer_application_acknowledgements"."reference") <= 240)
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "command_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"fence" integer NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "in_app_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"reminder_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "interview_round_documents" (
	"owner_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"reminder_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_round_title_bounded" CHECK (length(btrim("interview_rounds"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "interview_round_timezone_bounded" CHECK (length("interview_rounds"."time_zone") BETWEEN 1 AND 128),
	CONSTRAINT "interview_round_format_valid" CHECK ("interview_rounds"."format" IN ('video', 'phone', 'onsite', 'other')),
	CONSTRAINT "interview_round_status_valid" CHECK ("interview_rounds"."status" IN ('scheduled', 'completed', 'cancelled')),
	CONSTRAINT "interview_round_contacts_array" CHECK (jsonb_typeof("interview_rounds"."contacts") = 'array'),
	CONSTRAINT "interview_round_checklist_array" CHECK (jsonb_typeof("interview_rounds"."checklist") = 'array'),
	CONSTRAINT "interview_round_notes_bounded" CHECK (length("interview_rounds"."notes") <= 10000),
	CONSTRAINT "interview_round_revision_positive" CHECK ("interview_rounds"."revision" > 0),
	CONSTRAINT "interview_round_reminder_before_start" CHECK ("interview_rounds"."reminder_at" IS NULL OR "interview_rounds"."reminder_at" < "interview_rounds"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "job_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_feedback_reason_valid" CHECK ("job_feedback"."reason" IN ('irrelevant', 'duplicate', 'incorrect', 'unavailable', 'suspicious'))
);
--> statement-breakpoint
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
CREATE TABLE "search_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"notes_changed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_status" text,
	"application_evidence_changed" boolean DEFAULT false NOT NULL,
	"application_evidence" jsonb,
	"tags_changed" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "lead_history_status_valid" CHECK ("lead_history"."status" IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')),
	CONSTRAINT "lead_history_previous_status_valid" CHECK ("lead_history"."previous_status" IS NULL OR "lead_history"."previous_status" IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')),
	CONSTRAINT "lead_history_notes_changed_valid" CHECK ("lead_history"."notes_changed" IN (0, 1)),
	CONSTRAINT "lead_history_tags_valid" CHECK (public.careerscope_valid_lead_tags("lead_history"."tags")),
	CONSTRAINT "lead_history_application_evidence_valid" CHECK ("lead_history"."application_evidence" IS NULL OR (
        jsonb_typeof("lead_history"."application_evidence") = 'object'
        AND "lead_history"."application_evidence" ?& ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']
        AND ("lead_history"."application_evidence" - ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']::text[]) = '{}'::jsonb
        AND jsonb_typeof("lead_history"."application_evidence"->'method') = 'string'
        AND length(btrim("lead_history"."application_evidence"->>'method')) BETWEEN 1 AND 120
        AND jsonb_typeof("lead_history"."application_evidence"->'appliedAt') = 'string'
        AND jsonb_typeof("lead_history"."application_evidence"->'confirmation') = 'string'
        AND "lead_history"."application_evidence"->>'confirmation' IN ('unknown', 'received', 'not_received')
        AND jsonb_typeof("lead_history"."application_evidence"->'source') = 'string'
        AND length(btrim("lead_history"."application_evidence"->>'source')) <= 160
        AND jsonb_typeof("lead_history"."application_evidence"->'confidence') = 'string'
        AND "lead_history"."application_evidence"->>'confidence' IN ('unknown', 'low', 'medium', 'high')
      ))
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
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"liveness_status" text DEFAULT 'unknown' NOT NULL,
	"liveness_checked_at" timestamp with time zone,
	"application_evidence" jsonb,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	CONSTRAINT "lead_revision_positive" CHECK ("saved_leads"."revision" > 0),
	CONSTRAINT "lead_status_valid" CHECK ("saved_leads"."status" IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')),
	CONSTRAINT "lead_application_evidence_valid" CHECK ("saved_leads"."application_evidence" IS NULL OR (
        jsonb_typeof("saved_leads"."application_evidence") = 'object'
        AND "saved_leads"."application_evidence" ?& ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']
        AND ("saved_leads"."application_evidence" - ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']::text[]) = '{}'::jsonb
        AND jsonb_typeof("saved_leads"."application_evidence"->'method') = 'string'
        AND length(btrim("saved_leads"."application_evidence"->>'method')) BETWEEN 1 AND 120
        AND jsonb_typeof("saved_leads"."application_evidence"->'appliedAt') = 'string'
        AND jsonb_typeof("saved_leads"."application_evidence"->'confirmation') = 'string'
        AND "saved_leads"."application_evidence"->>'confirmation' IN ('unknown', 'received', 'not_received')
        AND jsonb_typeof("saved_leads"."application_evidence"->'source') = 'string'
        AND length(btrim("saved_leads"."application_evidence"->>'source')) <= 160
        AND jsonb_typeof("saved_leads"."application_evidence"->'confidence') = 'string'
        AND "saved_leads"."application_evidence"->>'confidence' IN ('unknown', 'low', 'medium', 'high')
      )),
	CONSTRAINT "lead_liveness_status_valid" CHECK ("saved_leads"."liveness_status" IN ('unknown', 'live', 'stale')),
	CONSTRAINT "lead_notes_bounded" CHECK (length("saved_leads"."notes") <= 10000),
	CONSTRAINT "lead_tags_valid" CHECK (public.careerscope_valid_lead_tags("saved_leads"."tags"))
);
--> statement-breakpoint
CREATE TABLE "notification_dead_letters" (
	"event_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_dead_letters_pkey" PRIMARY KEY("event_id","channel"),
	CONSTRAINT "notification_dead_letters_attempts_check" CHECK ("notification_dead_letters"."attempts" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"event_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY("event_id","channel"),
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" IN ('in_app', 'email', 'web_push')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" IN ('pending', 'sending', 'delivered', 'dead_letter')),
	CONSTRAINT "notification_deliveries_attempts_check" CHECK ("notification_deliveries"."attempts" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"template" text NOT NULL,
	"locale" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_kind_check" CHECK ("notification_events"."kind" IN ('security', 'application', 'interview', 'marketing')),
	CONSTRAINT "notification_events_locale_check" CHECK ("notification_events"."locale" IN ('en', 'te', 'hi')),
	CONSTRAINT "notification_events_payload_check" CHECK (jsonb_typeof("notification_events"."payload") = 'object' AND octet_length("notification_events"."payload"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"interview_reminders_in_app_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"command" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "candidate_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scheduled_discovery_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "profile_revision_positive" CHECK ("candidate_profiles"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "resume_results" (
	"upload_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"status" text NOT NULL,
	"parsed" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_result_state_valid" CHECK (
      ("resume_results"."status" = 'parsed' AND "resume_results"."parsed" IS NOT NULL AND "resume_results"."error_code" IS NULL
        AND jsonb_typeof("resume_results"."parsed") = 'object' AND octet_length("resume_results"."parsed"::text) <= 1048576)
      OR ("resume_results"."status" = 'rejected' AND "resume_results"."parsed" IS NULL
        AND "resume_results"."error_code" IS NOT NULL AND "resume_results"."error_code" IN ('invalid_document', 'processing_failed')))
);
--> statement-breakpoint
CREATE TABLE "resume_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"bucket" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"object_version" text,
	"command_id" uuid,
	"status" text DEFAULT 'uploading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_upload_key_valid" CHECK ("resume_uploads"."idempotency_key" ~ '^[a-zA-Z0-9_-]{8,128}$'),
	CONSTRAINT "resume_upload_bucket_valid" CHECK ("resume_uploads"."bucket" ~ '^[a-z][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "resume_upload_sha_valid" CHECK ("resume_uploads"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "resume_upload_bytes_valid" CHECK ("resume_uploads"."bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "resume_upload_type_valid" CHECK ("resume_uploads"."content_type" IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
	CONSTRAINT "resume_upload_state_valid" CHECK (
      ("resume_uploads"."status" IN ('uploading', 'cancelling', 'cancelled') AND "resume_uploads"."object_version" IS NULL AND "resume_uploads"."command_id" IS NULL)
      OR ("resume_uploads"."status" = 'queued' AND "resume_uploads"."object_version" IS NOT NULL
        AND length("resume_uploads"."object_version") BETWEEN 1 AND 1024 AND "resume_uploads"."object_version" <> 'null'
        AND "resume_uploads"."command_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "search_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"matching_profile" jsonb,
	"profile_revision" integer,
	"source_outcomes" jsonb,
	CONSTRAINT "search_status_valid" CHECK ("search_runs"."status" IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
	CONSTRAINT "search_outcomes_bounded" CHECK ("search_runs"."source_outcomes" IS NULL OR (jsonb_typeof("search_runs"."source_outcomes") = 'array'
        AND jsonb_array_length("search_runs"."source_outcomes") BETWEEN 1 AND 5
        AND octet_length("search_runs"."source_outcomes"::text) <= 2048)),
	CONSTRAINT "search_partial_has_outcomes" CHECK ("search_runs"."status" <> 'partial' OR "search_runs"."source_outcomes" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "session_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_refresh_hash_hex" CHECK ("session_refresh_tokens"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"device_label" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email_verified_at" timestamp with time zone,
	"age_screen_passed" boolean,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "account_acceptance_owner_document_sequence" ON "account_acceptances" USING btree ("owner_id","document","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_change_owner" ON "email_change_requests" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX "email_change_expiration" ON "email_change_requests" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "email_otp_email_hash" ON "email_otp_challenges" USING btree ("email_hash");
--> statement-breakpoint
CREATE INDEX "email_otp_expiration" ON "email_otp_challenges" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "employer_ack_owner_lead_received" ON "employer_application_acknowledgements" USING btree ("owner_id","lead_id","received_at");
--> statement-breakpoint
CREATE INDEX "event_owner_run_sequence" ON "run_events" USING btree ("owner_id","run_id","sequence");
--> statement-breakpoint
CREATE INDEX "execution_status_lease" ON "command_executions" USING btree ("status","lease_until");
--> statement-breakpoint
CREATE UNIQUE INDEX "in_app_notification_reminder_unique" ON "in_app_notifications" USING btree ("owner_id","round_id","reminder_at");
--> statement-breakpoint
CREATE INDEX "in_app_notification_owner_created" ON "in_app_notifications" USING btree ("owner_id","created_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "interview_round_document_unique" ON "interview_round_documents" USING btree ("owner_id","round_id","upload_id");
--> statement-breakpoint
CREATE INDEX "interview_document_owner_upload" ON "interview_round_documents" USING btree ("owner_id","upload_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "interview_round_owner_id" ON "interview_rounds" USING btree ("owner_id","id");
--> statement-breakpoint
CREATE INDEX "interview_round_owner_lead_start" ON "interview_rounds" USING btree ("owner_id","lead_id","starts_at");
--> statement-breakpoint
CREATE INDEX "interview_round_due_reminder" ON "interview_rounds" USING btree ("reminder_at","id") WHERE "interview_rounds"."status" = 'scheduled' AND "interview_rounds"."reminder_at" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "job_feedback_owner_job" ON "job_feedback" USING btree ("owner_id","job_id");
--> statement-breakpoint
CREATE INDEX "job_feedback_created" ON "job_feedback" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "sighting_owner_last_seen" ON "job_sightings" USING btree ("owner_id","last_seen_at");
--> statement-breakpoint
CREATE INDEX "sighting_owner_company" ON "job_sightings" USING btree ("owner_id","company");
--> statement-breakpoint
CREATE UNIQUE INDEX "run_job_fingerprint" ON "search_jobs" USING btree ("run_id","fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "job_owner_id" ON "search_jobs" USING btree ("owner_id","id");
--> statement-breakpoint
CREATE INDEX "job_owner_run" ON "search_jobs" USING btree ("owner_id","run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_history_revision" ON "lead_history" USING btree ("owner_id","lead_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_owner_fingerprint" ON "saved_leads" USING btree ("owner_id","fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "lead_owner_id" ON "saved_leads" USING btree ("owner_id","id");
--> statement-breakpoint
CREATE INDEX "lead_owner_status_created" ON "saved_leads" USING btree ("owner_id","status","created_at","id");
--> statement-breakpoint
CREATE INDEX "lead_liveness_checked" ON "saved_leads" USING btree ("liveness_checked_at");
--> statement-breakpoint
CREATE INDEX "notification_delivery_pending" ON "notification_deliveries" USING btree ("available_at","event_id") WHERE "notification_deliveries"."status" = 'pending';
--> statement-breakpoint
CREATE INDEX "outbox_published_created" ON "outbox_events" USING btree ("published_at","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "resume_result_command" ON "resume_results" USING btree ("command_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_owner_key" ON "resume_uploads" USING btree ("owner_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_command" ON "resume_uploads" USING btree ("command_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "resume_upload_owner_id" ON "resume_uploads" USING btree ("owner_id","id");
--> statement-breakpoint
CREATE INDEX "resume_upload_owner_created" ON "resume_uploads" USING btree ("owner_id","created_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "search_owner_key" ON "search_runs" USING btree ("owner_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "search_owner_id" ON "search_runs" USING btree ("owner_id","id");
--> statement-breakpoint
CREATE INDEX "search_owner_created" ON "search_runs" USING btree ("owner_id","created_at");
--> statement-breakpoint
CREATE INDEX "session_refresh_family" ON "session_refresh_tokens" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "session_refresh_expiry" ON "session_refresh_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE INDEX "session_owner" ON "sessions" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX "session_family_expiry" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "account_acceptances" ADD CONSTRAINT "account_acceptances_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "email_change_requests" ADD CONSTRAINT "email_change_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "employer_application_acknowledgements" ADD CONSTRAINT "employer_ack_owner_lead_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."saved_leads"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_owner_id_run_id_search_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."search_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "command_executions" ADD CONSTRAINT "command_executions_id_outbox_events_id_fk" FOREIGN KEY ("id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_owner_id_round_id_interview_rounds_owner_id_id_fk" FOREIGN KEY ("owner_id","round_id") REFERENCES "public"."interview_rounds"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_round_documents" ADD CONSTRAINT "interview_round_documents_owner_id_round_id_interview_rounds_owner_id_id_fk" FOREIGN KEY ("owner_id","round_id") REFERENCES "public"."interview_rounds"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_round_documents" ADD CONSTRAINT "interview_round_documents_owner_id_upload_id_resume_uploads_owner_id_id_fk" FOREIGN KEY ("owner_id","upload_id") REFERENCES "public"."resume_uploads"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interview_rounds" ADD CONSTRAINT "interview_rounds_owner_id_lead_id_saved_leads_owner_id_id_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."saved_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_owner_id_job_id_search_jobs_owner_id_id_fk" FOREIGN KEY ("owner_id","job_id") REFERENCES "public"."search_jobs"("owner_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_sightings" ADD CONSTRAINT "job_sightings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_jobs" ADD CONSTRAINT "search_jobs_owner_id_run_id_search_runs_owner_id_id_fk" FOREIGN KEY ("owner_id","run_id") REFERENCES "public"."search_runs"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "lead_history" ADD CONSTRAINT "lead_history_owner_id_lead_id_saved_leads_owner_id_id_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."saved_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saved_leads" ADD CONSTRAINT "saved_leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_dead_letters" ADD CONSTRAINT "notification_dead_letters_event_id_channel_fkey" FOREIGN KEY ("event_id","channel") REFERENCES "public"."notification_deliveries"("event_id","channel") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resume_results" ADD CONSTRAINT "resume_results_command_id_outbox_events_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resume_results" ADD CONSTRAINT "resume_results_owner_id_upload_id_resume_uploads_owner_id_id_fk" FOREIGN KEY ("owner_id","upload_id") REFERENCES "public"."resume_uploads"("owner_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resume_uploads" ADD CONSTRAINT "resume_uploads_command_id_outbox_events_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."outbox_events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "session_refresh_tokens" ADD CONSTRAINT "session_refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
