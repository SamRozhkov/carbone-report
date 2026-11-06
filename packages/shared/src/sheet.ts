import { z } from 'zod';

/** Разбор ссылки на ячейку 'A1' → {row, col} (0-based). Только заглавные буквы, без «$». */
export function parseRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]!) - 1, col: col - 1 };
}

/** Обратное преобразование: (0, 0) → 'A1'. */
export function toRef(row: number, col: number): string {
  let n = col + 1;
  let letters = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    letters = String.fromCharCode(65 + r) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return `${letters}${row + 1}`;
}

/** Разбор диапазона 'C3:AB40'; одиночная ячейка 'A1' — диапазон 1×1. */
export function parseRange(
  range: string,
): { top: number; left: number; bottom: number; right: number } | null {
  const [a, b, ...rest] = range.split(':');
  if (rest.length > 0) return null;
  const p1 = parseRef(a ?? '');
  const p2 = parseRef(b ?? a ?? '');
  if (!p1 || !p2 || p2.row < p1.row || p2.col < p1.col) return null;
  return { top: p1.row, left: p1.col, bottom: p2.row, right: p2.col };
}

/** Лимиты снимка листа (§53.2): ячеек, символов в ячейке, сумма символов, строк и колонок области. */
export const SHEET_SNAPSHOT_LIMITS = {
  cells: 5000,
  cell: 500,
  chars: 30_000,
  rows: 500,
  cols: 50,
} as const;

/** Снимок открытого листа xlsx/ods (§53.2): непустые ячейки используемой области. */
export const SheetSnapshot = z
  .object({
    name: z.string().max(200),
    cells: z
      .array(
        z.object({ ref: z.string().max(12), text: z.string().max(SHEET_SNAPSHOT_LIMITS.cell) }),
      )
      .max(SHEET_SNAPSHOT_LIMITS.cells),
    usedRange: z.string().max(25),
    active: z.string().max(12),
    truncated: z.boolean(),
  })
  .superRefine((s, ctx) => {
    if (!parseRef(s.active))
      ctx.addIssue({ code: 'custom', path: ['active'], message: 'bad cell reference' });
    const r = parseRange(s.usedRange);
    if (
      !r ||
      r.bottom - r.top + 1 > SHEET_SNAPSHOT_LIMITS.rows ||
      r.right - r.left + 1 > SHEET_SNAPSHOT_LIMITS.cols
    )
      ctx.addIssue({ code: 'custom', path: ['usedRange'], message: 'bad used range' });
    const seen = new Set<string>();
    let chars = 0;
    s.cells.forEach((c, i) => {
      if (!parseRef(c.ref))
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'ref'], message: 'bad cell reference' });
      if (seen.has(c.ref))
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'ref'], message: 'duplicate ref' });
      seen.add(c.ref);
      chars += c.text.length;
    });
    if (chars > SHEET_SNAPSHOT_LIMITS.chars)
      ctx.addIssue({ code: 'custom', path: ['cells'], message: 'too many characters' });
  });
export type SheetSnapshot = z.infer<typeof SheetSnapshot>;

export type SheetCellKind = 'text' | 'integer' | 'decimal' | 'date';
export type SheetCellStyle =
  'plain' | 'title' | 'label' | 'header' | 'group' | 'data' | 'subtotal' | 'total';

/** Ячейка раскладки; координаты — от левого верхнего угла раскладки. */
export interface SheetLayoutCell {
  row: number;
  col: number;
  value: string;
  kind: SheetCellKind;
  style: SheetCellStyle;
  /** Формат текстовой колонки (только kind 'text'), сохраняется при вставке таблицы. */
  format?: string;
}

/** Раскладка, построенная сервером (§53.3); widths — ширины колонок в символах. */
export interface SheetLayout {
  rows: number;
  cols: number;
  cells: SheetLayoutCell[];
  widths: number[];
}

/** Тип вложенной колонки, объявленный моделью, когда проба запроса не вернула строк (sampled: false). */
export const SheetDeclaredType = z.enum(['text', 'int', 'decimal', 'date']);
export type SheetDeclaredType = z.infer<typeof SheetDeclaredType>;
