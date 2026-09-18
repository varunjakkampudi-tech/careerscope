CREATE INDEX "execution_status_lease" ON "command_executions" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "outbox_published_created" ON "outbox_events" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "session_owner" ON "sessions" USING btree ("owner_id");