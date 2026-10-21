CREATE TABLE "template_editors" (
	"template_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "template_editors_template_id_user_id_pk" PRIMARY KEY("template_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "template_editors" ADD CONSTRAINT "template_editors_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_editors" ADD CONSTRAINT "template_editors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "template_editors_user_idx" ON "template_editors" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "templates_owner_idx" ON "templates" USING btree ("owner_id");