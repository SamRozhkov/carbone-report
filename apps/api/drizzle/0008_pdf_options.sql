CREATE TABLE "template_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"placement" text NOT NULL,
	"sort_order" integer NOT NULL,
	"name" text NOT NULL,
	"file_path" text NOT NULL,
	"size" integer NOT NULL,
	"pages" integer NOT NULL,
	"pdfa" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "pdf_options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "template_attachments" ADD CONSTRAINT "template_attachments_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;