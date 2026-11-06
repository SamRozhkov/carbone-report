import type { SheetLayout, SheetSnapshot } from '@carbone-reports/shared';
import { parseRef, toRef } from '@carbone-reports/shared';

/**
 * Раскладка, вставленная от anchor, перезапишет непустую ячейку снимка своим значением (§53.3). Усечённый снимок
 * видит не все ячейки — считаем, что перезапишет (спросить автора безопаснее).
 */
export function overlaps(snapshot: SheetSnapshot, anchor: string, layout: SheetLayout): boolean {
  if (snapshot.truncated) return true;
  const at = parseRef(anchor);
  if (!at) return true;
  const filled = new Set(snapshot.cells.filter((c) => c.text !== '').map((c) => c.ref));
  // Пустое значение адаптер не пишет (только оформление) — такая ячейка не перезаписывается.
  return layout.cells.some(
    (c) => c.value !== '' && filled.has(toRef(at.row + c.row, at.col + c.col)),
  );
}
