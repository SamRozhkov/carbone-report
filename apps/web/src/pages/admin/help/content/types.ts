// Типы содержимого «Справки по шаблонам» (§46.2): общие для модулей всех языков.
import type { QueryMode } from '@carbone-reports/shared';

/**
 * Пример тега. В `template` и `result` строка, начинающаяся с «|», — строка таблицы Word
 * («| ячейка | ячейка |», пустая ячейка — «| |»), остальные строки — абзацы. Пустые абзацы
 * в `result` не пишутся. Формат проверяют content.test.ts и `pnpm help:check`.
 */
export interface HelpExample {
  id: string;
  title: string;
  template: string;
  /** JSON данных отчёта (объект `d`). */
  data: string;
  /** Текст результата; для `unavailable` — сообщение API. */
  result: string;
  /** Заметка «Внимание»; `код` — в обратных кавычках. */
  note?: string;
  /** SQL-запрос шаблона, который даёт такие данные (раздел «Итоги и группировка»). */
  sql?: { key: string; mode: QueryMode; text: string };
  /** Отключено в бесплатной версии: Carbone отвечает ошибкой. */
  unavailable?: true;
  /** Показан как «так нельзя»: кнопки «Копировать» нет. */
  antiPattern?: true;
  /**
   * Тег ставится в замещающий текст картинки-заглушки, результат — изображение: `result` описывает его
   * словами, а `pnpm help:check` проверяет только, что отчёт собран без ошибки и картинка заменена.
   */
  picture?: true;
  /**
   * Результат — оформленный документ (HTML из данных): `result` описывает его словами, а `pnpm help:check`
   * проверяет только, что отчёт собран без ошибки и в нём есть текст.
   */
  rich?: true;
}

/** Недоступное без проверяемого тега: что происходит и что делать вместо. */
export interface HelpLimit {
  id: string;
  title: string;
  instead: string;
}

export interface HelpSection {
  id: string;
  title: string;
  intro: string[];
  examples: HelpExample[];
  limits?: HelpLimit[];
}

/** Модуль языка (`content/<locale>.ts`): вводные абзацы и разделы. */
export interface HelpContent {
  HELP_INTRO: string[];
  HELP_SECTIONS: HelpSection[];
}
