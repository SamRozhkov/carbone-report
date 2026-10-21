import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, userMe } from '../test/utils';
import { Layout } from './Layout';

describe('обратная связь в меню', () => {
  it.each([undefined, false])('скрыта, когда feedback=%s', async (feedback) => {
    mockApi([
      {
        ...userMe,
        body: {
          ...userMe.body,
          ...(feedback === undefined ? {} : { features: { backups: false, feedback } }),
        },
      },
    ]);
    renderWithProviders(<Layout />, { route: '/reports' });

    await screen.findByText(userMe.body.login);
    expect(screen.queryByText('Обратная связь')).not.toBeInTheDocument();
  });

  it('открывает форму для пользователя, если сервер включил обратную связь', async () => {
    mockApi([
      {
        ...userMe,
        body: { ...userMe.body, features: { backups: false, feedback: true } },
      },
    ]);
    renderWithProviders(<Layout />, { route: '/reports' });

    await userEvent.click(await screen.findByText('Обратная связь'));
    expect(screen.getByRole('dialog', { name: 'Обратная связь' })).toBeInTheDocument();
    expect(screen.getByLabelText('Тема')).toBeInTheDocument();
    expect(
      screen.getByText(/Сообщение получит внутренняя техническая поддержка/),
    ).toBeInTheDocument();
  });
});
