import type { SheetLayout, SheetReplaceItem, SheetReplaceTable } from '@carbone-reports/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connector } from './documentAdapter';
import { createSheetAdapter, gridLayout, textLayout } from './sheetAdapter';

/* Фейковый Spreadsheet API в памяти: те методы, что вызывает адаптер, с теми же именами
 * (https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/). Значения ячеек — как
 * в редакторе: GetValue возвращает строку, GetText — отображаемый текст; SetValue со строкой,
 * начинающейся с «=», создаёт формулу, «'» в начале — текст без апострофа, число — число. */

const MAX_COL = 16_383;

interface FakeCell {
  value: string | number;
  /** Отображаемый текст числа (по формату), например «1 234,50». */
  display?: string;
  formula?: string;
  quote?: boolean;
  numFmt: string;
  bold: boolean;
  fill: string | null;
  borders: Record<string, string>;
}

const blank = (): FakeCell => ({
  value: '',
  numFmt: 'General',
  bold: false,
  fill: null,
  borders: {},
});

function colName(c: number) {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
const ref = (r: number, c: number) => `${colName(c)}${r + 1}`;
function parseCell(a: string) {
  const m = /^([A-Z]+)(\d+)$/.exec(a);
  if (!m) throw new Error('bad ref ' + a);
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]) - 1, col: col - 1 };
}

class FakeRange {
  constructor(
    public sheet: FakeSheet,
    public top: number,
    public left: number,
    public bottom: number,
    public right: number,
  ) {}
  private each(f: (r: number, c: number) => void) {
    for (let r = this.top; r <= this.bottom; r++)
      for (let c = this.left; c <= Math.min(this.right, 200); c++) f(r, c);
  }
  private one() {
    expect(this.top === this.bottom && this.left === this.right).toBe(true);
    return this.sheet.get(this.top, this.left);
  }
  GetAddress(rowAbs = true, colAbs = true) {
    const a = (r: number, c: number) =>
      `${colAbs ? '$' : ''}${colName(c)}${rowAbs ? '$' : ''}${r + 1}`;
    const first = a(this.top, this.left);
    return this.top === this.bottom && this.left === this.right
      ? first
      : `${first}:${a(this.bottom, this.right)}`;
  }
  GetText() {
    const c = this.one();
    return c ? (typeof c.value === 'number' ? (c.display ?? String(c.value)) : c.value) : '';
  }
  GetValue() {
    const c = this.one();
    return c ? String(c.value) : '';
  }
  SetValue(v: string) {
    this.sheet.log.push(`SetValue ${this.GetAddress(false, false)}`);
    this.each((r, c) => {
      const cell = this.sheet.cell(r, c);
      cell.formula = undefined;
      cell.quote = undefined;
      cell.display = undefined;
      if (v.startsWith("'")) {
        cell.value = v.slice(1);
        cell.quote = true;
      } else if (v.startsWith('=')) {
        cell.formula = v;
        cell.value = 0;
      } else if (/^-?\d+(\.\d+)?$/.test(v)) cell.value = Number(v);
      else cell.value = v;
    });
  }
  SetNumberFormat(f: string) {
    this.each((r, c) => (this.sheet.cell(r, c).numFmt = f));
  }
  SetBold(b: boolean) {
    this.each((r, c) => (this.sheet.cell(r, c).bold = b));
  }
  SetFillColor(color: { rgb: string }) {
    this.each((r, c) => (this.sheet.cell(r, c).fill = color.rgb));
  }
  SetBorders(edge: string, style: string, color: { rgb: string }) {
    expect(['Top', 'Bottom', 'Left', 'Right']).toContain(edge);
    this.each((r, c) => (this.sheet.cell(r, c).borders[edge] = `${style} ${color.rgb}`));
  }
  Clear() {
    this.each((r, c) => this.sheet.cells.delete(`${r}:${c}`));
  }
  ClearContents() {
    this.each((r, c) => {
      const cell = this.sheet.get(r, c);
      if (cell) {
        cell.value = '';
        cell.display = undefined;
        cell.formula = undefined;
      }
    });
  }
  ClearFormats() {
    this.each((r, c) => {
      const cell = this.sheet.get(r, c);
      if (cell) Object.assign(cell, { numFmt: 'General', bold: false, fill: null, borders: {} });
    });
  }
  /** Только целые строки (GetRows): строки ниже сдвигаются вниз. */
  Insert(shift: string) {
    expect(shift).toBe('down');
    expect(this.left === 0 && this.right === MAX_COL).toBe(true);
    this.sheet.shiftRows(this.top, this.bottom - this.top + 1);
  }
  Delete(shift: string) {
    expect(shift).toBe('up');
    expect(this.left === 0 && this.right === MAX_COL).toBe(true);
    const n = this.bottom - this.top + 1;
    for (let r = this.top; r <= this.bottom; r++)
      for (let c = 0; c <= 200; c++) this.sheet.cells.delete(`${r}:${c}`);
    this.sheet.shiftRows(this.bottom + 1, -n);
  }
  /** Значения и оформление — в диапазон того же размера. */
  Copy(dest: FakeRange) {
    this.each((r, c) => {
      const src = this.sheet.get(r, c);
      const key = `${dest.top + r - this.top}:${dest.left + c - this.left}`;
      if (src) this.sheet.cells.set(key, structuredClone(src));
      else this.sheet.cells.delete(key);
    });
  }
}

