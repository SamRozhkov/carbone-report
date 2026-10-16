import { EDIT_LOCK_HEARTBEAT_MS, type EditLockState } from '@carbone-reports/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, releaseEditLock } from '../../../api/endpoints';

export interface EditLock {
  holder: string;
  /** null — первый ответ ещё не пришёл. */
  state: EditLockState | null;
  /** Правку забрал другой: логин; сбрасывается при начале редактирования. */
  lostTo: string | null;
  /** Три продления подряд не удались. */
  offline: boolean;
  editing: boolean;
  start(): Promise<void>;
  takeover(): Promise<void>;
}

const FAILS_BEFORE_OFFLINE = 3;

/**
 * Блокировка редактирования для вкладки «Документ» (§38.3).
 * enabled=false — блокировку не берём (страница шаблона открыта не на «Документе» и она ещё не посещалась).
 */
export function useEditLock(templateId: string, enabled = true): EditLock {
  const [holder] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<EditLockState | null>(null);
  const [lostTo, setLostTo] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const stateRef = useRef<EditLockState | null>(null);
  const fails = useRef(0);
  const alive = useRef(true);
  // Номер запроса: ответ, отправленный раньше уже применённого, устарел (продление в полёте во время перехвата).
  const seq = useRef(0);
  const appliedSeq = useRef(0);

  const apply = useCallback((next: EditLockState, n: number) => {
    if (n < appliedSeq.current) return;
    appliedSeq.current = n;
    const prev = stateRef.current;
    if (prev?.state === 'mine' && next.state === 'other') setLostTo(next.user.login);
    if (next.state === 'mine') setLostTo(null);
    stateRef.current = next;
    setState(next);
  }, []);

  const call = useCallback(
    async (acquire: boolean) => {
      const n = ++seq.current;
      try {
        const next = await api.templates.editLock(templateId, { holder, acquire });
        fails.current = 0;
        if (!alive.current) return;
        setOffline(false);
        apply(next, n);
      } catch {
        fails.current += 1;
        if (alive.current && fails.current >= FAILS_BEFORE_OFFLINE) setOffline(true);
      }
    },
    [templateId, holder, apply],
  );

  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    void call(true);
    // Пока первый ответ не получен (state === null), продление тоже пытается захватить: иначе после сбоя первого вызова
    // вкладка вечно слала бы acquire: false и никогда не получила блокировку.
    const timer = setInterval(() => {
      const s = stateRef.current?.state;
      void call(s === undefined || s === 'mine');
    }, EDIT_LOCK_HEARTBEAT_MS);
    const onHide = () => releaseEditLock(templateId, holder);
    window.addEventListener('pagehide', onHide);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      releaseEditLock(templateId, holder);
    };
  }, [call, templateId, holder, enabled]);

  return {
    holder,
    state,
    lostTo,
    offline,
    editing: state?.state === 'mine',
    start: () => call(true),
    takeover: async () => {
      const n = ++seq.current;
      apply(await api.templates.takeoverEditLock(templateId, holder), n);
    },
  };
}
