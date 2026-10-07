import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminMe, mockApi, renderRoute, renderWithProviders, userMe } from '../../../test/utils';
import { HELP_SECTIONS } from './content';
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
});
