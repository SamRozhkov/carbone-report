import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import {
  MAX_TRANSFER_ARCHIVE_BYTES,
  MAX_TRANSFER_ENTRIES,
  MAX_TRANSFER_MANIFEST_BYTES,
  MAX_TRANSFER_UNPACKED_BYTES,
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_MANIFEST_FILE,
  TransferManifest,
} from '@carbone-reports/shared/template-transfer';
import { AppError } from '../../../lib/errors';
import { isZip } from '../../../lib/http';

const inflateRawAsync = promisify(inflateRaw);

export const importInvalid = (message: string) => new AppError('IMPORT_INVALID', 400, message);

export interface ArchiveLimits {
  archiveBytes: number;
  unpackedBytes: number;
  entries: number;
  /** manifest.json отдельно; по умолчанию MAX_TRANSFER_MANIFEST_BYTES. */
  manifestBytes?: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  archiveBytes: MAX_TRANSFER_ARCHIVE_BYTES,
  unpackedBytes: MAX_TRANSFER_UNPACKED_BYTES,
  entries: MAX_TRANSFER_ENTRIES,
};

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;

/** Запись центрального каталога zip. Размеры из заголовков — только для сверки, не для лимитов. */
interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/**
 * Центральный каталог zip — свой разбор вместо JSZip: JSZip молча схлопывает записи с одинаковым
 * именем, «исправляет» пути с `../` и читает каталог целиком до проверки числа записей.
 */
function readDirectory(buf: Buffer, limits: ArchiveLimits): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw importInvalid('файл не является zip-архивом');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw importInvalid('архивы ZIP64 не поддерживаются');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) {
    throw importInvalid('многотомные архивы не поддерживаются');
  }
  if (count > limits.entries) throw importInvalid(`в архиве больше ${limits.entries} записей`);
  if (cdOffset + cdSize > eocd) throw importInvalid('архив повреждён');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  for (let k = 0; k < count; k++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw importInvalid('архив повреждён');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw importInvalid('архив повреждён');
    entries.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p = next;
  }
  return entries;
}

/** Путь записи: относительный, без `..`, `.`, пустых сегментов, `\`, `:` и управляющих символов. */
function checkPath(name: string): void {
  const segments = name.replace(/\/$/, '').split('/');
  const bad =
    name === '' ||
    name.startsWith('/') ||
    // eslint-disable-next-line no-control-regex
    /[\\:\u0000-\u001f\u007f]/.test(name) ||
    segments.some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw importInvalid(`недопустимый путь в архиве: ${JSON.stringify(name)}`);
}

/**
 * Распаковывает запись не больше чем в `budget` байт: zlib прерывает распаковку, как только
 * фактический объём превышает лимит, — заявленный в заголовке размер не учитывается.
 */
async function extract(
  buf: Buffer,
  e: ZipEntry,
  budget: number,
  tooBig: () => AppError,
): Promise<Buffer> {
  if (e.flags & 0x1) throw importInvalid(`зашифрованные архивы не поддерживаются: ${e.name}`);
  const off = e.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw importInvalid('архив повреждён');
  }
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const stop = start + e.compressedSize;
  if (stop > buf.length) throw importInvalid('архив повреждён');
  const packed = buf.subarray(start, stop);
  let data: Buffer;
  if (e.method === 0) {
    if (packed.length > budget) throw tooBig();
    data = Buffer.from(packed);
  } else if (e.method === 8) {
    if (budget <= 0) throw tooBig();
    try {
      data = await inflateRawAsync(packed, { maxOutputLength: budget });
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooBig();
      throw importInvalid(`архив повреждён: ${e.name}`);
    }
  } else {
    throw importInvalid(`неподдерживаемый метод сжатия в архиве: ${e.name}`);
  }
  if (data.length !== e.size || crc32(data) !== e.crc) {
    throw importInvalid(`архив повреждён: ${e.name}`);
  }
  return data;
}

export interface TransferArchive {
  manifest: TransferManifest;
  /** Файлы шаблонов по порядку манифеста. */
  files: Buffer[];
}

