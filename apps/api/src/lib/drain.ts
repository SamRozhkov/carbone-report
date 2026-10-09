/**
 * Остановка API: ждём активные отчёты не дольше срока и закрываем сервер.
 * Возвращает 'idle', если отчёты закончились сами, и 'timeout', если вышел срок.
 */
export async function drainAndClose(opts: {
  idle: () => Promise<void>;
  active: () => number;
  timeoutMs: number;
  close: () => Promise<void>;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}): Promise<'idle' | 'timeout'> {
  opts.log.info({ active: opts.active() }, 'остановка: ждём активные отчёты');
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    opts.idle().then(() => 'idle' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (result === 'timeout') {
    opts.log.warn(
      { active: opts.active(), timeoutMs: opts.timeoutMs },
      'остановка: срок ожидания вышел, закрываем с активными отчётами',
    );
  } else {
    opts.log.info({}, 'остановка: активных отчётов нет');
  }
  await opts.close();
  return result;
}