class FakeSheet {
  name = 'Sheet1';
  cells = new Map<string, FakeCell>();
  widths = new Map<number, number>();
  active = 'A1';
  log: string[] = [];
  get(r: number, c: number) {
    return this.cells.get(`${r}:${c}`);
  }
  cell(r: number, c: number) {
    let x = this.cells.get(`${r}:${c}`);
    if (!x) {
      x = blank();
      this.cells.set(`${r}:${c}`, x);
    }
    return x;
  }
  /** Строки от from и ниже сдвигаются на by. */
  shiftRows(from: number, by: number) {
    const moved = [...this.cells].map(([k, v]) => {
      const [r, c] = k.split(':').map(Number) as [number, number];
      return [r >= from ? r + by : r, c, v] as const;
    });
    this.cells = new Map(moved.map(([r, c, v]) => [`${r}:${c}`, v]));
  }
  GetName() {
    return this.name;
  }
  GetUsedRange() {
    let top = Infinity;
    let left = Infinity;
    let bottom = 0;
    let right = 0;
    for (const k of this.cells.keys()) {
      const [r, c] = k.split(':').map(Number) as [number, number];
      top = Math.min(top, r);
      left = Math.min(left, c);
      bottom = Math.max(bottom, r);
      right = Math.max(right, c);
    }
    if (top === Infinity) return new FakeRange(this, 0, 0, 0, 0);
    return new FakeRange(this, top, left, bottom, right);
  }
  GetRange(a: string) {
    const [x, y] = a.split(':');
    const p = parseCell(x!);
    const q = parseCell(y ?? x!);
    return new FakeRange(this, p.row, p.col, q.row, q.col);
  }
  GetRows(spec: string) {
    const [a, b] = spec.split(':').map(Number) as [number, number];
    return new FakeRange(this, a - 1, 0, (b ?? a) - 1, MAX_COL);
  }
  GetActiveCell() {
    return this.GetRange(this.active);
  }
  SetColumnWidth(c: number, w: number) {
    this.widths.set(c, w);
  }
  // ----- для тестов -----
  put(a: string, value: string | number, extra: Partial<FakeCell> = {}) {
    const p = parseCell(a);
    Object.assign(this.cell(p.row, p.col), { value }, extra);
  }
  at(a: string) {
    const p = parseCell(a);
    return this.get(p.row, p.col);
  }
  text(a: string) {
    const p = parseCell(a);
    return new FakeRange(this, p.row, p.col, p.row, p.col).GetText();
  }
  /** Тексты строки (1-based) по колонкам A..to. */
  row(n: number, to = 'D') {
    const last = parseCell(`${to}1`).col;
    return Array.from({ length: last + 1 }, (_, c) => this.text(ref(n - 1, c)));
  }
}