function parseManifest(raw: Buffer): TransferManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw importInvalid(`${TRANSFER_MANIFEST_FILE}: неверный JSON`);
  }
  const head = (json ?? {}) as { format?: unknown; formatVersion?: unknown };
  if (head.format !== TRANSFER_FORMAT) {
    throw importInvalid('это не архив шаблонов carbone-reports');
  }
  if (head.formatVersion !== TRANSFER_FORMAT_VERSION) {
    throw importInvalid(
      `версия формата архива ${JSON.stringify(head.formatVersion)} не поддерживается (ожидается ${TRANSFER_FORMAT_VERSION})`,
    );
  }
  const parsed = TransferManifest.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const [first, index, ...rest] = issue.path;
    const where =
      first === 'templates' && typeof index === 'number'
        ? `шаблон ${index + 1}${rest.length ? ` (${rest.join('.')})` : ''}`
        : issue.path.join('.') || 'манифест';
    throw importInvalid(`${TRANSFER_MANIFEST_FILE}: ${where}: ${issue.message}`);
  }
  return parsed.data;
}

/**
 * Безопасное чтение архива шаблонов (§33.2): размер, число записей, пути, только ожидаемые файлы,
 * распакованный объём по фактическим байтам, формат и схема манифеста, sha256 файлов.
 * Каталоги допускаются только как пустые записи `templates/` и `templates/<n>/` ожидаемых файлов —
 * их добавляют обычные архиваторы при переупаковке, вреда от них нет; всё прочее — ошибка.
 */
export async function readTransferArchive(
  buf: Buffer,
  limits: ArchiveLimits = DEFAULT_LIMITS,
): Promise<TransferArchive> {
  if (buf.length > limits.archiveBytes) {
    throw importInvalid(`архив больше ${mb(limits.archiveBytes)}`);
  }
  try {
    return await readChecked(buf, limits);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw importInvalid('архив повреждён');
  }
}

async function readChecked(buf: Buffer, limits: ArchiveLimits): Promise<TransferArchive> {
  const entries = readDirectory(buf, limits);
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) {
    checkPath(e.name);
    if (byName.has(e.name)) throw importInvalid(`запись повторяется в архиве: ${e.name}`);
    byName.set(e.name, e);
  }

  let used = 0;
  const totalTooBig = () => importInvalid(`распакованный архив больше ${mb(limits.unpackedBytes)}`);
  const take = async (e: ZipEntry) => {
    const data = await extract(buf, e, limits.unpackedBytes - used, totalTooBig);
    used += data.length;
    return data;
  };

  const manifestEntry = byName.get(TRANSFER_MANIFEST_FILE);
  if (!manifestEntry) throw importInvalid(`в архиве нет ${TRANSFER_MANIFEST_FILE}`);
  // Свой лимит манифеста: JSON.parse и проверка схемы на сотнях МБ надолго заняли бы процесс.
  const manifestCap = limits.manifestBytes ?? MAX_TRANSFER_MANIFEST_BYTES;
  const manifestRaw = await extract(
    buf,
    manifestEntry,
    Math.min(manifestCap, limits.unpackedBytes),
    () =>
      manifestCap < limits.unpackedBytes
        ? importInvalid(`${TRANSFER_MANIFEST_FILE} больше ${mb(manifestCap)}`)
        : totalTooBig(),
  );
  used += manifestRaw.length;
  const manifest = parseManifest(manifestRaw);

  const expected = new Set([TRANSFER_MANIFEST_FILE, ...manifest.templates.map((t) => t.file)]);
  const dirs = new Set(['templates/', ...manifest.templates.map((_, i) => `templates/${i + 1}/`)]);
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const ok = isDir ? dirs.has(e.name) && e.size === 0 : expected.has(e.name);
    if (!ok) throw importInvalid(`лишний файл в архиве: ${e.name}`);
  }

  const files: Buffer[] = [];
  for (const t of manifest.templates) {
    const e = byName.get(t.file);
    if (!e) throw importInvalid(`в архиве нет файла ${t.file}`);
    const data = await take(e);
    if (createHash('sha256').update(data).digest('hex') !== t.sha256) {
      throw importInvalid(`файл ${t.file} не совпадает с контрольной суммой из манифеста`);
    }
    if (!isZip(data)) throw importInvalid(`файл ${t.file} не является документом Office`);
    files.push(data);
  }
  return { manifest, files };
}
