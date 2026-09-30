ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "phone" text;
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone") WHERE "phone" IS NOT NULL;
