import type { ReplaceTable } from '@carbone-reports/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAdapter, type Connector } from './documentAdapter';

/* Фейковый Office JS API (Document) в памяти: те же классы и методы, что использует адаптер,
 * метод в метод (https://api.onlyoffice.com/docs/office-api/usage-api/document-api/). */

class FakeParagraph {
  text = '';
  style: string | null = null;
  constructor(text = '') {
    this.text = text;
  }
  GetClassType() {
    return 'paragraph';
  }
  GetText() {
    return this.text;
  }
  AddText(t: string) {
    this.text += t;
  }
  RemoveAllElements() {
    this.text = '';
  }
  SetStyle(s: { name: string }) {
    this.style = s.name;
  }
}

class FakeContent {
  elements: (FakeParagraph | FakeTable)[] = [];
  constructor(elements: (FakeParagraph | FakeTable)[] = []) {
    this.elements = elements;
  }
  GetElementsCount() {
    return this.elements.length;
  }
  GetElement(i: number) {
    return this.elements[i];
  }
  Push(e: FakeParagraph | FakeTable) {
    this.elements.push(e);
  }
  RemoveElement(i: number) {
    this.elements.splice(i, 1);
  }
  RemoveAllElements() {
    this.elements = [];
  }
}

class FakeCell {
  content: FakeContent;
  constructor(
    public row: FakeRow,
    text: string,
  ) {
    this.content = new FakeContent([new FakeParagraph(text)]);
  }
  GetContent() {
    return this.content;
  }
  SetText(t: string) {
    this.content.elements = [new FakeParagraph(t)];
  }
}

class FakeRow {
  cells: FakeCell[];
  constructor(texts: string[]) {
    this.cells = texts.map((t) => new FakeCell(this, t));
  }
  GetCellsCount() {
    return this.cells.length;
  }
  GetCell(c: number) {
    return this.cells[c];
  }
}

class FakeTable {
  rows: FakeRow[];
  constructor(rows: string[][]) {
    this.rows = rows.map((r) => new FakeRow(r));
  }
  GetClassType() {
    return 'table';
  }
  GetRowsCount() {
    return this.rows.length;
  }
  GetRow(r: number) {
    return this.rows[r];
  }
  RemoveRow(cell: FakeCell) {
    this.rows.splice(this.rows.indexOf(cell.row), 1);
    return true;
  }
  AddRow(cell: FakeCell, isBefore = false) {
    const row = new FakeRow(cell.row.cells.map(() => ''));
    const at = this.rows.indexOf(cell.row) + (isBefore ? 0 : 1);
    this.rows.splice(at, 0, row);
    return row;
  }
  texts() {
    return this.rows.map((r) =>
      r.cells.map((c) => c.content.elements.map((p) => (p as FakeParagraph).text).join('\n')),
    );
  }
}

class FakeSection {
  constructor(
    public header: FakeContent | null,
    public footer: FakeContent | null,
  ) {}
  GetHeader(type: string, isCreate = false) {
    expect(type).toBe('default');
    expect(isCreate).toBe(false);
    return this.header;
  }
  GetFooter(type: string, isCreate = false) {
    expect(type).toBe('default');
    expect(isCreate).toBe(false);
    return this.footer;
  }
}

class FakeDocument extends FakeContent {
  section = new FakeSection(null, null);
  /** Куда InsertContent вставляет (позиция курсора). */
  cursor = 0;
  /** Как ApiDocument: после очистки остаётся один пустой абзац (документ не бывает пустым). */
  RemoveAllElements() {
    this.elements = [new FakeParagraph()];
  }
  GetFinalSection() {
    return this.section;
  }
  GetStyle(name: string) {
    return name.startsWith('Heading ') ? { name } : null;
  }
  InsertContent(content: (FakeParagraph | FakeTable)[]) {
    this.elements.splice(this.cursor, 0, ...content);
    return true;
  }
  /** Предположение (проверить на DE, Task 9): замена действует и на колонтитулы. */
  SearchAndReplace(p: { searchString: string; replaceString: string; matchCase?: boolean }) {
    expect(p.matchCase).toBe(true);
    const walk = (content: FakeContent | null) => {
      for (const e of content?.elements ?? []) {
        if (e instanceof FakeParagraph) e.text = e.text.split(p.searchString).join(p.replaceString);
        else for (const r of e.rows) for (const c of r.cells) walk(c.content);
      }
    };
    walk(this);
    walk(this.section.header);
    walk(this.section.footer);
    return true;
  }
}

let doc: FakeDocument;
/** true — порядок аргументов CreateTable до 9.4.0 (cols, rows). */
let legacyCreateTable = false;

