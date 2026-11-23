CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_searches_name_valid" CHECK (length(btrim("saved_searches"."name")) BETWEEN 1 AND 80 AND "saved_searches"."name" = btrim("saved_searches"."name")),
	CONSTRAINT "saved_searches_request_bounded" CHECK (jsonb_typeof("saved_searches"."request") = 'object' AND octet_length("saved_searches"."request"::text) <= 8192)
);
--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX "saved_searches_owner_created" ON "saved_searches" USING btree ("owner_id","created_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "saved_searches_owner_name" ON "saved_searches" USING btree ("owner_id",lower("name"));