let sheet: FakeSheet;
const fakeApi = {
  GetActiveSheet: () => sheet,
  CreateColorFromRGB: (r: number, g: number, b: number) => ({ rgb: `${r},${g},${b}` }),
};
const g = globalThis as Record<string, unknown>;

/** Как настоящий connector: функция исполняется изолированно (по тексту, без замыканий),
 *  Asc.scope и результат проходят через JSON. */
function fakeConnector(): Connector & { disconnected: boolean } {
  const c = {
    disconnected: false,
    callCommand(fn: () => unknown, cb: (r: unknown) => void) {
      const scope = JSON.parse(JSON.stringify((g.Asc as { scope: unknown }).scope ?? null));
      const isolated = new Function('Asc', `return (${fn.toString()})`)({ scope }) as () => unknown;
      const r = isolated();
      cb(r === undefined ? undefined : JSON.parse(JSON.stringify(r)));
    },
    executeMethod() {},
    disconnect() {
      c.disconnected = true;
    },
  };
  return c;
}

beforeEach(() => {
  sheet = new FakeSheet();
  g.Api = fakeApi;
});
afterEach(() => {
  delete g.Api;
  delete g.Asc;
});

const BORDER = 'Thin 166,166,166';
const allBorders = { Top: BORDER, Bottom: BORDER, Left: BORDER, Right: BORDER };

describe('snapshot', () => {
  it('область C3:AB40: адреса, активная ячейка, обрезка ячейки до 500 символов', async () => {
    sheet.name = 'Report';
    sheet.put('C3', 'Title');
    sheet.put('D5', 'x'.repeat(501));
    sheet.put('E7', 1234.5, { display: '1 234,50' });
    sheet.put('AB40', 'end');
    sheet.active = 'D5';
    const s = await createSheetAdapter(fakeConnector()).snapshot();
    expect(s).toEqual({
      name: 'Report',
      usedRange: 'C3:AB40',
      active: 'D5',
      truncated: false,
      cells: [
        { ref: 'C3', text: 'Title' },
        { ref: 'D5', text: 'x'.repeat(500) },
        { ref: 'E7', text: '1 234,50' },
        { ref: 'AB40', text: 'end' },
      ],
    });
  });

  it('после 30 000 символов — truncated', async () => {
    for (let r = 1; r <= 61; r++) sheet.put(`A${r}`, 'y'.repeat(500));
    const s = await createSheetAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.cells).toHaveLength(60);
  });

  it('после 5000 ячеек — truncated', async () => {
    for (let r = 0; r < 101; r++) for (let c = 0; c < 50; c++) sheet.put(ref(r, c), 'v');
    const s = await createSheetAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.cells).toHaveLength(5000);
    expect(s.cells[4999]).toEqual({ ref: 'AX100', text: 'v' });
  });

  it('область 600×60 — только 500 строк × 50 колонок и truncated', async () => {
    sheet.put('A1', 'a');
    sheet.put('AX500', 'in');
    sheet.put('AY1', 'right');
    sheet.put('A501', 'below');
    sheet.put('BH600', 'z');
    const s = await createSheetAdapter(fakeConnector()).snapshot();
    expect(s.usedRange).toBe('A1:AX500');
    expect(s.truncated).toBe(true);
    expect(s.cells).toEqual([
      { ref: 'A1', text: 'a' },
      { ref: 'AX500', text: 'in' },
    ]);
  });
});

