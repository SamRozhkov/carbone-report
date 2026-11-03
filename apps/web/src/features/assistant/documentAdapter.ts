import type { DocBlock, ReplaceItem, ReplaceTable } from '@carbone-reports/shared';
import { DOC_SNAPSHOT_LIMITS, DocSnapshot } from '@carbone-reports/shared';

/* Адаптер документа поверх connector OnlyOffice (Automation API, §52.5).
 *
 * Команды для callCommand исполняются в редакторе изолированно: OnlyOffice передаёт туда текст
 * функции, поэтому внутри нет ни замыканий, ни импортов — только глобальные Api и Asc. Входные
 * данные — через Asc.scope (сериализуется в JSON), результат — возвращаемым значением (простой
 * JSON); всё тело в try/catch, ошибка → {error}. Вспомогательные функции поэтому объявлены
 * внутри каждой команды, обход документа повторяется в snapshot и replace.
 *
 * Номера блоков (ReplaceTable.block, снимок, get_document на сервере): абзацы и таблицы верхнего
 * уровня по порядку — сначала тело документа, затем верхний колонтитул, затем нижний (последняя
 * секция, тип 'default'). Прочие элементы (блочные элементы управления) не нумеруются. Снимок при
 * усечении — всегда начало этой последовательности, поэтому номера в нём совпадают с полным обходом.
 *
 * Методы Office JS API (Document), сверены с https://api.onlyoffice.com/docs/office-api/:
 * Api.GetDocument/CreateParagraph/CreateTable, ApiDocument.GetElementsCount/GetElement/
 * GetFinalSection/GetStyle/InsertContent/RemoveAllElements/Push/SearchAndReplace,
 * ApiSection.GetHeader/GetFooter, ApiParagraph.GetClassType/GetText/AddText/RemoveAllElements/
 * SetStyle, ApiTable.GetRowsCount/GetRow/RemoveRow/AddRow, ApiTableRow.GetCellsCount/GetCell,
 * ApiTableCell.GetContent/SetText, ApiDocumentContent.GetElementsCount/GetElement/RemoveElement. */

/** Connector редактора (docEditor.createConnector()). */
export interface Connector {
  callCommand(fn: () => unknown, cb: (r: unknown) => void): void;
  executeMethod(name: string, args: unknown[], cb?: (r: unknown) => void): void;
  disconnect(): void;
}

export interface DocumentAdapter {
  snapshot(): Promise<DocSnapshot>;
  /** Абзац на каждую строку текста — в позицию курсора (вместо выделения). */
  insertTags(text: string): Promise<void>;
  /** Таблица rows × cols — в позицию курсора (вместо выделения). */
  insertTable(rows: string[][]): Promise<void>;
  /** Всё тело документа заменяется блоками; колонтитулы не трогаются. */
  replaceAll(blocks: DocBlock[]): Promise<void>;
  /** Индексы items и tables, которые не нашлись в документе. */
  replace(
    items: ReplaceItem[],
    tables: ReplaceTable[],
  ): Promise<{ notFound: { items: number[]; tables: number[] } }>;
  dispose(): void;
}

