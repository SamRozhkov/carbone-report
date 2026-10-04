import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test/utils';
import { TagsPanel } from './TagsPanel';

describe('TagsPanel', () => {
  it('показывает теги и копирует по клику', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(
      <TagsPanel data={{ orders: [{ total: 1 }] }} onRefresh={() => {}} refreshing={false} />,
    );
    expect(await screen.findByText('{d.orders[i].total}')).toBeInTheDocument();
    expect(screen.getByText('{d.orders[i+1]}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скопировать {d.orders[i].total}' }));
    expect(writeText).toHaveBeenCalledWith('{d.orders[i].total}');
  });

  it('без данных — подсказка и кнопка обновления', async () => {
    const onRefresh = vi.fn();
    renderWithProviders(<TagsPanel data={null} onRefresh={onRefresh} refreshing={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Обновить данные' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('буфер недоступен — предупреждение, каждое копирование показывает своё уведомление', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<TagsPanel data={{ a: 1 }} onRefresh={() => {}} refreshing={false} />);
    const btn = await screen.findByRole('button', { name: 'Скопировать {d.a}' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(
      await screen.findAllByText('Не удалось скопировать — выделите тег вручную'),
    ).toHaveLength(2);
  });
});
