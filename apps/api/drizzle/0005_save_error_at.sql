ALTER TABLE "templates" ADD COLUMN "last_save_error_at" timestamp with time zone;--> statement-breakpoint
UPDATE "templates" SET "last_save_error_at" = now() WHERE "last_save_error" IS NOT NULL;