const fakeApi = {
  GetDocument: () => doc,
  CreateParagraph: () => new FakeParagraph(),
  CreateTable: (a: number, b: number) => {
    const [rows, cols] = legacyCreateTable ? [b, a] : [a, b];
    return new FakeTable(
      Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
    );
  },
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

const p = (t: string) => new FakeParagraph(t);
const texts = (content: FakeContent) =>
  content.elements.map((e) => (e instanceof FakeParagraph ? e.text : e.texts()));

beforeEach(() => {
  doc = new FakeDocument();
  legacyCreateTable = false;
  g.Api = fakeApi;
});
afterEach(() => {
  delete g.Api;
  delete g.Asc;
});

describe('snapshot', () => {
  it('тело, затем верхний и нижний колонтитулы, с областью', async () => {
    doc.elements = [
      p('Invoice No 15'),
      new FakeTable([
        ['Name', 'Qty'],
        ['Pen', '2'],
      ]),
    ];
    doc.section = new FakeSection(new FakeContent([p('ACME Ltd')]), new FakeContent([p('Page')]));
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    expect(s).toEqual({
      truncated: false,
      blocks: [
        { type: 'p', text: 'Invoice No 15', area: 'body' },
        {
          type: 'table',
          rows: [
            ['Name', 'Qty'],
            ['Pen', '2'],
          ],
          area: 'body',
        },
        { type: 'p', text: 'ACME Ltd', area: 'header' },
        { type: 'p', text: 'Page', area: 'footer' },
      ],
    });
  });

  it('ячейка обрезается до 500 символов, после 30 000 символов — truncated', async () => {
    doc.elements = [
      new FakeTable([['x'.repeat(600)]]),
      p('a'.repeat(29_000)),
      p('b'.repeat(2_000)),
      p('c'),
    ];
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.blocks[0]).toEqual({ type: 'table', rows: [['x'.repeat(500)]], area: 'body' });
    expect(s.blocks).toHaveLength(3);
    expect(s.blocks[2]).toEqual({ type: 'p', text: 'b'.repeat(500), area: 'body' });
  });

  it('не больше 30 таблиц: дальше truncated (номера блоков не сдвигаются)', async () => {
    doc.elements = Array.from({ length: 31 }, () => new FakeTable([['t']]));
    doc.elements.push(p('after'));
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.blocks).toHaveLength(30);
  });

  it('2001 пустой абзац — 2000 блоков и truncated', async () => {
    doc.elements = Array.from({ length: 2001 }, () => p(''));
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.blocks).toHaveLength(2000);
  });

  it('таблица в 501 строку — первые 500 строк и truncated, дальше блоков нет', async () => {
    doc.elements = [
      new FakeTable(Array.from({ length: 501 }, (_, i) => [String(i), ''])),
      p('after'),
    ];
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    expect(s.truncated).toBe(true);
    expect(s.blocks).toHaveLength(1);
    const rows = (s.blocks[0] as { rows: string[][] }).rows;
    expect(rows).toHaveLength(500);
    expect(rows[499]).toEqual(['499', '']);
  });

  it('пустые абзацы и ячейки тратят бюджет символов (по 1)', async () => {
    doc.elements = [
      p('a'.repeat(29_990)),
      new FakeTable(Array.from({ length: 4 }, () => ['', ''])),
      p(''),
      p(''),
      p(''),
    ];
    const s = await createDocumentAdapter(fakeConnector()).snapshot();
    // 29 990 + 8 ячеек + 2 абзаца = 30 000; третий пустой абзац не помещается.
    expect(s.truncated).toBe(true);
    expect(s.blocks).toHaveLength(4);
  });
});

describe('вставка', () => {
  it('insertTags — абзац на строку в позиции курсора', async () => {
    doc.elements = [p('start'), p('end')];
    doc.cursor = 1;
    await createDocumentAdapter(fakeConnector()).insertTags('{d.a}\n{d.b}');
    expect(texts(doc)).toEqual(['start', '{d.a}', '{d.b}', 'end']);
  });

  it('insertTable — таблица rows × cols', async () => {
    const rows = [
      ['Name', 'Qty'],
      ['{d.items[i].name}', '{d.items[i].qty}'],
      ['{d.items[i+1].name}', ''],
    ];
    await createDocumentAdapter(fakeConnector()).insertTable(rows);
    expect(texts(doc)).toEqual([rows]);
  });

  it('insertTable — порядок аргументов CreateTable до 9.4.0 (cols, rows) тоже даёт 3 × 2', async () => {
    legacyCreateTable = true;
    const rows = [
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ];
    await createDocumentAdapter(fakeConnector()).insertTable(rows);
    expect(texts(doc)).toEqual([rows]);
  });
});

