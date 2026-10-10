import { describe, expect, it } from 'vitest';
import { HELP_INTRO, HELP_SECTIONS } from './content';

const examples = HELP_SECTIONS.flatMap((s) => s.examples);
const COMMUNITY =
  /^в шаблоне используется [A-Za-z_][A-Za-z0-9_]* — недоступно в бесплатной версии Carbone, см\. «Справка по шаблонам»$/;
/** Каноничная строка таблицы: «| a | b |», пустая ячейка — «| |» (так её выводит help-check). */
const canonicalRow = (line: string) => {
  const cells = line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
  return `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');
};

describe('содержание справки', () => {
  it('семь разделов в порядке §23.2', () => {
    expect(HELP_SECTIONS.map((s) => [s.id, s.title])).toEqual([
      ['basics', 'Основы'],
      ['tables', 'Таблицы'],
      ['formatting', 'Форматирование'],
      ['conditions', 'Условия'],
      ['aggregates', 'Итоги и нумерация'],
      ['totals', 'Итоги и группировка'],
      ['unavailable', 'Недоступно в бесплатной версии'],
    ]);
    for (const s of HELP_SECTIONS) expect(s.examples.length, s.id).toBeGreaterThan(0);
  });

  it('data каждого примера — корректный JSON-объект', () => {
    for (const e of examples) {
      const parsed: unknown = JSON.parse(e.data);
      expect(typeof parsed === 'object' && parsed !== null, e.id).toBe(true);
    }
  });

  it('id разделов, примеров и пунктов уникальны и годятся для якоря', () => {
    const ids = [
      ...HELP_SECTIONS.map((s) => s.id),
      ...examples.map((e) => e.id),
      ...HELP_SECTIONS.flatMap((s) => (s.limits ?? []).map((l) => l.id)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('у примеров непустые заголовок, тег и результат; строки таблиц каноничны', () => {
    for (const e of examples) {
      expect(e.title.trim(), e.id).not.toBe('');
      expect(e.template.trim(), e.id).not.toBe('');
      expect(e.result, e.id).not.toBe('');
      for (const line of e.template.split('\n').filter((l) => l.startsWith('|'))) {
        expect(line, e.id).toBe(canonicalRow(line));
      }
      for (const line of e.result.split('\n').filter((l) => l.startsWith('|'))) {
        expect(line, e.id).toBe(canonicalRow(line));
      }
    }
  });

  it('недоступное — только в последнем разделе, и результат — сообщение API', () => {
    for (const s of HELP_SECTIONS) {
      for (const e of s.examples) {
        expect(e.unavailable === true, e.id).toBe(s.id === 'unavailable');
        if (e.unavailable) expect(e.result, e.id).toMatch(COMMUNITY);
      }
    }
    const limits = HELP_SECTIONS.find((s) => s.id === 'unavailable')!.limits ?? [];
    expect(limits.map((l) => l.id)).toEqual([
      'na-images',
      'na-autoorient',
      'na-sort-desc',
      'na-txt',
    ]);
  });

  it('antiPattern — только cond-table-row и totals-set-sum, не в последнем разделе', () => {
    const flagged = HELP_SECTIONS.flatMap((s) => s.examples.map((e) => [s.id, e] as const)).filter(
      ([, e]) => e.antiPattern,
    );
    expect(flagged.map(([, e]) => e.id).sort()).toEqual(['cond-table-row', 'totals-set-sum']);
    for (const [sid] of flagged) expect(sid).not.toBe('unavailable');
  });

  it('в тексте с `кодом` чётное число обратных кавычек', () => {
    const texts = [
      ...HELP_INTRO,
      ...HELP_SECTIONS.flatMap((s) => [
        ...s.intro,
        ...s.examples.map((e) => e.note ?? ''),
        ...(s.limits ?? []).map((l) => l.instead),
      ]),
    ];
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) expect((t.match(/`/g) ?? []).length % 2, t).toBe(0);
  });
});
