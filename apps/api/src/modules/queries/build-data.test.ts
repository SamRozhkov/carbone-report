import { describe, expect, it } from 'vitest';
import { buildReportData } from './build-data';

describe('buildReportData', () => {
  it('list → массив, single → объект, params добавляются', () => {
    const data = buildReportData(
      [
        { key: 'orders', mode: 'list', columns: ['id'], rows: [{ id: 1 }, { id: 2 }] },
        { key: 'company', mode: 'single', columns: ['name'], rows: [{ name: 'ООО Ромашка' }] },
      ],
      { dateFrom: '2026-01-01' },
    );
    expect(data).toEqual({
      orders: [{ id: 1 }, { id: 2 }],
      company: { name: 'ООО Ромашка' },
      params: { dateFrom: '2026-01-01' },
    });
  });
  it('single без строк → null, list без строк → []', () => {
    expect(
      buildReportData(
        [
          { key: 'a', mode: 'single', columns: [], rows: [] },
          { key: 'b', mode: 'list', columns: [], rows: [] },
        ],
        {},
      ),
    ).toEqual({ a: null, b: [], params: {} });
  });
});
