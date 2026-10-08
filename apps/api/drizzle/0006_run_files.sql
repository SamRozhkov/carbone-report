CREATE TABLE "report_run_files" (
	"run_id" uuid NOT NULL,
	"format" text NOT NULL,
	"file_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_run_files_run_id_format_pk" PRIMARY KEY("run_id","format")
);
--> statement-breakpoint
ALTER TABLE "report_runs" ALTER COLUMN "output_format" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "report_run_files" ADD CONSTRAINT "report_run_files_run_id_report_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."report_runs"("id") ON DELETE cascade ON UPDATE no action;