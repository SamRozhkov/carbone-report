// Только для тестов: подпись из PDF и проверка `openssl cms -verify` (тестовый УЦ — доверенный).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fixturePath } from './fixtures';

const run = promisify(execFile);

/** CMS из /Contents и подписанные байты по /ByteRange (единственная подпись в файле). */
export function extractSignature(pdf: Buffer): { cms: Buffer; signed: Buffer } {
  const text = pdf.toString('latin1');
  const m = /\/ByteRange \[0 (\d+) (\d+) (\d+) *\]/.exec(text);
  if (!m) throw new Error('нет ByteRange');
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const raw = Buffer.from(text.slice(a + 1, b - 1), 'hex');
  // Длина DER из заголовка SEQUENCE: хвост /Contents — нули дополнения.
  const n = raw[1]! & 0x80 ? raw[1]! & 0x7f : 0;
  const len = n ? 2 + n + raw.subarray(2, 2 + n).reduce((acc, x) => acc * 256 + x, 0) : 2 + raw[1]!;
  return {
    cms: raw.subarray(0, len),
    signed: Buffer.concat([pdf.subarray(0, a), pdf.subarray(b, b + c)]),
  };
}

/** `openssl cms -verify` по вырезанным байтам; цепочка — до тестового УЦ. */
export async function opensslVerify(pdf: Buffer): Promise<void> {
  const { cms, signed } = extractSignature(pdf);
  const dir = await mkdtemp(join(tmpdir(), 'cr-sig-'));
  try {
    await writeFile(join(dir, 'sig.der'), cms);
    await writeFile(join(dir, 'data.bin'), signed);
    await run(process.env.OPENSSL ?? 'openssl', [
      'cms',
      '-verify',
      '-binary',
      '-inform',
      'DER',
      '-in',
      join(dir, 'sig.der'),
      '-content',
      join(dir, 'data.bin'),
      '-CAfile',
      fixturePath('ca.pem'),
      '-purpose',
      'any',
      '-out',
      join(dir, 'out.bin'),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
