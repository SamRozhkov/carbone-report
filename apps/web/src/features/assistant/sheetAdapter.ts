import type {
  SheetCellStyle,
  SheetLayout,
  SheetReplaceItem,
  SheetReplaceTable,
} from '@carbone-reports/shared';
import { SHEET_SNAPSHOT_LIMITS, SheetSnapshot } from '@carbone-reports/shared';
import { createCommandQueue, type Connector } from './documentAdapter';

/* Адаптер листа поверх connector OnlyOffice (Automation API, §53.4).
 *
 * Как у адаптера документа (§52.5): команды для callCommand исполняются в редакторе изолированно
 * (передаётся текст функции) — без замыканий и импортов, только глобальные Api и Asc; входные
 * данные — через Asc.scope (JSON), результат — возвращаемым значением; всё тело в try/catch,
 * ошибка → {error}. Поэтому разбор адресов и прочие помощники объявлены внутри каждой команды.
 *
 * Работа идёт только с активным листом. Адреса — A1 (ApiWorksheet.GetRange(ref)); номера строк
 * и колонок в коде — 0-based. Все адреса карточки sheetReplace — координаты снимка (до применения).
 *
 * Методы Spreadsheet API, на которые опирается адаптер (https://api.onlyoffice.com/docs/office-api/
 * usage-api/spreadsheet-api/), — ПРОВЕРИТЬ на DE 9.3.1.2 (Task 12):
 *   Api.GetActiveSheet, Api.CreateColorFromRGB, Api.GetSelection (запасной путь активной ячейки);
 *   ApiWorksheet.GetName/GetUsedRange/GetRange(A1 или 'A1:B2')/GetActiveCell/SetColumnWidth(col
 *   0-based, ширина в символах)/GetRows('4:8') (запасной путь — GetRange('4:8'));
 *   ApiRange.GetAddress(false, false, 'xlA1', false) (возможны «$» и «Лист!» — отбрасываются),
 *   GetText (отображаемый текст), GetValue (строка; у числа — число без формата), SetValue,
 *   SetNumberFormat, SetBold, SetFillColor, SetBorders('Top'|'Bottom'|'Left'|'Right', 'Thin',
 *   color), Clear (+ ClearFormats при наличии; запасной путь — ClearContents + ClearFormats),
 *   ClearContents (запасной путь — SetValue('')), Insert('down') и Delete('up') у диапазона целых
 *   строк, Copy(destination) — значения и оформление строки-образца (запасной путь — только
 *   значения и формат числа: GetNumberFormat/SetNumberFormat).
 *   Текст пишется текстом через ведущий апостроф (как ввод «'=…» в ячейку): значение, начинающееся
 *   с «=», «+», «-», «@» или похожее на число/дату, иначе стало бы формулой или числом.
 *   Числовая ячейка определяется по GetValue: строка вида числа (1234.5, 1E-3) — число. Текстовая
 *   ячейка «15» тоже считается числом: частичная замена в ней — «не найдено» (безопасно). */

export interface SheetAdapter {
  snapshot(): Promise<SheetSnapshot>;
  /** Раскладка от ref (нет — от активной ячейки), с оформлением и форматами; ширины не меняются. */
  insertCells(ref: string | undefined, layout: SheetLayout): Promise<void>;
  /** Очистка значений и форматов используемой области, раскладка с A1, ширины колонок. */
  applyLayout(layout: SheetLayout): Promise<void>;
  /** Сначала таблица, затем пункты; индексы ненайденных пунктов и признак таблицы. */
  replace(
    items: SheetReplaceItem[],
    table: SheetReplaceTable | null,
  ): Promise<{ notFound: { items: number[]; table: boolean } }>;
  dispose(): void;
}

/** Раскладка из сетки текста: ячейки как есть, без оформления и ширин. */
export function gridLayout(rows: string[][]): SheetLayout {
  return {
    rows: rows.length,
    cols: Math.max(0, ...rows.map((r) => r.length)),
    widths: [],
    cells: rows.flatMap((r, row) =>
      r.map((value, col) => ({ row, col, value, kind: 'text' as const, style: 'plain' as const })),
    ),
  };
}

