CREATE TABLE "template_charts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort_order" integer NOT NULL,
	"config" jsonb NOT NULL,
	CONSTRAINT "template_charts_template_id_key_unique" UNIQUE("template_id","key")
);
--> statement-breakpoint
ALTER TABLE "template_charts" ADD CONSTRAINT "template_charts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;