const tableLayout: SheetLayout = {
  rows: 4,
  cols: 4,
  widths: [20, 12, 14, 10],
  cells: [
    { row: 0, col: 0, value: 'Orders', kind: 'text', style: 'title' },
    { row: 1, col: 0, value: 'Name', kind: 'text', style: 'header' },
    { row: 1, col: 1, value: 'Sum', kind: 'text', style: 'header' },
    { row: 1, col: 2, value: 'Date', kind: 'text', style: 'header' },
    { row: 1, col: 3, value: 'Qty', kind: 'text', style: 'header' },
    { row: 2, col: 0, value: '{d.o[i].name}', kind: 'text', style: 'data' },
    { row: 2, col: 1, value: '{d.o[i].sum:formatN(2)}', kind: 'decimal', style: 'data' },
    { row: 2, col: 2, value: '{d.o[i].date:cellDate}', kind: 'date', style: 'data' },
    { row: 2, col: 3, value: '{d.o[i].qty:formatN(0)}', kind: 'integer', style: 'data' },
    { row: 3, col: 0, value: '{d.o[i+1].name}', kind: 'text', style: 'data' },
    { row: 3, col: 1, value: '', kind: 'decimal', style: 'data' },
  ],
};

describe('applyLayout / insertCells', () => {
  it('applyLayout: лист очищен, раскладка с A1, оформление, форматы, ширины', async () => {
    sheet.put('E10', 'old', { bold: true, numFmt: '0%' });
    sheet.put('A1', 'was', { fill: '1,2,3' });
    await createSheetAdapter(fakeConnector()).applyLayout(tableLayout);
    expect(sheet.at('E10')).toBeUndefined();
    expect(sheet.text('A1')).toBe('Orders');
    expect(sheet.at('A1')).toMatchObject({
      bold: true,
      fill: null,
      numFmt: 'General',
      borders: {},
    });
    expect(sheet.at('A2')).toMatchObject({
      value: 'Name',
      bold: true,
      fill: '242,242,242',
      borders: allBorders,
    });
    expect(sheet.at('A3')).toMatchObject({
      value: '{d.o[i].name}',
      bold: false,
      numFmt: 'General',
      borders: allBorders,
    });
    expect(sheet.at('B3')).toMatchObject({ numFmt: '#,##0.00', borders: allBorders });
    expect(sheet.at('C3')).toMatchObject({ numFmt: 'dd.mm.yyyy' });
    expect(sheet.at('D3')).toMatchObject({ numFmt: '#,##0' });
    expect(sheet.at('B4')).toMatchObject({ value: '', numFmt: '#,##0.00', borders: allBorders });
    expect([...sheet.widths]).toEqual([
      [0, 20],
      [1, 12],
      [2, 14],
      [3, 10],
    ]);
  });

  it('insertCells(D4, textLayout) — строки вниз, прочее не тронуто, ширины не меняются', async () => {
    sheet.put('A1', 'keep', { bold: true });
    await createSheetAdapter(fakeConnector()).insertCells('D4', textLayout('a\nb'));
    expect(sheet.text('D4')).toBe('a');
    expect(sheet.text('D5')).toBe('b');
    expect(sheet.at('A1')).toMatchObject({ value: 'keep', bold: true });
    expect(sheet.at('D4')).toMatchObject({ bold: false, numFmt: 'General', borders: {} });
    expect(sheet.cells.size).toBe(3);
    expect(sheet.widths.size).toBe(0);
  });

  it('insertCells без ref — от активной ячейки, с оформлением и форматами (F11)', async () => {
    sheet.active = 'C2';
    await createSheetAdapter(fakeConnector()).insertCells(undefined, tableLayout);
    expect(sheet.text('C2')).toBe('Orders');
    expect(sheet.at('C3')).toMatchObject({
      value: 'Name',
      bold: true,
      fill: '242,242,242',
      borders: allBorders,
    });
    expect(sheet.at('D4')).toMatchObject({ value: '{d.o[i].sum:formatN(2)}', numFmt: '#,##0.00' });
    expect(sheet.at('E4')).toMatchObject({ numFmt: 'dd.mm.yyyy' });
    expect(sheet.at('A1')).toBeUndefined();
  });

  it('текст, похожий на формулу или число, пишется текстом', async () => {
    await createSheetAdapter(fakeConnector()).insertCells(
      'A1',
      gridLayout([['=SUM(A1:A2)', '+7', '-x', '@a', '12.5', '{d.x}', 'Plain']]),
    );
    for (const a of ['A1', 'B1', 'C1', 'D1', 'E1']) {
      expect(sheet.at(a)?.formula).toBeUndefined();
      expect(sheet.at(a)?.quote).toBe(true);
    }
    expect(sheet.row(1, 'G')).toEqual(['=SUM(A1:A2)', '+7', '-x', '@a', '12.5', '{d.x}', 'Plain']);
    expect(sheet.at('F1')?.quote).toBeUndefined();
  });

  it('gridLayout и textLayout', () => {
    expect(gridLayout([['a', 'b'], ['c']])).toEqual({
      rows: 2,
      cols: 2,
      widths: [],
      cells: [
        { row: 0, col: 0, value: 'a', kind: 'text', style: 'plain' },
        { row: 0, col: 1, value: 'b', kind: 'text', style: 'plain' },
        { row: 1, col: 0, value: 'c', kind: 'text', style: 'plain' },
      ],
    });
    expect(textLayout('x\r\ny')).toEqual(gridLayout([['x'], ['y']]));
  });
});

