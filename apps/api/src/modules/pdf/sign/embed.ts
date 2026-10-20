// Место под подпись в готовом PDF (§39.4): ByteRange и /Contents. Работает с байтами, без pdf-lib.

/** Как заглушку ByteRange пишет pdf-lib: `[ 0 /********** /********** /********** ]`. */
const BYTE_RANGE = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/g;

/** Границы значения /Contents: `start` — позиция «<», `end` — сразу после «>». */
export interface SignatureHole {
  start: number;
  end: number;
}

/** Находит заглушки, вписывает ByteRange той же ширины и возвращает место под CMS. */
export function fillByteRange(pdf: Buffer, contentsBytes: number): SignatureHole {
  const text = pdf.toString('latin1');
  const hole = `<${'0'.repeat(contentsBytes * 2)}>`;
  const start = text.indexOf(hole);
  if (start < 0 || text.indexOf(hole, start + 1) >= 0)
    throw new Error('место под подпись не найдено или не одно');
  const end = start + hole.length;
  const found = [...text.matchAll(BYTE_RANGE)];
  if (found.length !== 1) throw new Error('заглушка ByteRange не найдена или не одна');
  const m = found[0]!;
  const at = m.index + m[0].indexOf('[');
  const width = m.index + m[0].length - at;
  const value = `[0 ${start} ${end} ${pdf.length - end}]`;
  if (value.length > width) throw new Error('ByteRange не помещается в заглушку');
  pdf.write(value.padEnd(width, ' '), at, 'latin1');
  return { start, end };
}

/** Подписываемые байты: всё, кроме значения /Contents. */
export function signedRanges(pdf: Buffer, hole: SignatureHole): [Buffer, Buffer] {
  return [pdf.subarray(0, hole.start), pdf.subarray(hole.end)];
}

/** Вписывает DER подписи в /Contents (шестнадцатерично, дополняя нулями). */
export function insertCms(pdf: Buffer, hole: SignatureHole, cms: Uint8Array): void {
  const room = hole.end - hole.start - 2;
  const hex = Buffer.from(cms).toString('hex').toUpperCase();
  if (hex.length > room) throw new Error('CMS не помещается в /Contents');
  pdf.write(hex.padEnd(room, '0'), hole.start + 1, 'latin1');
}
