ALTER TABLE "users" DROP CONSTRAINT "users_login_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_lower_uq" ON "users" USING btree (lower("login"));