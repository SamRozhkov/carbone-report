/** Нарушение уникального ограничения Postgres (23505), в том числе внутри cause драйвера. */
export const isUniqueViolation = (e: unknown): boolean =>
  (e as { code?: string })?.code === '23505' ||
  (e as { cause?: { code?: string } })?.cause?.code === '23505';

/** Нарушение внешнего ключа Postgres (23503): ссылаемая запись удалена параллельно. */
export const isForeignKeyViolation = (e: unknown): boolean =>
  (e as { code?: string })?.code === '23503' ||
  (e as { cause?: { code?: string } })?.cause?.code === '23503';

/** Истёк lock_timeout Postgres (55P03): блокировку не дождались. */
export const isLockTimeout = (e: unknown): boolean =>
  (e as { code?: string })?.code === '55P03' ||
  (e as { cause?: { code?: string } })?.cause?.code === '55P03';
