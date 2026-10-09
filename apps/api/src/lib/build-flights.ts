import type { Deadline } from './deadline';

/**
 * Одна сборка на ключ в процессе: одновременные запросы ждут один промис и не занимают соединений.
 * Срок сборки — срок запроса, который её начал; каждый ждущий ограничен ещё и своим сроком.
 * К сборке с истёкшим сроком не присоединяются: она уже обречена на TIMEOUT (досиживает ожидание
 * блокировки), и пришедший следом запрос начинает новую.
 */
export function createBuildFlights<T>() {
  const flights = new Map<string, { promise: Promise<T>; deadline: Deadline }>();
  return (key: string, deadline: Deadline, start: () => Promise<T>): Promise<T> => {
    let flight = flights.get(key);
    if (!flight || flight.deadline.remaining() <= 0) {
      const entry = { promise: start(), deadline };
      // Ждущие могли уйти по своему сроку: отказ сборки не должен стать необработанным.
      entry.promise
        .catch(() => {})
        .finally(() => {
          if (flights.get(key) === entry) flights.delete(key);
        });
      flights.set(key, entry);
      flight = entry;
    }
    return deadline.race(flight.promise);
  };
}
