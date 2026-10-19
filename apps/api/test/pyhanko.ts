// pyHanko (CI: pipx install pyhanko-cli; REQUIRE_PYHANKO=1). Локально без pyhanko в PATH тесты пропускаются (R13).
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fixturePath } from '../src/modules/pdf/sign/fixtures';

const run = promisify(execFile);
const BIN = process.env.PYHANKO ?? 'pyhanko';

export async function pyhankoAvailable(): Promise<boolean> {
  try {
    await run(BIN, ['--version']);
    return true;
  } catch {
    if (process.env.REQUIRE_PYHANKO === '1') {
      throw new Error('pyhanko не найден, а REQUIRE_PYHANKO=1');
    }
    return false;
  }
}

/** `pyhanko sign validate`: код выхода 0 — подпись целая и цепочка доверенная; возвращает вывод. */
export async function pyhankoValidate(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cr-pyhanko-'));
  try {
    const file = join(dir, 'signed.pdf');
    await writeFile(file, pdf);
    const { stdout } = await run(BIN, [
      'sign',
      'validate',
      '--no-revocation-check',
      '--trust',
      fixturePath('ca.pem'),
      file,
    ]);
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
