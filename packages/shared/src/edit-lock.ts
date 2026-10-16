import { z } from 'zod';

/** Блокировка редактирования шаблона (§38.1): действует 60 с с последнего продления. */
export const EDIT_LOCK_TTL_SECONDS = 60;
/** Браузер продлевает блокировку раз в 20 с (§38.3). */
export const EDIT_LOCK_HEARTBEAT_MS = 20_000;

/** Номер вкладки «Документ» — случайный UUID, новый на каждое открытие вкладки. */
export const EditLockHolder = z.uuid();

export const EditLockBody = z.object({ holder: EditLockHolder, acquire: z.boolean() });
export type EditLockBody = z.infer<typeof EditLockBody>;

export const EditLockTakeoverBody = z.object({ holder: EditLockHolder });
export type EditLockTakeoverBody = z.infer<typeof EditLockTakeoverBody>;

export const EditLockHolderQuery = z.object({ holder: EditLockHolder });

export const EditLockState = z.discriminatedUnion('state', [
  z.object({ state: z.literal('mine') }),
  z.object({
    state: z.literal('other'),
    user: z.object({ id: z.string(), login: z.string() }),
    /** Начало блокировки, ISO-8601. */
    since: z.string(),
    /** Блокировка у другой вкладки той же учётной записи. */
    sameUser: z.boolean(),
  }),
  z.object({ state: z.literal('free') }),
]);
export type EditLockState = z.infer<typeof EditLockState>;

export const TemplateEditingBy = z.object({ login: z.string() });
export type TemplateEditingBy = z.infer<typeof TemplateEditingBy>;