/** Простой счёт: шапка в строке 3, пять строк данных 4–8, итог в 9, подпись в B12. */
function invoiceSheet() {
  sheet.put('A1', 'Invoice No 15');
  ['Name', 'Qty', 'Sum'].forEach((t, c) => sheet.put(ref(2, c), t, { bold: true }));
  for (let r = 3; r <= 7; r++) {
    sheet.put(ref(r, 0), `Item ${r - 2}`, { borders: { Top: 'Thin' } });
    sheet.put(ref(r, 1), r, { borders: { Top: 'Thin' } });
    sheet.put(ref(r, 2), r * 100, {
      numFmt: '#,##0.00',
      display: `${r * 100},00`,
      borders: { Top: 'Thin' },
    });
  }
  sheet.put('D4', 'side', { fill: '9,9,9' });
  sheet.put('A9', 'Total', { bold: true });
  sheet.put('B9', 25);
  sheet.put('C9', 1234.5, { display: '1 234,50', numFmt: '#,##0.00', bold: true });
  sheet.put('B12', 'Signed: Ivanov');
}

const invoiceTable = (): SheetReplaceTable => ({
  key: 'l',
  grouped: false,
  firstCol: 0,
  headerRow: 2,
  firstDataRow: 3,
  lastDataRow: 7,
  rowShift: -3,
  fingerprint: { header: ['Name', 'Qty', 'Sum'], columns: 3, sample: ['Item 1', '3', '300,00'] },
  rows: [
    {
      styleFrom: 3,
      cells: ['{d.l[i].name}', '{d.l[i].qty:formatN(0)}', '{d.l[i].sum:formatN(2)}'],
    },
    { styleFrom: 3, cells: ['{d.l[i+1].name}', '', ''] },
  ],
  totals: {
    row: 8,
    cells: [
      { col: 2, tag: '{d.l[].sum:aggSum:formatN(2)}' },
      { col: 1, tag: '' },
    ],
  },
});

const items: SheetReplaceItem[] = [
  { ref: 'A1', find: '15', tag: '{d.no}' },
  { ref: 'B12', find: 'Ivanov', tag: '{d.signer}' },
];

