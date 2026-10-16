import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildTagTree } from '../../../lib/tagTree';
import { renderWithProviders } from '../../../test/utils';
import { TagsPanel, filterTree } from './TagsPanel';

describe('TagsPanel', () => {
  it('показывает теги и копирует по клику', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(
      <TagsPanel
        data={{ orders: [{ total: 1 }] }}
        onRefresh={() => {}}
        refreshing={false}
        editing
      />,
    );
    expect(await screen.findByText('{d.orders[i].total}')).toBeInTheDocument();
    expect(screen.getByText('{d.orders[i+1]}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Скопировать {d.orders[i].total}' }));
    expect(writeText).toHaveBeenCalledWith('{d.orders[i].total}');
  });

  it('без данных — подсказка и кнопка обновления', async () => {
    const onRefresh = vi.fn();
    renderWithProviders(<TagsPanel data={null} onRefresh={onRefresh} refreshing={false} editing />);
    await userEvent.click(await screen.findByRole('button', { name: 'Обновить данные' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('буфер недоступен — предупреждение, каждое копирование показывает своё уведомление', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(
      <TagsPanel data={{ a: 1 }} onRefresh={() => {}} refreshing={false} editing />,
    );
    const btn = await screen.findByRole('button', { name: 'Скопировать {d.a}' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(
      await screen.findAllByText('Не удалось скопировать — выделите тег вручную'),
    ).toHaveLength(2);
  });

  it('графики шаблона — теги {d.charts.<key>:chart}; charts из данных не разворачивается деревом', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(
      <TagsPanel
        data={{
          orders: [{ total: 1 }],
          charts: { sales: { type: 'echarts@v5', option: { series: [] } } },
        }}
        charts={['sales']}
        onRefresh={() => {}}
        refreshing={false}
        editing
      />,
    );
    expect(await screen.findByText('{d.charts.sales:chart}')).toBeInTheDocument();
    expect(screen.queryByText('{d.charts.sales.type}')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Скопировать {d.charts.sales:chart}' }),
    );
    expect(writeText).toHaveBeenCalledWith('{d.charts.sales:chart}');
  });

  it('графики видны и без данных предпросмотра', async () => {
    renderWithProviders(
      <TagsPanel data={null} charts={['sales']} onRefresh={() => {}} refreshing={false} editing />,
    );
    expect(await screen.findByText('{d.charts.sales:chart}')).toBeInTheDocument();
  });
});

const data = {
  company: { name: 'Ромашка', inn: '7701' },
  items: [{ name: 'Бумага', qty: 10 }],
};
const noop = () => {};

describe('TagsPanel: поиск, сворачивание, перетаскивание', () => {
  it('filterTree: совпадения вместе с родителями', () => {
    const res = filterTree(buildTagTree(data), 'INN');
    expect(res.map((n) => n.label)).toEqual(['company']);
    expect(res[0]!.children.map((c) => c.label)).toEqual(['inn']);
    expect(filterTree(buildTagTree(data), '  ')).toHaveLength(2);
  });

  it('поиск: совпадения вместе с родителями, «Ничего не найдено»', async () => {
    renderWithProviders(<TagsPanel data={data} onRefresh={noop} refreshing={false} editing />);
    const box = screen.getByRole('searchbox', { name: 'Поиск по тегам' });
    await userEvent.type(box, 'INN');
    expect(screen.getByText('{d.company.inn}')).toBeInTheDocument();
    expect(screen.queryByText('{d.company.name}')).toBeNull();
    expect(screen.getByText('company')).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, 'zzz');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('сворачивание: первый уровень раскрыт, узел сворачивается', async () => {
    renderWithProviders(<TagsPanel data={data} onRefresh={noop} refreshing={false} editing />);
    expect(screen.getByText('{d.company.inn}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Свернуть company' }));
    expect(screen.queryByText('{d.company.inn}')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Развернуть company' }));
    expect(screen.getByText('{d.company.inn}')).toBeInTheDocument();
  });

  it('перетаскивание: text/plain с тегом', () => {
    renderWithProviders(<TagsPanel data={data} onRefresh={noop} refreshing={false} editing />);
    const tile = screen.getByText('{d.company.inn}').closest('[draggable]')!;
    expect(tile).toHaveAttribute('draggable', 'true');
    expect(tile).toHaveAttribute('title', 'Перетащите в документ или скопируйте');
    const setData = vi.fn();
    const dt = { setData, effectAllowed: '' };
    fireEvent.dragStart(tile, { dataTransfer: dt });
    expect(setData).toHaveBeenCalledWith('text/plain', '{d.company.inn}');
    expect(dt.effectAllowed).toBe('copy');
  });

  it('в просмотре плитка не перетаскивается, копирование доступно', () => {
    renderWithProviders(
      <TagsPanel data={data} onRefresh={noop} refreshing={false} editing={false} />,
    );
    expect(screen.getByText('{d.company.inn}').closest('[draggable]')).toHaveAttribute(
      'draggable',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Скопировать {d.company.inn}' })).toBeInTheDocument();
  });

  it('строки цикла перетаскиваются по отдельности', () => {
    renderWithProviders(<TagsPanel data={data} onRefresh={noop} refreshing={false} editing />);
    for (const tag of ['{d.items[i].name}', '{d.items[i+1]}'])
      expect(screen.getByText(tag).closest('[draggable]')).toHaveAttribute('draggable', 'true');
  });
});

describe('TagsPanel: Конструкции', () => {
  it('свёрнуты по умолчанию; плитка перетаскивается, «Подробнее» ведёт в справку', async () => {
    const { container } = renderWithProviders(
      <TagsPanel data={null} onRefresh={() => {}} refreshing={false} editing />,
    );
    const details = container.querySelector('details.cr-snippets') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText('Конструкции'));
    expect(details.open).toBe(true);
    const tile = screen.getByText('{d.поле:formatN(2)}').closest('.cr-tag-tile') as HTMLElement;
    expect(tile).toHaveAttribute('draggable', 'true');
    const setData = vi.fn();
    fireEvent.dragStart(tile, { dataTransfer: { setData, effectAllowed: '' } });
    expect(setData).toHaveBeenCalledWith('text/plain', '{d.поле:formatN(2)}');
    const link = screen.getAllByRole('link', { name: 'Подробнее' })[4];
    expect(link).toHaveAttribute('href', '/admin/help#fmt-number');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