/** Строки текста — по одной в ячейку вниз. */
export function textLayout(text: string): SheetLayout {
  return gridLayout(text.split(/\r?\n/).map((line) => [line]));
}

/** Единый набор оформления (§53.1): модель его не выбирает. */
const SHEET_STYLES: {
  bold: SheetCellStyle[];
  fill: Partial<Record<SheetCellStyle, [number, number, number]>>;
  borders: SheetCellStyle[];
  border: [number, number, number];
  formats: Record<string, string>;
} = {
  bold: ['title', 'label', 'header', 'group', 'subtotal', 'total'],
  fill: { header: [242, 242, 242] },
  borders: ['header', 'group', 'data', 'subtotal', 'total'],
  border: [166, 166, 166],
  formats: { integer: '#,##0', decimal: '#,##0.00', date: 'dd.mm.yyyy' },
};

/* Минимальные типы Spreadsheet API — только то, что вызывают команды ниже. */
interface OoRange {
  GetAddress(rowAbs?: boolean, colAbs?: boolean, refStyle?: string, external?: boolean): string;
  GetText(): unknown;
  GetValue(): unknown;
  SetValue(v: string): unknown;
  GetNumberFormat?(): string;
  SetNumberFormat(f: string): unknown;
  SetBold(b: boolean): unknown;
  SetFillColor(c: unknown): unknown;
  SetBorders(edge: string, style: string, color: unknown): unknown;
  Clear?(): unknown;
  ClearContents?(): unknown;
  ClearFormats?(): unknown;
  Insert(shift: string): unknown;
  Delete(shift: string): unknown;
  Copy?(dest: OoRange): unknown;
}
interface OoSheet {
  GetName(): string;
  GetUsedRange(): OoRange;
  GetRange(ref: string): OoRange;
  GetRows?(spec: string): OoRange;
  GetActiveCell?(): OoRange;
  SetColumnWidth(col: number, width: number): unknown;
}
declare const Api: {
  GetActiveSheet(): OoSheet;
  GetSelection?(): OoRange;
  CreateColorFromRGB(r: number, g: number, b: number): unknown;
};
declare const Asc: { scope: Record<string, unknown> };

type Area = { top: number; left: number; bottom: number; right: number };

// ---------- Команды (исполняются в редакторе, без замыканий) ----------

