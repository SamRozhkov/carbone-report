import { describe, expect, it } from 'vitest';
import { HELP_MODULES, HELP_RU, type HelpContent } from '.';

/** Модули всех доступных языков: ru и таблица HELP_MODULES (§46.4). */
const MODULES: [string, HelpContent][] = [
  ['ru', HELP_RU],
  ...(await Promise.all(
    Object.entries(HELP_MODULES).map(
      async ([l, load]) => [l, await load()] as [string, HelpContent],
    ),
  )),
];

/** Сообщение API об отключённом форматтере на языке модуля — из каталога errors. */
const ERRORS = import.meta.glob<{ carbone: { communityFormatter: string } }>(
  '../../../../../../../packages/shared/src/i18n/*/errors.json',
  { eager: true, import: 'default' },
);
function communityRe(locale: string): RegExp {
  const entry = Object.entries(ERRORS).find(([path]) => path.endsWith(`/${locale}/errors.json`));
  const text = entry![1].carbone.communityFormatter.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  return new RegExp(`^${text.replace('{{name}}', '[A-Za-z_][A-Za-z0-9_]*')}$`);
}
/** Каноничная строка таблицы: «| a | b |», пустая ячейка — «| |» (так её выводит help-check). */
const canonicalRow = (line: string) => {
  const cells = line
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
  return `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');
};

describe.each(MODULES)('содержание справки: %s', (locale, { HELP_INTRO, HELP_SECTIONS }) => {
  const examples = HELP_SECTIONS.flatMap((s) => s.examples);
  const COMMUNITY = communityRe(locale);

  it('двенадцать разделов в порядке §23.2 (+ §32, §34, §35, §39)', () => {
    expect(HELP_SECTIONS.map((s) => s.id)).toEqual([
      'basics',
      'tables',
      'formatting',
      'conditions',
      'aggregates',
      'totals',
      'media',
      'charts',
      'echarts',
      'html',
      'pdf',
      'signature',
      'unavailable',
    ]);
    // Заголовки — по-русски только в ru; переводы сверяет тест структуры по id.
    if (locale === 'ru')
      expect(HELP_SECTIONS.map((s) => [s.id, s.title])).toEqual([
        ['basics', 'Основы'],
        ['tables', 'Таблицы'],
        ['formatting', 'Форматирование'],
        ['conditions', 'Условия'],
        ['aggregates', 'Итоги и нумерация'],
        ['totals', 'Итоги и группировка'],
        ['media', 'Изображения, штрихкоды, цвета, ссылки'],
        ['charts', 'Диаграммы'],
        ['echarts', 'Графики ECharts'],
        ['html', 'HTML'],
        ['pdf', 'PDF: PDF/A, водяной знак, нумерация, приложения, пароль'],
        ['signature', 'Электронная подпись'],
        ['unavailable', 'Недоступно в бесплатной версии'],
      ]);
    // Раздел «Электронная подпись» — только текст: подпись не тег, примеров Carbone у неё нет.
    for (const s of HELP_SECTIONS.filter((x) => x.id !== 'signature'))
      expect(s.examples.length, s.id).toBeGreaterThan(0);
  });

  it('раздел «Электронная подпись» идёт после PDF и называет место под штамп и страницу подписи', () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(ids.indexOf('signature')).toBe(ids.indexOf('pdf') + 1);
    const text = HELP_SECTIONS.find((s) => s.id === 'signature')!.intro.join('\n');
    expect(text).toContain('110');
    expect(text).toContain('SIGN_TSA_URL');
    if (locale === 'ru') {
      expect(text).toContain('110 пт');
      expect(text).toContain('Моя подпись');
    }
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
      'na-autoorient',
      'na-bindcolor',
      'na-svg',
      'na-sort-desc',
      'na-txt',
    ]);
  });

  it('picture — только в разделе «Изображения…»: одна метка без таблиц, data — изображение', () => {
    const pictures = HELP_SECTIONS.flatMap((s) =>
      s.examples.filter((e) => e.picture).map((e) => [s.id, e] as const),
    );
    expect(pictures.map(([, e]) => e.id)).toEqual([
      'media-image',
      'media-image-fit',
      'media-qrcode',
      'echarts-builder',
      'echarts-sql',
      'echarts-size',
    ]);
    for (const [sid, e] of pictures) {
      expect(['media', 'echarts'], e.id).toContain(sid);
      expect(e.template, e.id).toMatch(/^\{d\.[^{}\n]+\}$/);
      expect(e.unavailable, e.id).toBeUndefined();
    }
  });

  it('rich — только в разделе «HTML», и все его примеры с :html', () => {
    const rich = HELP_SECTIONS.flatMap((s) =>
      s.examples.filter((e) => e.rich).map((e) => [s.id, e] as const),
    );
    const html = HELP_SECTIONS.find((s) => s.id === 'html')!.examples;
    expect(rich.map(([, e]) => e.id)).toEqual(html.map((e) => e.id));
    for (const [sid, e] of rich) {
      expect(sid, e.id).toBe('html');
      expect(e.template, e.id).toMatch(/\{d\.[^{}\n]*:html(\([^{}\n]*\))?\}/);
      expect(e.picture, e.id).toBeUndefined();
      expect(e.unavailable, e.id).toBeUndefined();
    }
  });

  it('диаграммы: примеры — строки цикла [i] и [i+1]; графики ECharts — :chart в картинке', () => {
    for (const e of HELP_SECTIONS.find((s) => s.id === 'charts')!.examples) {
      expect(e.template, e.id).toMatch(/\[i\]/);
      expect(e.template, e.id).toMatch(/\[i\+1\]/);
    }
    for (const e of HELP_SECTIONS.find((s) => s.id === 'echarts')!.examples) {
      expect(e.template, e.id).toMatch(/^\{d\.[^{}\n]+:chart\}$/);
      expect(e.picture, e.id).toBe(true);
    }
  });

  it('примеры, которые больше не «недоступны», убраны из последнего раздела', () => {
    const ids = [
      ...examples.map((e) => e.id),
      ...HELP_SECTIONS.flatMap((s) => (s.limits ?? []).map((l) => l.id)),
    ];
    for (const gone of [
      'na-color',
      'na-barcode',
      'na-default-url',
      'na-images',
      'na-html',
      'na-chart',
    ]) {
      expect(ids).not.toContain(gone);
    }
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
