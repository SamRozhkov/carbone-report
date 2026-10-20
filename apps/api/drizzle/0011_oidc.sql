CREATE TABLE "oidc_identities" (
 "issuer" text NOT NULL, "subject" text NOT NULL,
 "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 PRIMARY KEY ("issuer", "subject")
);
--> statement-breakpoint
CREATE INDEX "oidc_identities_user_idx" ON "oidc_identities" ("user_id");
--> statement-breakpoint
CREATE TABLE "oidc_sessions" (
 "id" uuid PRIMARY KEY, "issuer" text NOT NULL, "subject" text NOT NULL,
 "provider_sid" text, "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "expires_at" timestamptz NOT NULL, "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "oidc_sessions_provider_idx" ON "oidc_sessions" ("issuer", "provider_sid");
--> statement-breakpoint
CREATE INDEX "oidc_sessions_subject_idx" ON "oidc_sessions" ("issuer", "subject");
