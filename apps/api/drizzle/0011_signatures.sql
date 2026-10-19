CREATE TABLE "report_run_signatures" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"signer_cn" text NOT NULL,
	"fingerprint" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"timestamped" boolean NOT NULL,
	"file_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_certificates" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"p12_enc" text NOT NULL,
	"subject_cn" text NOT NULL,
	"issuer" text NOT NULL,
	"serial" text NOT NULL,
	"fingerprint" text NOT NULL,
	"key_alg" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "signature_position" text;--> statement-breakpoint
ALTER TABLE "report_run_signatures" ADD CONSTRAINT "report_run_signatures_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_run_signatures" ADD CONSTRAINT "report_run_signatures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_certificates" ADD CONSTRAINT "user_certificates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;