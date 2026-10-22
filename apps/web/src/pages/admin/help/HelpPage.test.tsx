import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../../../i18n';
import { adminMe, mockApi, renderRoute, renderWithProviders, userMe } from '../../../test/utils';
import { HELP_MODULES, HELP_RU, loadHelpContent, type HelpContent } from './content';
import { HELP_SECTIONS } from './content/ru';
import { HelpPage } from './HelpPage';

describe('HelpPage', () => {
  it('оглавление: каждая ссылка ведёт на существующий раздел', async () => {
    renderWithProviders(<HelpPage />, { route: '/admin/help' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Справка по шаблонам' }),
    ).toBeInTheDocument();
    const links = within(screen.getByRole('navigation', { name: 'Оглавление' })).getAllByRole(
      'link',
    );
    expect(links.map((l) => l.textContent)).toEqual(HELP_SECTIONS.map((s) => s.title));
    HELP_SECTIONS.forEach((s, i) => {
      expect(links[i]).toHaveAttribute('href', `#${s.id}`);
      const target = document.getElementById(s.id);
      expect(target, s.id).not.toBeNull();
      expect(screen.getByRole('region', { name: s.title })).toBe(target);
    });
  });

  it('все примеры и пункты раздела 6 на странице', async () => {
    renderWithProviders(<HelpPage />);
    const examples = HELP_SECTIONS.flatMap((s) => s.examples);
    expect(await screen.findAllByRole('article')).toHaveLength(examples.length);
    for (const e of examples) {
      expect(document.getElementById(e.id)).toBe(screen.getByRole('article', { name: e.title }));
    }
    for (const l of HELP_SECTIONS.flatMap((s) => s.limits ?? [])) {
      expect(document.getElementById(l.id)).toHaveTextContent(l.title);
    }
  });

  it('карточка: тег, данные, результат, «Внимание»; «Копировать» копирует тег', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<HelpPage />);
    const e = HELP_SECTIONS[0]!.examples[0]!;
    const card = await screen.findByRole('article', { name: e.title });
    for (const label of ['Тег в шаблоне', 'Данные', 'Результат', 'Внимание']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    expect(within(card).getByText(e.template)).toBeInTheDocument();
    expect(within(card).getByText(e.result)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: `Копировать тег: ${e.title}` }));
    expect(writeText).toHaveBeenCalledWith(e.template);
    expect(await screen.findByText(`Скопировано: ${e.title}`)).toBeInTheDocument();
  });

  it('пример с картинкой: тег подписан как замещающий текст картинки', async () => {
    renderWithProviders(<HelpPage />);
    const e = HELP_SECTIONS.flatMap((s) => s.examples).find((x) => x.picture)!;
    const card = await screen.findByRole('article', { name: e.title });
    expect(within(card).getByText('Тег в замещающем тексте картинки')).toBeInTheDocument();
    expect(within(card).queryByText('Тег в шаблоне')).not.toBeInTheDocument();
    expect(within(card).getByText(e.template)).toBeInTheDocument();
  });

  it('антипримеры без кнопки «Копировать», у обычной карточки она есть', async () => {
    renderWithProviders(<HelpPage />);
    const all = HELP_SECTIONS.flatMap((s) => s.examples);
    const anti = all.filter((e) => e.antiPattern);
    expect(anti.map((e) => e.id).sort()).toEqual(['cond-table-row', 'totals-set-sum']);
    for (const e of anti) {
      const card = await screen.findByRole('article', { name: e.title });
      expect(
        within(card).queryByRole('button', { name: `Копировать тег: ${e.title}` }),
      ).not.toBeInTheDocument();
    }
    const normal = all.find((e) => !e.antiPattern)!;
    const card = screen.getByRole('article', { name: normal.title });
    expect(
      within(card).getByRole('button', { name: `Копировать тег: ${normal.title}` }),
    ).toBeInTheDocument();
  });

  it('примеры с таблицей: подсказка про «|» рядом с кнопкой, у остальных её нет', async () => {
    renderWithProviders(<HelpPage />);
    const hint = 'в Word вставьте теги в ячейки таблицы; | — только обозначение ячеек';
    const all = HELP_SECTIONS.flatMap((s) => s.examples).filter((e) => !e.antiPattern);
    const tableEx = all.find((e) => e.template.split('\n').some((l) => l.startsWith('|')))!;
    const plain = all.find((e) => !e.template.split('\n').some((l) => l.startsWith('|')))!;
    const withHint = await screen.findByRole('article', { name: tableEx.title });
    expect(within(withHint).getByText(hint)).toBeInTheDocument();
    const without = screen.getByRole('article', { name: plain.title });
    expect(within(without).queryByText(hint)).not.toBeInTheDocument();
  });

  it('админ: маршрут /admin/help и пункт меню', async () => {
    mockApi([adminMe]);
    renderRoute('/admin/help');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Справка по шаблонам' }),
    ).toBeInTheDocument();
    // Заголовок страницы и пункт меню.
    expect(screen.getAllByText('Справка по шаблонам')).toHaveLength(2);
  });

  it('пользователь без прав админа на /admin/help попадает в /reports', async () => {
    mockApi([userMe, { path: '/api/templates', body: [] }]);
    const { router } = renderRoute('/admin/help');
    await waitFor(() => expect(router.state.location.pathname).toBe('/reports'));
    expect(screen.queryByText('Справка по шаблонам')).not.toBeInTheDocument();
  });

  it('пояснение: результаты — для языка отчёта «Русский»', async () => {
    renderWithProviders(<HelpPage />);
    expect(
      await screen.findByText(
        'Результаты примеров показаны для языка отчёта «Русский». Язык отчёта задаётся во вкладке «Настройки» шаблона.',
      ),
    ).toBeInTheDocument();
  });
});