describe('replaceAll', () => {
  it('тело — заголовки, абзацы и таблица; колонтитулы не тронуты', async () => {
    doc.elements = [p('old'), new FakeTable([['x']])];
    const header = new FakeContent([p('ACME Ltd')]);
    doc.section = new FakeSection(header, null);
    await createDocumentAdapter(fakeConnector()).replaceAll([
      { type: 'heading', level: 2, text: 'Invoice {d.no}' },
      { type: 'p', text: 'Client: {d.client}' },
      {
        type: 'table',
        key: 'items',
        rows: [['Name'], ['{d.items[i].name}'], ['{d.items[i+1].name}']],
      },
    ]);
    expect(texts(doc)).toEqual([
      'Invoice {d.no}',
      'Client: {d.client}',
      [['Name'], ['{d.items[i].name}'], ['{d.items[i+1].name}']],
    ]);
    expect((doc.elements[0] as FakeParagraph).style).toBe('Heading 2');
    expect((doc.elements[1] as FakeParagraph).style).toBeNull();
    expect(texts(header)).toEqual(['ACME Ltd']);
  });
});

describe('replace', () => {
  const table = (block: number, header = [['Name', 'Qty']]): ReplaceTable => ({
    block,
    headerRows: header.length,
    key: 'items',
    fingerprint: { header, columns: 2, sample: ['Pen', '2'] },
    rowTags: ['{d.items[i].name}', null],
    serviceRow: ['{d.items[i+1].name}', ''],
  });
  const item = (find: string, tag: string) => ({ find, tag, count: 1 });

  function fill() {
    doc.elements = [
      p('Invoice No 15 for ACME Ltd'),
      new FakeTable([
        ['Name', 'Qty'],
        ['Pen', '2'],
        ['Pencil', '3'],
        ['Total', '5'],
      ]),
    ];
    doc.section = new FakeSection(new FakeContent([p('ACME Ltd')]), null);
  }

  it('таблица: заголовок + [i] + [i+1], прочие строки удалены; затем значения заменены везде', async () => {
    fill();
    const r = await createDocumentAdapter(fakeConnector()).replace(
      [item('ACME Ltd', '{d.company}'), item('No 15', 'No {d.no}')],
      [table(1)],
    );
    expect(r).toEqual({ notFound: { items: [], tables: [] } });
    expect(texts(doc)).toEqual([
      'Invoice No {d.no} for {d.company}',
      [
        ['Name', 'Qty'],
        ['{d.items[i].name}', '2'],
        ['{d.items[i+1].name}', ''],
      ],
    ]);
    expect(texts(doc.section.header!)).toEqual(['{d.company}']);
  });

  it('без ApiTableCell.SetText — текст ячейки через её первый абзац', async () => {
    fill();
    const proto = FakeCell.prototype as { SetText?: unknown };
    const setText = proto.SetText;
    proto.SetText = undefined;
    try {
      (doc.elements[1] as FakeTable).rows[1]!.cells[0]!.content.Push(p('second line'));
      // Снимок видел ячейку с двумя абзацами — в отпечатке тот же текст.
      const t = table(1);
      t.fingerprint.sample = ['Pen\nsecond line', '2'];
      await createDocumentAdapter(fakeConnector()).replace([], [t]);
    } finally {
      proto.SetText = setText;
    }
    expect((doc.elements[1] as FakeTable).texts()).toEqual([
      ['Name', 'Qty'],
      ['{d.items[i].name}', '2'],
      ['{d.items[i+1].name}', ''],
    ]);
  });

  it('следующая замена не задевает тег, вставленный предыдущей', async () => {
    doc.elements = [p('Total 5 000,00'), p('Qty 2'), p('No 15')];
    const r = await createDocumentAdapter(fakeConnector()).replace(
      [item('5 000,00', '{d.total:formatN(2)}'), item('2', '{d.qty}'), item('No', '{d.no}')],
      [],
    );
    expect(r.notFound.items).toEqual([]);
    expect(texts(doc)).toEqual(['Total {d.total:formatN(2)}', 'Qty {d.qty}', '{d.no} 15']);
  });

  it('значения не задевают теги, вставленные в таблицу', async () => {
    fill();
    const r = await createDocumentAdapter(fakeConnector()).replace([item('name', 'X')], [table(1)]);
    // «name» до замены в документе не было (регистр учитывается) — не найдено, теги целы.
    expect(r.notFound.items).toEqual([0]);
    expect((doc.elements[1] as FakeTable).texts()[1]![0]).toBe('{d.items[i].name}');
  });

  it('таблица сдвинулась — найдена по отпечатку', async () => {
    fill();
    doc.elements.unshift(p('inserted'));
    const r = await createDocumentAdapter(fakeConnector()).replace([], [table(1)]);
    expect(r.notFound.tables).toEqual([]);
    expect((doc.elements[2] as FakeTable).texts()).toHaveLength(3);
  });

  it('заголовок таблицы изменён — она в notFound.tables, остальное применено', async () => {
    fill();
    const r = await createDocumentAdapter(fakeConnector()).replace(
      [item('ACME Ltd', '{d.company}')],
      [table(1, [['Title', 'Qty']])],
    );
    expect(r).toEqual({ notFound: { items: [], tables: [0] } });
    expect((doc.elements[1] as FakeTable).texts()).toHaveLength(4);
    expect(texts(doc)[0]).toBe('Invoice No 15 for {d.company}');
  });

  it('строка [i] изменена (текст не совпадает с отпечатком) — таблица в notFound.tables', async () => {
    fill();
    (doc.elements[1] as FakeTable).rows[1]!.cells[0]!.SetText('Marker');
    const r = await createDocumentAdapter(fakeConnector()).replace([], [table(1)]);
    expect(r.notFound.tables).toEqual([0]);
    expect((doc.elements[1] as FakeTable).texts()).toHaveLength(4);
  });

  it('headerRows 0: только точный номер блока, без поиска по другим таблицам', async () => {
    const t0 = (): ReplaceTable => ({
      block: 2,
      headerRows: 0,
      key: 'items',
      fingerprint: { header: [], columns: 2, sample: ['x', 'y'] },
      rowTags: ['{d.items[i].a}', '{d.items[i].b}'],
      serviceRow: ['{d.items[i+1].a}', ''],
    });
    const make = () => [
      p('title'),
      new FakeTable([
        ['a', 'b'],
        ['c', 'd'],
      ]),
      new FakeTable([
        ['x', 'y'],
        ['z', 'w'],
      ]),
    ];
    // Таблица на своём месте — преобразована.
    doc.elements = make();
    let r = await createDocumentAdapter(fakeConnector()).replace([], [t0()]);
    expect(r.notFound.tables).toEqual([]);
    expect((doc.elements[2] as FakeTable).texts()).toEqual([
      ['{d.items[i].a}', '{d.items[i].b}'],
      ['{d.items[i+1].a}', ''],
    ]);
    // Документ сдвинулся: под номером 2 — другая таблица с тем же числом колонок; её данные
    // не удаляются, искать по отпечатку без заголовка нельзя.
    doc.elements = make();
    doc.elements.unshift(p('inserted'));
    r = await createDocumentAdapter(fakeConnector()).replace([], [t0()]);
    expect(r.notFound.tables).toEqual([0]);
    expect((doc.elements[2] as FakeTable).texts()).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect((doc.elements[3] as FakeTable).texts()).toEqual([
      ['x', 'y'],
      ['z', 'w'],
    ]);
  });

  it('find, которого нет в документе, — в notFound.items', async () => {
    fill();
    const r = await createDocumentAdapter(fakeConnector()).replace(
      [item('missing', '{d.x}'), item('ACME Ltd', '{d.company}')],
      [],
    );
    expect(r).toEqual({ notFound: { items: [0], tables: [] } });
  });
});

