ALTER TABLE "report_runs" ADD COLUMN "report_locale" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "report_locale" text DEFAULT 'ru' NOT NULL;--> statement-breakpoint
-- Формат нумерации, совпадающий с прежним умолчанием, удаляется: формат берётся по языку отчёта (§45.4).
UPDATE "templates"
   SET "pdf_options" = jsonb_set("pdf_options", '{pageNumbers}', ("pdf_options"->'pageNumbers') - 'format')
 WHERE "pdf_options"->'pageNumbers'->>'format' = 'Стр. {page} из {pages}';
