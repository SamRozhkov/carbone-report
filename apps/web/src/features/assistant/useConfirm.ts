import { useEffect, useRef, useState } from 'react';

/** Вопрос автору посреди действия формирования: ask() ждёт ответа в диалоге карточки. */
export function useConfirm(mounted: () => boolean) {
  // Ожидающее подтверждение: резолвер промиса, которого ждёт действие.
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const ref = useRef(pending);
  ref.current = pending;
  // Карточка снята с открытым вопросом — ответ «нет», действие не повисает.
  useEffect(() => () => ref.current?.(false), []);

  const ask = () =>
    new Promise<boolean>((resolve) => {
      // Карточка уже снята (отложенное применение) — спросить негде, ничего не меняем.
      if (!mounted()) return resolve(false);
      setPending(() => resolve);
    });
  const answer = (ok: boolean) => {
    pending?.(ok);
    setPending(null);
  };
  return { open: pending !== null, ask, answer };
}
