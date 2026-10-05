ALTER TABLE "datasources" ADD COLUMN "ssl_mode" text DEFAULT 'disable' NOT NULL;--> statement-breakpoint
ALTER TABLE "datasources" ADD COLUMN "ssl_ca" text;--> statement-breakpoint
UPDATE "datasources" SET "ssl_mode" = CASE WHEN "ssl" THEN 'require' ELSE 'disable' END;--> statement-breakpoint
ALTER TABLE "datasources" DROP COLUMN "ssl";
