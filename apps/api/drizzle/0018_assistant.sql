CREATE TABLE "assistant_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"api_key_enc" text,
	"extra_instructions" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_settings_singleton" CHECK ("assistant_settings"."id" = 1)
);