/* Минимальные типы Office JS API — только то, что вызывают команды ниже. */
interface OoParagraph {
  GetClassType(): 'paragraph';
  GetText(): string;
  AddText(text: string): unknown;
  RemoveAllElements(): unknown;
  SetStyle(style: unknown): unknown;
}
interface OoTableCell {
  GetContent(): OoContent;
  SetText?(text: string): unknown;
}
interface OoTableRow {
  GetCellsCount(): number;
  GetCell(c: number): OoTableCell;
}
interface OoTable {
  GetClassType(): 'table';
  GetRowsCount(): number;
  GetRow(r: number): OoTableRow;
  RemoveRow(cell: OoTableCell): boolean;
  AddRow(cell?: OoTableCell, isBefore?: boolean): OoTableRow;
}
type OoElement = OoParagraph | OoTable | { GetClassType(): string };
interface OoContent {
  GetElementsCount(): number;
  GetElement(i: number): OoElement;
  RemoveElement(i: number): unknown;
  RemoveAllElements(): unknown;
  Push(e: OoParagraph | OoTable): unknown;
}
interface OoDocument extends OoContent {
  GetFinalSection(): {
    GetHeader(type: string, isCreate?: boolean): OoContent | null | undefined;
    GetFooter(type: string, isCreate?: boolean): OoContent | null | undefined;
  };
  GetStyle(name: string): unknown;
  InsertContent(content: (OoParagraph | OoTable)[]): boolean;
  SearchAndReplace(p: { searchString: string; replaceString: string; matchCase: boolean }): boolean;
}
declare const Api: {
  GetDocument(): OoDocument;
  CreateParagraph(): OoParagraph;
  CreateTable(a: number, b: number): OoTable;
};
declare const Asc: { scope: Record<string, unknown> };

// ---------- Команды (исполняются в редакторе, без замыканий) ----------