describe('replace', () => {
  it('простая таблица: 5 строк → [i] и [i+1], итог и пункты ниже сдвинуты', async () => {
    invoiceSheet();
    const r = await createSheetAdapter(fakeConnector()).replace(items, invoiceTable());
    expect(r).toEqual({ notFound: { items: [], table: false } });
    expect(sheet.text('A1')).toBe('Invoice No {d.no}');
    expect(sheet.row(3)).toEqual(['Name', 'Qty', 'Sum', '']);
    expect(sheet.row(4)).toEqual([
      '{d.l[i].name}',
      '{d.l[i].qty:formatN(0)}',
      '{d.l[i].sum:formatN(2)}',
      '',
    ]);
    expect(sheet.row(5)).toEqual(['{d.l[i+1].name}', '', '', '']);
    // Оформление первой строки данных; вне ширины таблицы — оформление без значения.
    expect(sheet.at('C4')).toMatchObject({ numFmt: '#,##0.00', borders: { Top: 'Thin' } });
    expect(sheet.at('C5')).toMatchObject({ numFmt: '#,##0.00', borders: { Top: 'Thin' } });
    expect(sheet.at('D4')).toMatchObject({ value: '', fill: '9,9,9' });
    expect(sheet.at('D5')).toMatchObject({ value: '', fill: '9,9,9' });
    // Итог — в строке 6 (9 − 3): тег вместо числа, лишнее число очищено, текст и оформление на месте.
    expect(sheet.row(6)).toEqual(['Total', '', '{d.l[].sum:aggSum:formatN(2)}', '']);
    expect(sheet.at('C6')).toMatchObject({ bold: true, numFmt: '#,##0.00' });
    expect(sheet.text('B9')).toBe('Signed: {d.signer}');
    expect(sheet.text('B12')).toBe('');
    for (let r = 7; r <= 12; r++) if (r !== 9) expect(sheet.row(r)).toEqual(['', '', '', '']);
  });

  it('отпечаток не совпал — таблица «не найдено», пункты по исходным адресам', async () => {
    invoiceSheet();
    sheet.put('A4', 'Changed');
    const r = await createSheetAdapter(fakeConnector()).replace(items, invoiceTable());
    expect(r).toEqual({ notFound: { items: [], table: true } });
    expect(sheet.row(4)).toEqual(['Changed', '3', '300,00', 'side']);
    expect(sheet.row(8)).toEqual(['Item 5', '7', '700,00', '']);
    expect(sheet.text('C9')).toBe('1 234,50');
    expect(sheet.text('B12')).toBe('Signed: {d.signer}');
    expect(sheet.text('A1')).toBe('Invoice No {d.no}');
  });

  it('другая шапка тоже не совпадает', async () => {
    invoiceSheet();
    sheet.put('C3', 'Total sum');
    const r = await createSheetAdapter(fakeConnector()).replace([], invoiceTable());
    expect(r.notFound.table).toBe(true);
    expect(sheet.text('A5')).toBe('Item 2');
  });

  it('таблица снята (null) — пункты ниже таблицы не сдвигаются', async () => {
    invoiceSheet();
    const r = await createSheetAdapter(fakeConnector()).replace(items, null);
    expect(r).toEqual({ notFound: { items: [], table: false } });
    expect(sheet.text('B12')).toBe('Signed: {d.signer}');
    expect(sheet.text('B9')).toBe('25');
  });

  it('числовая ячейка: весь отображаемый текст → тег, часть числа → «не найдено»', async () => {
    invoiceSheet();
    const a = createSheetAdapter(fakeConnector());
    const partial = await a.replace([{ ref: 'C9', find: '234', tag: '{d.x}' }], null);
    expect(partial).toEqual({ notFound: { items: [0], table: false } });
    expect(sheet.at('C9')).toMatchObject({ value: 1234.5 });
    const whole = await a.replace(
      [{ ref: 'C9', find: '1 234,50', tag: '{d.total:formatN(2)}' }],
      null,
    );
    expect(whole).toEqual({ notFound: { items: [], table: false } });
    expect(sheet.at('C9')).toMatchObject({
      value: '{d.total:formatN(2)}',
      numFmt: '#,##0.00',
      bold: true,
    });
  });

  it('find нет в ячейке, неверный адрес — «не найдено»; два пункта в одной ячейке', async () => {
    sheet.put('A1', 'From 01 to 02');
    sheet.put('A2', 'x');
    const r = await createSheetAdapter(fakeConnector()).replace(
      [
        { ref: 'A2', find: 'y', tag: '{d.y}' },
        { ref: 'A1', find: '01', tag: '{d.a02}' },
        { ref: 'A1', find: '02', tag: '{d.b}' },
        { ref: 'bad', find: 'x', tag: '{d.z}' },
      ],
      null,
    );
    expect(r).toEqual({ notFound: { items: [0, 3], table: false } });
    // Второй пункт не задевает тег первого («02» внутри «{d.a02}»).
    expect(sheet.text('A1')).toBe('From {d.a02} to {d.b}');
  });

  it('используемая область не с A1 и правее Z: таблица по смещённым колонкам', async () => {
    sheet.put('C3', 'Report');
    ['Name', 'Sum'].forEach((t, i) => sheet.put(ref(4, 26 + i), t));
    for (let r = 5; r <= 7; r++) {
      sheet.put(ref(r, 26), `N${r}`);
      sheet.put(ref(r, 27), r, { numFmt: '0' });
    }
    sheet.put('AB9', 'Done');
    const table: SheetReplaceTable = {
      key: 'x',
      grouped: false,
      firstCol: 26,
      headerRow: 4,
      firstDataRow: 5,
      lastDataRow: 7,
      rowShift: -1,
      fingerprint: { header: ['Name', 'Sum'], columns: 2, sample: ['N5', '5'] },
      rows: [
        { styleFrom: 5, cells: ['{d.x[i].n}', '{d.x[i].s}'] },
        { styleFrom: 5, cells: ['{d.x[i+1].n}', ''] },
      ],
      totals: null,
    };
    const r = await createSheetAdapter(fakeConnector()).replace(
      [{ ref: 'AB9', find: 'Done', tag: '{d.done}' }],
      table,
    );
    expect(r).toEqual({ notFound: { items: [], table: false } });
    expect(sheet.text('AA6')).toBe('{d.x[i].n}');
    expect(sheet.text('AB7')).toBe('');
    expect(sheet.at('AB7')).toMatchObject({ numFmt: '0' });
    expect(sheet.text('AA7')).toBe('{d.x[i+1].n}');
    expect(sheet.text('AA8')).toBe('');
    expect(sheet.text('AB8')).toBe('{d.done}');
    expect(sheet.text('C3')).toBe('Report');
  });

  it('таблица с подитогами: 5 строк, подитог с оформлением строки подитога примера', async () => {
    ['Contractor', 'Date', 'Sum'].forEach((t, c) => sheet.put(ref(0, c), t, { bold: true }));
    const group = (r: number, name: string) => sheet.put(ref(r, 0), name, { fill: '255,255,0' });
    const data = (r: number, d: string, s: number) => {
      sheet.put(ref(r, 1), d);
      sheet.put(ref(r, 2), s, { numFmt: '#,##0.00' });
    };
    const sub = (r: number, s: number) => {
      sheet.put(ref(r, 0), 'Subtotal', { bold: true, fill: '200,200,200' });
      sheet.put(ref(r, 2), s, { bold: true, fill: '200,200,200' });
    };
    group(1, 'ACME');
    data(2, '01.01.2026', 100);
    data(3, '02.01.2026', 200);
    sub(4, 300);
    group(5, 'Beta');
    data(6, '03.01.2026', 50);
    sub(7, 50);
    sheet.put('A9', 'Total');
    sheet.put('C9', 350);
    const table: SheetReplaceTable = {
      key: 'g',
      grouped: true,
      firstCol: 0,
      headerRow: 0,
      firstDataRow: 1,
      lastDataRow: 7,
      rowShift: -2,
      fingerprint: { header: ['Contractor', 'Date', 'Sum'], columns: 3, sample: ['ACME', '', ''] },
      rows: [
        { styleFrom: 1, cells: ['{d.g[i].name}', '', ''] },
        {
          styleFrom: 2,
          cells: ['', '{d.g[i].rows[i].date:cellDate}', '{d.g[i].rows[i].sum:formatN(2)}'],
        },
        { styleFrom: 2, cells: ['', '{d.g[i].rows[i+1].date:cellDate}', ''] },
        { styleFrom: 4, cells: [null, '', '{d.g[i].rows[].sum:aggSum:formatN(2)}'] },
        { styleFrom: 1, cells: ['{d.g[i+1].name}', '', ''] },
      ],
      totals: { row: 8, cells: [{ col: 2, tag: '{d.g[].rows[].sum:aggSum:formatN(2)}' }] },
    };
    const r = await createSheetAdapter(fakeConnector()).replace([], table);
    expect(r.notFound.table).toBe(false);
    expect(sheet.row(2, 'C')).toEqual(['{d.g[i].name}', '', '']);
    expect(sheet.row(3, 'C')).toEqual([
      '',
      '{d.g[i].rows[i].date:cellDate}',
      '{d.g[i].rows[i].sum:formatN(2)}',
    ]);
    expect(sheet.row(5, 'C')).toEqual(['Subtotal', '', '{d.g[i].rows[].sum:aggSum:formatN(2)}']);
    expect(sheet.at('A5')).toMatchObject({ bold: true, fill: '200,200,200' });
    expect(sheet.at('C5')).toMatchObject({ bold: true, fill: '200,200,200' });
    expect(sheet.at('A2')).toMatchObject({ fill: '255,255,0' });
    expect(sheet.at('C3')).toMatchObject({ numFmt: '#,##0.00' });
    expect(sheet.row(6, 'C')).toEqual(['{d.g[i+1].name}', '', '']);
    expect(sheet.row(7, 'C')).toEqual(['Total', '', '{d.g[].rows[].sum:aggSum:formatN(2)}']);
    expect(sheet.row(8, 'C')).toEqual(['', '', '']);
  });
});