function snapshotCommand(): unknown {
  try {
    const limits = Asc.scope.limits as typeof SHEET_SNAPSHOT_LIMITS;
    // Адрес 'C3:AB40', '$C$3', 'Лист1!A1' → область 0-based.
    const parse = (a: unknown): Area | null => {
      const s = String(a).split('!').pop()!.replace(/\$/g, '').toUpperCase();
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(s);
      if (!m) return null;
      const col = (l: string) => {
        let n = 0;
        for (let i = 0; i < l.length; i++) n = n * 26 + l.charCodeAt(i) - 64;
        return n - 1;
      };
      const top = Number(m[2]) - 1;
      const left = col(m[1]!);
      return {
        top,
        left,
        bottom: m[4] ? Number(m[4]) - 1 : top,
        right: m[3] ? col(m[3]) : left,
      };
    };
    const toRef = (r: number, c: number) => {
      let n = c + 1;
      let s = '';
      while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s + (r + 1);
    };
    const ws = Api.GetActiveSheet();
    const active =
      typeof ws.GetActiveCell === 'function' ? ws.GetActiveCell() : Api.GetSelection!();
    const a = parse(active.GetAddress(false, false, 'xlA1', false));
    const used = parse(ws.GetUsedRange().GetAddress(false, false, 'xlA1', false)) ?? {
      top: 0,
      left: 0,
      bottom: 0,
      right: 0,
    };
    // Сервер отклоняет область больше 500 × 50 — обрезаем явно.
    let truncated = false;
    if (used.bottom - used.top + 1 > limits.rows) {
      used.bottom = used.top + limits.rows - 1;
      truncated = true;
    }
    if (used.right - used.left + 1 > limits.cols) {
      used.right = used.left + limits.cols - 1;
      truncated = true;
    }
    const cells: { ref: string; text: string }[] = [];
    let left = limits.chars;
    outer: for (let r = used.top; r <= used.bottom; r++)
      for (let c = used.left; c <= used.right; c++) {
        const ref = toRef(r, c);
        const raw = ws.GetRange(ref).GetText();
        const text = (raw === undefined || raw === null ? '' : String(raw)).slice(0, limits.cell);
        if (!text) continue;
        if (cells.length === limits.cells || text.length > left) {
          truncated = true;
          break outer;
        }
        left -= text.length;
        cells.push({ ref, text });
      }
    return {
      name: String(ws.GetName()).slice(0, 200),
      cells,
      usedRange: toRef(used.top, used.left) + ':' + toRef(used.bottom, used.right),
      active: a ? toRef(a.top, a.left) : 'A1',
      truncated,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

/** insertCells (mode 'insert', ref или активная ячейка) и applyLayout (mode 'apply', с A1). */
function layoutCommand(): unknown {
  try {
    const mode = Asc.scope.mode as 'insert' | 'apply';
    const at = Asc.scope.ref as string | null;
    const layout = Asc.scope.layout as SheetLayout;
    const styles = Asc.scope.styles as typeof SHEET_STYLES;
    const parse = (a: unknown): Area | null => {
      const s = String(a).split('!').pop()!.replace(/\$/g, '').toUpperCase();
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(s);
      if (!m) return null;
      const col = (l: string) => {
        let n = 0;
        for (let i = 0; i < l.length; i++) n = n * 26 + l.charCodeAt(i) - 64;
        return n - 1;
      };
      const top = Number(m[2]) - 1;
      const left = col(m[1]!);
      return {
        top,
        left,
        bottom: m[4] ? Number(m[4]) - 1 : top,
        right: m[3] ? col(m[3]) : left,
      };
    };
    const toRef = (r: number, c: number) => {
      let n = c + 1;
      let s = '';
      while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s + (r + 1);
    };
    // Текст остаётся текстом: апостроф не даёт редактору прочитать формулу, число или дату.
    const put = (cell: OoRange, v: string) =>
      cell.SetValue(/^[=+\-@]/.test(v) || /^[\s\d.,:/%()]*\d[\s\d.,:/%()]*$/.test(v) ? "'" + v : v);

    const ws = Api.GetActiveSheet();
    let origin: Area | null;
    if (mode === 'apply') {
      const used = ws.GetUsedRange();
      if (typeof used.Clear === 'function') {
        used.Clear();
        if (typeof used.ClearFormats === 'function') used.ClearFormats();
      } else {
        used.ClearContents!();
        used.ClearFormats!();
      }
      origin = { top: 0, left: 0, bottom: 0, right: 0 };
    } else if (at) origin = parse(at);
    else {
      const active =
        typeof ws.GetActiveCell === 'function' ? ws.GetActiveCell() : Api.GetSelection!();
      origin = parse(active.GetAddress(false, false, 'xlA1', false));
    }
    if (!origin) return { error: 'bad cell reference' };

    const border = Api.CreateColorFromRGB(styles.border[0], styles.border[1], styles.border[2]);
    for (const c of layout.cells) {
      const cell = ws.GetRange(toRef(origin.top + c.row, origin.left + c.col));
      if (c.value) put(cell, c.value);
      if (c.style === 'plain') continue;
      if (styles.bold.indexOf(c.style) >= 0) cell.SetBold(true);
      const fill = styles.fill[c.style];
      if (fill) cell.SetFillColor(Api.CreateColorFromRGB(fill[0], fill[1], fill[2]));
      if (styles.borders.indexOf(c.style) >= 0)
        for (const edge of ['Top', 'Bottom', 'Left', 'Right'])
          cell.SetBorders(edge, 'Thin', border);
      const format = styles.formats[c.kind];
      if (format) cell.SetNumberFormat(format);
    }
    if (mode === 'apply') layout.widths.forEach((w, col) => ws.SetColumnWidth(col, w));
    return { ok: true };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Порядок (§53.3): сначала таблица (сверка отпечатка, замена строк данных целыми строками листа,
 *  итог), затем пункты — их строки ниже таблицы сдвигаются, только если таблица применена. */
function replaceCommand(): unknown {
  try {
    const MAX_CELL = 500;
    const items = Asc.scope.items as { ref: string; find: string; tag: string }[];
    const table = Asc.scope.table as SheetReplaceTable | null;
    const parse = (a: unknown): Area | null => {
      const s = String(a).split('!').pop()!.replace(/\$/g, '').toUpperCase();
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(s);
      if (!m) return null;
      const col = (l: string) => {
        let n = 0;
        for (let i = 0; i < l.length; i++) n = n * 26 + l.charCodeAt(i) - 64;
        return n - 1;
      };
      const top = Number(m[2]) - 1;
      const left = col(m[1]!);
      return {
        top,
        left,
        bottom: m[4] ? Number(m[4]) - 1 : top,
        right: m[3] ? col(m[3]) : left,
      };
    };
    const toRef = (r: number, c: number) => {
      let n = c + 1;
      let s = '';
      while (n > 0) {
        s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        n = Math.floor((n - 1) / 26);
      }
      return s + (r + 1);
    };
    const put = (cell: OoRange, v: string) =>
      cell.SetValue(/^[=+\-@]/.test(v) || /^[\s\d.,:/%()]*\d[\s\d.,:/%()]*$/.test(v) ? "'" + v : v);
    const clearValue = (range: OoRange) => {
      if (typeof range.ClearContents === 'function') range.ClearContents();
      else range.SetValue('');
    };
    const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    const ws = Api.GetActiveSheet();
    const cell = (r: number, c: number) => ws.GetRange(toRef(r, c));
    const span = (r: number, c1: number, c2: number) =>
      ws.GetRange(toRef(r, c1) + ':' + toRef(r, c2));
    const wholeRows = (top: number, bottom: number) => {
      const spec = top + 1 + ':' + (bottom + 1);
      return typeof ws.GetRows === 'function' ? ws.GetRows(spec) : ws.GetRange(spec);
    };
    const notFound: { items: number[]; table: boolean } = { items: [], table: false };

    // 1. Таблица.
    let shift = 0;
    let applied = false;
    if (table) {
      const fp = table.fingerprint;
      const rowTexts = (r: number) => {
        const out: string[] = [];
        for (let i = 0; i < fp.columns; i++)
          out.push(str(cell(r, table.firstCol + i).GetText()).slice(0, MAX_CELL));
        return out;
      };
      const same = (a: string[], b: string[]) =>
        a.length === b.length && a.every((x, i) => x === b[i]);
      const first = table.firstDataRow;
      const last = table.lastDataRow;
      if (
        fp.columns > 0 &&
        fp.header.length === fp.columns &&
        fp.sample.length === fp.columns &&
        same(rowTexts(table.headerRow), fp.header) &&
        same(rowTexts(first), fp.sample)
      ) {
        const n = table.rows.length;
        const right = table.firstCol + fp.columns - 1;
        const used = parse(ws.GetUsedRange().GetAddress(false, false, 'xlA1', false));
        const lastCol = Math.max(right, used ? used.right : 0);
        // Новые строки — сразу под строками данных примера (образцы выше остаются на месте),
        // затем строки примера удаляются целиком.
        wholeRows(last + 1, last + n).Insert('down');
        table.rows.forEach((row, k) => {
          const dst = last + 1 + k;
          const src = row.styleFrom > last ? row.styleFrom + n : row.styleFrom;
          const from = span(src, 0, lastCol);
          const to = span(dst, 0, lastCol);
          if (typeof from.Copy === 'function') from.Copy(to);
          else
            for (let c = 0; c <= lastCol; c++) {
              const s = cell(src, c);
              const d = cell(dst, c);
              const v = str(s.GetValue());
              if (v) put(d, v);
              if (typeof s.GetNumberFormat === 'function') d.SetNumberFormat(s.GetNumberFormat());
            }
          // Вне ширины таблицы — только оформление.
          if (table.firstCol > 0) clearValue(span(dst, 0, table.firstCol - 1));
          if (right < lastCol) clearValue(span(dst, right + 1, lastCol));
          row.cells.forEach((v, i) => {
            if (v === null) return;
            const target = cell(dst, table.firstCol + i);
            if (v === '') clearValue(target);
            else put(target, v);
          });
        });
        wholeRows(first, last).Delete('up');
        shift = n - (last - first + 1);
        applied = true;
        if (table.totals) {
          const tr = table.totals.row > last ? table.totals.row + shift : table.totals.row;
          for (const t of table.totals.cells) {
            if (t.tag === '') clearValue(cell(tr, t.col));
            else put(cell(tr, t.col), t.tag);
          }
        }
      } else notFound.table = true;
    }

    // 2. Пункты, по ячейкам. Несколько пунктов одной ячейки: сначала каждое значение → метка
    // (длинные первыми), затем метки → теги, чтобы следующий find не задел вставленный тег.
    const groups: { r: number; c: number; list: number[] }[] = [];
    items.forEach((it, i) => {
      const p = parse(it.ref);
      if (!p || !it.find || p.top !== p.bottom || p.left !== p.right) {
        notFound.items.push(i);
        return;
      }
      const r = applied && p.top > table!.lastDataRow ? p.top + shift : p.top;
      let g = groups.find((x) => x.r === r && x.c === p.left);
      if (!g) {
        g = { r, c: p.left, list: [] };
        groups.push(g);
      }
      g.list.push(i);
    });
    const mark = (i: number) => '' + String.fromCharCode(0xe100 + i) + '';
    for (const g of groups) {
      const target = cell(g.r, g.c);
      const text = str(target.GetText());
      const value = str(target.GetValue());
      const numeric = /^\s*[-+]?(\d+\.?\d*|\.\d+)(E[-+]?\d+)?\s*$/i.test(value);
      const whole = g.list.find((i) => items[i]!.find === text);
      if (whole !== undefined) {
        put(target, items[whole]!.tag);
        for (const i of g.list) if (i !== whole) notFound.items.push(i);
        continue;
      }
      const ok = g.list.filter((i) => !numeric && value.indexOf(items[i]!.find) >= 0);
      for (const i of g.list) if (ok.indexOf(i) < 0) notFound.items.push(i);
      if (!ok.length) continue;
      ok.sort((a, b) => items[b]!.find.length - items[a]!.find.length);
      let next = value;
      for (const i of ok) next = next.replace(items[i]!.find, () => mark(i));
      for (const i of ok) next = next.replace(mark(i), () => items[i]!.tag);
      put(target, next);
    }
    notFound.items.sort((a, b) => a - b);
    return { notFound };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------- Адаптер ----------

export function createSheetAdapter(connector: Connector): SheetAdapter {
  const { run, dispose } = createCommandQueue(connector);
  return {
    async snapshot() {
      return SheetSnapshot.parse(await run(snapshotCommand, { limits: SHEET_SNAPSHOT_LIMITS }));
    },
    async insertCells(ref, layout) {
      await run(layoutCommand, { mode: 'insert', ref: ref ?? null, layout, styles: SHEET_STYLES });
    },
    async applyLayout(layout) {
      await run(layoutCommand, { mode: 'apply', ref: null, layout, styles: SHEET_STYLES });
    },
    async replace(items, table) {
      const r = (await run(replaceCommand, {
        items: items.map((it) => ({ ref: it.ref, find: it.find, tag: it.tag })),
        table,
      })) as { notFound: { items: number[]; table: boolean } };
      return { notFound: r.notFound };
    },
    dispose,
  };
}
