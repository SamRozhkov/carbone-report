import { useCallback, useState } from 'react';

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // переполнение / приватный режим — значение живёт только в памяти
  }
}

export function useStoredState<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      writeStored(key, v);
    },
    [key],
  );
  return [value, set];
}
