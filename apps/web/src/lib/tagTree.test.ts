import { describe, expect, it } from 'vitest';
import { buildTagTree } from './tagTree';

describe('buildTagTree', () => {
  it('объект, массив объектов, массив значений, null, params', () => {
    const tree = buildTagTree({
      company: { name: 'ООО Ромашка', inn: null },
      orders: [{ id: 1, total: 250.5 }],
      tags: ['a', 'b'],
      empty: [],
      params: { from: '2026-01-01' },
    });
    expect(tree.map((n) => n.label)).toEqual([
      'company',
      'orders []',
      'tags []',
      'empty []',
      'params',
    ]);

    const company = tree[0]!;
    expect(company.tag).toBeNull();
    expect(company.children.map((c) => [c.label, c.tag, c.sample])).toEqual([
      ['name', '{d.company.name}', 'ООО Ромашка'],
      ['inn', '{d.company.inn}', 'null'],
    ]);

    const orders = tree[1]!;
    expect(orders.tag).toBeNull();
    expect(orders.nextRowTag).toBe('{d.orders[i+1]}');
    expect(orders.children.map((c) => c.tag)).toEqual(['{d.orders[i].id}', '{d.orders[i].total}']);

    expect(tree[2]).toMatchObject({
      tag: '{d.tags[i]}',
      nextRowTag: '{d.tags[i+1]}',
      children: [],
    });
    expect(tree[3]).toMatchObject({ tag: '{d.empty[i]}', children: [] });
    expect(tree[4]!.children[0]!.tag).toBe('{d.params.from}');
  });

  it('длинные значения в sample обрезаются', () => {
    const [n] = buildTagTree({ text: 'x'.repeat(100) });
    expect(n!.sample!.length).toBeLessThanOrEqual(41);
  });
});
