CREATE TABLE "template_edit_locks" (
	"template_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_edit_locks" ADD CONSTRAINT "template_edit_locks_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_edit_locks" ADD CONSTRAINT "template_edit_locks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;