CREATE TABLE "gost_sign_pending" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"cert_der" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	"hash_alg" text NOT NULL,
	"draft_path" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_run_signatures" ADD COLUMN "method" text DEFAULT 'p12' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_run_signatures" ADD COLUMN "sig_path" text;--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "sign_method" text;--> statement-breakpoint
ALTER TABLE "gost_sign_pending" ADD CONSTRAINT "gost_sign_pending_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gost_sign_pending" ADD CONSTRAINT "gost_sign_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_run_signatures" ADD CONSTRAINT "report_run_signatures_method_check" CHECK ("report_run_signatures"."method" in ('p12', 'gost'));--> statement-breakpoint
-- Запуски до 2.11.0 с разрешённой подписью подписываются .p12 (§42.1).
UPDATE "report_runs" SET "sign_method" = 'p12' WHERE "signature_position" IS NOT NULL;