describe('ошибки и жизненный цикл', () => {
  it('ошибка внутри команды — отклонённый Promise', async () => {
    g.Api = {
      GetDocument: () => {
        throw new Error('boom');
      },
    };
    await expect(createDocumentAdapter(fakeConnector()).snapshot()).rejects.toThrow('boom');
  });

  it('dispose отключает connector, дальнейшие вызовы отклоняются', async () => {
    const c = fakeConnector();
    const a = createDocumentAdapter(c);
    a.dispose();
    expect(c.disconnected).toBe(true);
    await expect(a.snapshot()).rejects.toThrow();
  });

  it('команда без ответа отклоняется через 10 с, следующая команда выполняется', async () => {
    vi.useFakeTimers();
    try {
      const real = fakeConnector();
      let calls = 0;
      // Первый вызов connector «теряет» (колбэк не приходит), дальше — как настоящий.
      const c: Connector = {
        ...real,
        callCommand: (fn, cb) => {
          if (calls++ === 0) return;
          real.callCommand(fn, cb);
        },
      };
      const a = createDocumentAdapter(c);
      const first = a.snapshot();
      const firstDone = expect(first).rejects.toThrow(/timeout/);
      const second = a.snapshot();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await firstDone;
      await expect(second).resolves.toHaveProperty('blocks');
    } finally {
      vi.useRealTimers();
    }
  });
});
