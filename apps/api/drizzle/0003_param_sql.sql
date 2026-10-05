ALTER TABLE "template_params" ADD COLUMN "sql" text;--> statement-breakpoint
ALTER TABLE "template_params" ADD COLUMN "multiple" boolean DEFAULT false NOT NULL;