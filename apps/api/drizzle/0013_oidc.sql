CREATE TABLE "oidc_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "oidc_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "oidc_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"provider_sid" text,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_login_unique";--> statement-breakpoint
ALTER TABLE "oidc_identities" ADD CONSTRAINT "oidc_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_identities_user_idx" ON "oidc_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oidc_sessions_provider_idx" ON "oidc_sessions" USING btree ("issuer","provider_sid");--> statement-breakpoint
CREATE INDEX "oidc_sessions_subject_idx" ON "oidc_sessions" USING btree ("issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_lower_uq" ON "users" USING btree (lower("login"));