describe('HelpPage: язык справки (§46)', () => {
  const saved = { ...HELP_MODULES };
  afterEach(() => {
    for (const k of Object.keys(HELP_MODULES) as (keyof typeof HELP_MODULES)[])
      delete HELP_MODULES[k];
    Object.assign(HELP_MODULES, saved);
  });

  /** Фиктивный модуль: те же id, другие заголовки. */
  const fake: HelpContent = {
    HELP_INTRO: ['Intro'],
    HELP_SECTIONS: HELP_RU.HELP_SECTIONS.map((s) => ({ ...s, title: `EN ${s.id}` })),
  };

  it('языка без модуля нет — справка на ru без сообщения об ошибке', async () => {
    delete HELP_MODULES.de;
    expect(await loadHelpContent('de')).toEqual({ content: HELP_RU, failed: false });
    expect(await loadHelpContent('ru')).toEqual({ content: HELP_RU, failed: false });
  });

  it('модуль языка не загрузился — сообщение и русская справка', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    HELP_MODULES.en = () => Promise.reject(new Error('chunk'));
    await changeLocale('en', { persist: 'none' });
    renderWithProviders(<HelpPage />);
    expect(
      await screen.findByText('Could not load help in this language. Showing help in Russian.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Template help' })).toBeInTheDocument();
    const first = HELP_SECTIONS[0]!;
    expect(screen.getByRole('region', { name: first.title })).toBe(
      document.getElementById(first.id),
    );
    expect(
      screen.getByText(
        'Example results are shown for the report language “Русский”. The report language is set on the template’s “Settings” tab.',
      ),
    ).toBeInTheDocument();
  });

  it('en: заголовки и результаты из en.ts, «Copy» копирует английский шаблон', async () => {
    const en = await import('./content/en');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await changeLocale('en', { persist: 'none' });
    renderWithProviders(<HelpPage />);
    const first = en.HELP_SECTIONS[0]!;
    expect(await screen.findByRole('region', { name: first.title })).toBe(
      document.getElementById(first.id),
    );
    expect(first.title).toBe('Basics');
    const all = en.HELP_SECTIONS.flatMap((s) => s.examples);
    const date = all.find((e) => e.id === 'fmt-date-long')!;
    expect(date.result).toBe('March 8, 2026');
    const dateCard = screen.getByRole('article', { name: date.title });
    expect(within(dateCard).getByText(date.result)).toBeInTheDocument();
    // Пример с постоянным текстом в шаблоне: копируется английский шаблон, а не русский.
    const e = all.find((x) => x.id === 'basics-params')!;
    expect(e.template).toBe("Period from {d.params.from:formatD('MM/DD/YYYY')}");
    const card = screen.getByRole('article', { name: e.title });
    await userEvent.click(within(card).getByRole('button', { name: `Copy tag: ${e.title}` }));
    expect(writeText).toHaveBeenCalledWith(e.template);
  });

  it('смена языка на открытой справке — содержимое переключается, якоря на месте', async () => {
    HELP_MODULES.en = () => Promise.resolve(fake);
    renderWithProviders(<HelpPage />);
    const first = HELP_SECTIONS[0]!;
    expect(await screen.findByRole('region', { name: first.title })).toBeInTheDocument();
    await act(() => changeLocale('en', { persist: 'none' }));
    expect(await screen.findByRole('region', { name: `EN ${first.id}` })).toBe(
      document.getElementById(first.id),
    );
    expect(screen.queryByRole('region', { name: first.title })).not.toBeInTheDocument();
    expect(document.getElementById('fmt-money')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Template help' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Example results are shown for the report language “English”. The report language is set on the template’s “Settings” tab.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Could not load help in this language. Showing help in Russian.'),
    ).not.toBeInTheDocument();
  });
});
