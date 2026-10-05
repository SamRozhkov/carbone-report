/** Нарушение уникального ограничения Postgres (23505), в том числе внутри cause драйвера. */
export const isUniqueViolation = (e: unknown): boolean =>
  (e as { code?: string })?.code === '23505' ||
  (e as { cause?: { code?: string } })?.cause?.code === '23505';