function snapshotCommand(): unknown {
  try {
    // Лимиты — DOC_SNAPSHOT_LIMITS через Asc.scope (импорт внутри команды недоступен).
    const limits = Asc.scope.limits as {
      chars: number;
      cell: number;
      tables: number;
      blocks: number;
      rows: number;
    };
    // В тексте абзаца OnlyOffice может вернуть завершающий перевод строки — отбрасываем.
    const paraText = (p: OoParagraph) => String(p.GetText()).replace(/[\r\n]+$/, '');
    const cellText = (cell: OoTableCell) => {
      const content = cell.GetContent();
      const parts: string[] = [];
      for (let i = 0; i < content.GetElementsCount(); i++) {
        const e = content.GetElement(i);
        if (e.GetClassType() === 'paragraph') parts.push(paraText(e as OoParagraph));
      }
      return parts.join('\n');
    };
    const doc = Api.GetDocument();
    const section = doc.GetFinalSection();
    const areas: [string, OoContent | null | undefined][] = [
      ['body', doc],
      ['header', section.GetHeader('default', false)],
      ['footer', section.GetFooter('default', false)],
    ];
    const blocks: unknown[] = [];
    // Пустой абзац и пустая ячейка тоже тратят бюджет — по 1 символу, как в схеме DocSnapshot.
    let left = limits.chars;
    let tables = 0;
    let truncated = false;
    outer: for (const [area, content] of areas) {
      if (!content) continue;
      for (let i = 0; i < content.GetElementsCount(); i++) {
        const e = content.GetElement(i);
        const type = e.GetClassType();
        if (type !== 'paragraph' && type !== 'table') continue;
        if (blocks.length === limits.blocks) {
          truncated = true;
          break outer;
        }
        if (type === 'paragraph') {
          const text = paraText(e as OoParagraph);
          const size = Math.max(1, text.length);
          if (size > left) {
            if (left > 0 && text.length > 0)
              blocks.push({ type: 'p', text: text.slice(0, left), area });
            truncated = true;
            break outer;
          }
          left -= size;
          blocks.push({ type: 'p', text, area });
        } else {
          if (tables === limits.tables) {
            truncated = true;
            break outer;
          }
          tables += 1;
          const t = e as OoTable;
          const rows: string[][] = [];
          // Таблица целиком, если и строки, и символы в пределах; иначе — начало и конец снимка.
          let full = true;
          for (let r = 0; r < t.GetRowsCount() && full; r++) {
            if (r === limits.rows) {
              full = false;
              break;
            }
            const row = t.GetRow(r);
            const cells: string[] = [];
            for (let c = 0; c < row.GetCellsCount(); c++)
              cells.push(cellText(row.GetCell(c)).slice(0, limits.cell));
            const size = cells.reduce((s, x) => s + Math.max(1, x.length), 0);
            if (size > left) full = false;
            else {
              left -= size;
              rows.push(cells);
            }
          }
          blocks.push({ type: 'table', rows, area });
          if (!full) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    return { blocks, truncated };
  } catch (e) {
    return { error: String(e) };
  }
}

function insertTagsCommand(): unknown {
  try {
    const lines = Asc.scope.lines as string[];
    const paras = lines.map((line) => {
      const p = Api.CreateParagraph();
      if (line) p.AddText(line);
      return p;
    });
    Api.GetDocument().InsertContent(paras);
    return { ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

function insertTableCommand(): unknown {
  try {
    const rows = Asc.scope.rows as string[][];
    const cols = Math.max(1, ...rows.map((r) => r.length));
    // С 9.4.0 CreateTable(rows, cols), раньше — (cols, rows): проверяем результат.
    let table = Api.CreateTable(rows.length, cols);
    if (table.GetRowsCount() !== rows.length) table = Api.CreateTable(cols, rows.length);
    rows.forEach((r, i) =>
      r.forEach((text, c) => {
        const cell = table.GetRow(i).GetCell(c);
        if (cell.SetText) cell.SetText(text);
        else {
          const p = cell.GetContent().GetElement(0) as OoParagraph;
          p.RemoveAllElements();
          if (text) p.AddText(text);
        }
      }),
    );
    Api.GetDocument().InsertContent([table]);
    return { ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

function replaceAllCommand(): unknown {
  try {
    const blocks = Asc.scope.blocks as DocBlock[];
    const doc = Api.GetDocument();
    doc.RemoveAllElements();
    // После очистки в документе остаётся пустой абзац (документ не бывает пустым): убираем его
    // после вставки блоков, чтобы тело не начиналось с пустой строки.
    const left = doc.GetElementsCount();
    for (const b of blocks) {
      if (b.type === 'table') {
        const cols = Math.max(1, ...b.rows.map((r) => r.length));
        let table = Api.CreateTable(b.rows.length, cols);
        if (table.GetRowsCount() !== b.rows.length) table = Api.CreateTable(cols, b.rows.length);
        b.rows.forEach((r, i) =>
          r.forEach((text, c) => {
            const cell = table.GetRow(i).GetCell(c);
            if (cell.SetText) cell.SetText(text);
            else {
              const p = cell.GetContent().GetElement(0) as OoParagraph;
              p.RemoveAllElements();
              if (text) p.AddText(text);
            }
          }),
        );
        doc.Push(table);
        continue;
      }
      const p = Api.CreateParagraph();
      if (b.text) p.AddText(b.text);
      if (b.type === 'heading') {
        const style = doc.GetStyle('Heading ' + b.level);
        if (style) p.SetStyle(style);
      }
      doc.Push(p);
    }
    if (blocks.length)
      for (let i = left - 1; i >= 0; i--) {
        const e = doc.GetElement(i);
        if (e.GetClassType() === 'paragraph' && !(e as OoParagraph).GetText().trim())
          doc.RemoveElement(i);
      }
    return { ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Порядок (§52.4, решение контроллера): сначала найти все таблицы (по номеру блока со сверкой
 *  отпечатка, иначе — если есть строки заголовка — по отпечатку среди всех таблиц), затем
 *  заменить значения, затем преобразовать найденные таблицы. Так значения не задевают вставленные
 *  теги {d.key[i].col}, а замена значений в заголовке таблицы не мешает её найти. Всё в одной команде — ссылки на таблицы сохраняются. */
function replaceCommand(): unknown {
  try {
    const MAX_CELL = 500;
    const items = Asc.scope.items as { find: string; tag: string }[];
    const tables = Asc.scope.tables as ReplaceTable[];
    const paraText = (p: OoParagraph) => String(p.GetText()).replace(/[\r\n]+$/, '');
    const cellText = (cell: OoTableCell) => {
      const content = cell.GetContent();
      const parts: string[] = [];
      for (let i = 0; i < content.GetElementsCount(); i++) {
        const e = content.GetElement(i);
        if (e.GetClassType() === 'paragraph') parts.push(paraText(e as OoParagraph));
      }
      return parts.join('\n');
    };
    const setCell = (cell: OoTableCell, text: string) => {
      if (cell.SetText) {
        cell.SetText(text);
        return;
      }
      // Без SetText: первый абзац ячейки (его оформление абзаца остаётся), остальные удаляются.
      const content = cell.GetContent();
      for (let i = content.GetElementsCount() - 1; i > 0; i--) content.RemoveElement(i);
      const p = content.GetElement(0) as OoParagraph;
      p.RemoveAllElements();
      if (text) p.AddText(text);
    };

    const doc = Api.GetDocument();
    const section = doc.GetFinalSection();
    const areas = [doc, section.GetHeader('default', false), section.GetFooter('default', false)];
    // Блоки в той же нумерации, что снимок; заодно — все тексты абзацев (с ячейками) для поиска.
    const blocks: OoElement[] = [];
    const texts: string[] = [];
    const collect = (content: OoContent, top: boolean) => {
      for (let i = 0; i < content.GetElementsCount(); i++) {
        const e = content.GetElement(i);
        const type = e.GetClassType();
        if (type === 'paragraph') texts.push(paraText(e as OoParagraph));
        else if (type === 'table') {
          const t = e as OoTable;
          for (let r = 0; r < t.GetRowsCount(); r++) {
            const row = t.GetRow(r);
            for (let c = 0; c < row.GetCellsCount(); c++)
              collect(row.GetCell(c).GetContent(), false);
          }
        }
        if (top && (type === 'paragraph' || type === 'table')) blocks.push(e);
      }
    };
    for (const a of areas) if (a) collect(a, true);

    // Отпечаток: строки заголовка, число ячеек и тексты строки headerRows (она станет [i]).
    // Без отпечатка строки (старая карточка) таблица не совпадает — данные не удаляются наугад.
    const matches = (t: OoTable, x: ReplaceTable) => {
      if (t.GetRowsCount() <= x.headerRows) return false;
      const data = t.GetRow(x.headerRows);
      if (data.GetCellsCount() !== x.fingerprint.columns) return false;
      const sample = x.fingerprint.sample ?? [];
      if (sample.length !== x.fingerprint.columns) return false;
      for (let c = 0; c < sample.length; c++)
        if (cellText(data.GetCell(c)).slice(0, MAX_CELL) !== sample[c]) return false;
      for (let r = 0; r < x.headerRows; r++) {
        const row = t.GetRow(r);
        const want = x.fingerprint.header[r] ?? [];
        if (row.GetCellsCount() !== want.length) return false;
        for (let c = 0; c < want.length; c++)
          if (cellText(row.GetCell(c)).slice(0, MAX_CELL) !== want[c]) return false;
      }
      return true;
    };
    const notFound: { items: number[]; tables: number[] } = { items: [], tables: [] };

    // 1. Таблицы — только найти.
    const located: [OoTable, ReplaceTable][] = [];
    const used: OoElement[] = [];
    tables.forEach((x, k) => {
      const free = (e: OoElement | undefined): e is OoTable =>
        !!e && e.GetClassType() === 'table' && used.indexOf(e) < 0;
      let found: OoTable | null = null;
      const byBlock = blocks[x.block];
      if (free(byBlock) && matches(byBlock, x)) found = byBlock;
      // Без строк заголовка отпечаток слабый — только точный номер блока, без поиска.
      else if (x.headerRows > 0)
        for (const e of blocks)
          if (free(e) && matches(e, x)) {
            found = e;
            break;
          }
      if (!found) {
        notFound.tables.push(k);
        return;
      }
      used.push(found);
      located.push([found, x]);
    });

    // 2. Значения: «не найдено» — ни одного вхождения до замен. Два прохода: сначала каждое
    // значение → уникальная метка (длинные строки первыми, чтобы короткая «15» не разрезала
    // «No 15»), затем метки → теги. Иначе следующее значение («2») задело бы тег, вставленный
    // предыдущим ({d.total:formatN(2)}). Метки — из символов области частного использования,
    // которых нет в тексте документа и в значениях.
    const occurs = (find: string) => texts.some((t) => t.indexOf(find) >= 0);
    const present = items.map((it) => !!it.find && occurs(it.find));
    items.forEach((_, i) => {
      if (!present[i]) notFound.items.push(i);
    });
    const mark = (i: number) => '\uE000' + String.fromCharCode(0xe100 + i) + '\uE001';
    const order = items
      .map((it, i) => ({ it, i }))
      .filter((x) => present[x.i])
      .sort((a, b) => b.it.find.length - a.it.find.length);
    for (const { it, i } of order)
      doc.SearchAndReplace({ searchString: it.find, replaceString: mark(i), matchCase: true });
    for (const { it, i } of order)
      doc.SearchAndReplace({ searchString: mark(i), replaceString: it.tag, matchCase: true });

    // 3. Таблицы: заголовок остаётся, строка [i] — теги колонок, затем служебная [i+1].
    for (const [t, x] of located) {
      for (let r = t.GetRowsCount() - 1; r > x.headerRows; r--) t.RemoveRow(t.GetRow(r).GetCell(0));
      const row = t.GetRow(x.headerRows);
      x.rowTags.forEach((tag, c) => {
        if (tag !== null) setCell(row.GetCell(c), tag);
      });
      const service = t.AddRow(row.GetCell(0), false);
      x.serviceRow.forEach((text, c) => setCell(service.GetCell(c), text));
    }
    return { notFound };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------- Адаптер ----------

/** Команда без ответа (колбэк connector не пришёл) отклоняется, чтобы не держать очередь. */
const COMMAND_TIMEOUT_MS = 10_000;

export function createDocumentAdapter(connector: Connector): DocumentAdapter {
  let disposed = false;
  // Asc.scope общий для всех команд: команды идут строго по очереди.
  let queue: Promise<unknown> = Promise.resolve();

  function run(fn: () => unknown, scope: Record<string, unknown>): Promise<unknown> {
    const next = queue.then(
      () =>
        new Promise<unknown>((resolve, reject) => {
          if (disposed) {
            reject(new Error('document connector is disposed'));
            return;
          }
          const w = globalThis as unknown as { Asc?: { scope?: unknown } };
          w.Asc = w.Asc ?? {};
          w.Asc.scope = scope;
          const timer = setTimeout(
            () => reject(new Error('document command timeout')),
            COMMAND_TIMEOUT_MS,
          );
          try {
            connector.callCommand(fn, (r) => {
              clearTimeout(timer);
              if (r && typeof r === 'object' && 'error' in r)
                reject(new Error(String((r as { error: unknown }).error)));
              else if (r === undefined || r === null) reject(new Error('no command result'));
              else resolve(r);
            });
          } catch (e) {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }),
    );
    // Ошибка одной команды не останавливает очередь.
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async snapshot() {
      return DocSnapshot.parse(await run(snapshotCommand, { limits: DOC_SNAPSHOT_LIMITS }));
    },
    async insertTags(text) {
      await run(insertTagsCommand, { lines: text.split(/\r?\n/) });
    },
    async insertTable(rows) {
      await run(insertTableCommand, { rows });
    },
    async replaceAll(blocks) {
      await run(replaceAllCommand, { blocks });
    },
    async replace(items, tables) {
      const r = (await run(replaceCommand, {
        items: items.map((it) => ({ find: it.find, tag: it.tag })),
        tables,
      })) as { notFound: { items: number[]; tables: number[] } };
      return { notFound: r.notFound };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      connector.disconnect();
    },
  };
}