describe('replace: нет методов Spreadsheet API (final #8)', () => {
  const proto = FakeRange.prototype as unknown as Record<string, unknown>;
  const without = async (names: string[], run: () => Promise<unknown>) => {
    const saved = names.map((n) => [n, proto[n]] as const);
    for (const n of names) proto[n] = undefined;
    try {
      return await run();
    } finally {
      for (const [n, f] of saved) proto[n] = f;
    }
  };
  const untouched = () => {
    expect(sheet.row(4)).toEqual(['Item 1', '3', '300,00', 'side']);
    expect(sheet.row(8)).toEqual(['Item 5', '7', '700,00', '']);
    expect(sheet.text('A1')).toBe('Invoice No 15');
    expect(sheet.text('B12')).toBe('Signed: Ivanov');
  };

  it('нет Delete — ошибка до первого изменения, лист не тронут', async () => {
    invoiceSheet();
    await expect(
      without(['Delete'], () => createSheetAdapter(fakeConnector()).replace(items, invoiceTable())),
    ).rejects.toThrow('Delete');
    untouched();
  });

  it('нет ни Copy, ни GetValue — ошибка, лист не тронут; без Copy с GetValue — запасной путь', async () => {
    invoiceSheet();
    await expect(
      without(['Copy', 'GetValue'], () =>
        createSheetAdapter(fakeConnector()).replace(items, invoiceTable()),
      ),
    ).rejects.toThrow('Copy');
    untouched();
    const r = await without(['Copy'], () =>
      createSheetAdapter(fakeConnector()).replace(items, invoiceTable()),
    );
    expect(r).toEqual({ notFound: { items: [], table: false } });
  });
});

describe('ошибки и жизненный цикл', () => {
  it('ошибка внутри команды — отклонённый Promise', async () => {
    g.Api = {
      GetActiveSheet: () => {
        throw new Error('boom');
      },
    };
    await expect(createSheetAdapter(fakeConnector()).snapshot()).rejects.toThrow('boom');
  });

  it('dispose отключает connector, дальнейшие вызовы отклоняются', async () => {
    const c = fakeConnector();
    const a = createSheetAdapter(c);
    a.dispose();
    expect(c.disconnected).toBe(true);
    await expect(a.snapshot()).rejects.toThrow();
  });

  it('команда без ответа отклоняется через 10 с, следующая команда выполняется', async () => {
    vi.useFakeTimers();
    try {
      const real = fakeConnector();
      let calls = 0;
      const c: Connector = {
        ...real,
        callCommand: (fn, cb) => {
          if (calls++ === 0) return;
          real.callCommand(fn, cb);
        },
      };
      const a = createSheetAdapter(c);
      const first = a.snapshot();
      const firstDone = expect(first).rejects.toThrow('command timeout');
      const second = a.snapshot();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await firstDone;
      await expect(second).resolves.toHaveProperty('cells');
    } finally {
      vi.useRealTimers();
    }
  });
});
