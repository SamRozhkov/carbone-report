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

/** Блокировка редактирования для вкладки «Документ» (§38.3). */
export function useEditLock(templateId: string): EditLock {
  const [holder] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<EditLockState | null>(null);
  const [lostTo, setLostTo] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const stateRef = useRef<EditLockState | null>(null);
  const fails = useRef(0);
  const alive = useRef(true);

  const apply = useCallback((next: EditLockState) => {
    const prev = stateRef.current;
    if (prev?.state === 'mine' && next.state === 'other') setLostTo(next.user.login);
    if (next.state === 'mine') setLostTo(null);
    stateRef.current = next;
    setState(next);
  }, []);

  const call = useCallback(
    async (acquire: boolean) => {
      try {
        const next = await api.templates.editLock(templateId, { holder, acquire });
        fails.current = 0;
        if (!alive.current) return;
        setOffline(false);
        apply(next);
      } catch {
        fails.current += 1;
        if (alive.current && fails.current >= FAILS_BEFORE_OFFLINE) setOffline(true);
      }
    },
    [templateId, holder, apply],
  );

  useEffect(() => {
    alive.current = true;
    void call(true);
    const timer = setInterval(
      () => void call(stateRef.current?.state === 'mine'),
      EDIT_LOCK_HEARTBEAT_MS,
    );
    const onHide = () => releaseEditLock(templateId, holder);
    window.addEventListener('pagehide', onHide);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      releaseEditLock(templateId, holder);
    };
  }, [call, templateId, holder]);

  return {
    holder,
    state,
    lostTo,
    offline,
    editing: state?.state === 'mine',
    start: () => call(true),
    takeover: async () => {
      apply(await api.templates.takeoverEditLock(templateId, holder));
    },
  };
}
