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
import { MAX_PDF_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENT_PAGES } from '@carbone-reports/shared';
import { AppError, issueText, localizedSafeParse, text, type Msg } from '../../../lib/errors';
import { isZip } from '../../../lib/http';
import { inspectPdf, PdfInputError } from '../../pdf/inspect';

const inflateRawAsync = promisify(inflateRaw);

export const importInvalid = (key: string, params?: Msg['params']) =>
  new AppError('IMPORT_INVALID', 400, { key, params });

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

const mb = (n: number) => Math.round(n / 1024 / 1024);

/** Запись центрального каталога zip. Размеры из заголовков — только для сверки, не для лимитов. */
export interface ZipEntry {
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
export function readDirectory(buf: Buffer, limits: ArchiveLimits): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw importInvalid('archive.notZip');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw importInvalid('archive.zip64');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) {
    throw importInvalid('archive.multiVolume');
  }
  if (count > limits.entries)
    throw importInvalid('archive.tooManyEntries', { count: limits.entries });
  if (cdOffset + cdSize > eocd) throw importInvalid('archive.damaged');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const end = cdOffset + cdSize;
  for (let k = 0; k < count; k++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw importInvalid('archive.damaged');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const next = p + 46 + nameLen + extraLen + commentLen;
    if (next > end) throw importInvalid('archive.damaged');
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
  if (bad) throw importInvalid('archive.badPath', { path: JSON.stringify(name) });
}

/**
 * Распаковывает запись не больше чем в `budget` байт: zlib прерывает распаковку, как только
 * фактический объём превышает лимит, — заявленный в заголовке размер не учитывается.
 */
export async function extract(
  buf: Buffer,
  e: ZipEntry,
  budget: number,
  tooBig: () => AppError,
): Promise<Buffer> {
  if (e.flags & 0x1) throw importInvalid('archive.encrypted', { name: e.name });
  const off = e.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== SIG_LOCAL) {
    throw importInvalid('archive.damaged');
  }
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const stop = start + e.compressedSize;
  if (stop > buf.length) throw importInvalid('archive.damaged');
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
      throw importInvalid('archive.damagedEntry', { name: e.name });
    }
  } else {
    throw importInvalid('archive.unsupportedMethod', { name: e.name });
  }
  if (data.length !== e.size || crc32(data) !== e.crc) {
    throw importInvalid('archive.damagedEntry', { name: e.name });
  }
  return data;
}

export interface TransferArchive {
  manifest: TransferManifest;
  /** Файлы шаблонов по порядку манифеста. */
  files: Buffer[];
  /** Приложенные PDF по шаблонам манифеста, проверенные (§36.6). */
  attachments: { data: Buffer; pages: number; pdfa: boolean }[][];
}

function parseManifest(raw: Buffer): TransferManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw importInvalid('import.manifestJson', { file: TRANSFER_MANIFEST_FILE });
  }
  const head = (json ?? {}) as { format?: unknown; formatVersion?: unknown };
  if (head.format !== TRANSFER_FORMAT) {
    throw importInvalid('import.notTransferArchive');
  }
  if (head.formatVersion !== TRANSFER_FORMAT_VERSION) {
    throw importInvalid('import.formatVersion', {
      version: JSON.stringify(head.formatVersion),
      expected: TRANSFER_FORMAT_VERSION,
    });
  }
  // Сообщение issue входит в текст ошибки и переводится на язык запроса (§44.4).
  const parsed = localizedSafeParse(TransferManifest, json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const [first, index, ...rest] = issue.path;
    const file = TRANSFER_MANIFEST_FILE;
    const message = issueText(issue);
    if (first === 'templates' && typeof index === 'number')
      throw rest.length
        ? importInvalid('import.manifestTemplatePath', {
            file,
            index: index + 1,
            path: rest.join('.'),
            message,
          })
        : importInvalid('import.manifestTemplate', { file, index: index + 1, message });
    throw issue.path.length
      ? importInvalid('import.manifestPath', { file, path: issue.path.join('.'), message })
      : importInvalid('import.manifest', { file, message });
  }
  return parsed.data as TransferManifest;
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
    throw importInvalid('archive.tooLarge', { size: mb(limits.archiveBytes) });
  }
  try {
    return await readChecked(buf, limits);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw importInvalid('archive.damaged');
  }
}

async function readChecked(buf: Buffer, limits: ArchiveLimits): Promise<TransferArchive> {
  const entries = readDirectory(buf, limits);
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) {
    checkPath(e.name);
    if (byName.has(e.name)) throw importInvalid('archive.duplicateEntry', { name: e.name });
    byName.set(e.name, e);
  }

  let used = 0;
  const totalTooBig = () =>
    importInvalid('archive.unpackedTooLarge', { size: mb(limits.unpackedBytes) });
  const take = async (e: ZipEntry) => {
    const data = await extract(buf, e, limits.unpackedBytes - used, totalTooBig);
    used += data.length;
    return data;
  };

  const manifestEntry = byName.get(TRANSFER_MANIFEST_FILE);
  if (!manifestEntry) throw importInvalid('archive.noManifest', { file: TRANSFER_MANIFEST_FILE });
  // Свой лимит манифеста: JSON.parse и проверка схемы на сотнях МБ надолго заняли бы процесс.
  const manifestCap = limits.manifestBytes ?? MAX_TRANSFER_MANIFEST_BYTES;
  const manifestRaw = await extract(
    buf,
    manifestEntry,
    Math.min(manifestCap, limits.unpackedBytes),
    () =>
      manifestCap < limits.unpackedBytes
        ? importInvalid('import.manifestTooLarge', {
            file: TRANSFER_MANIFEST_FILE,
            size: mb(manifestCap),
          })
        : totalTooBig(),
  );
  used += manifestRaw.length;
  const manifest = parseManifest(manifestRaw);

  const expected = new Set([
    TRANSFER_MANIFEST_FILE,
    ...manifest.templates.flatMap((t) => [t.file, ...(t.attachments ?? []).map((a) => a.file)]),
  ]);
  const dirs = new Set([
    'templates/',
    ...manifest.templates.flatMap((_, i) => [
      `templates/${i + 1}/`,
      `templates/${i + 1}/attachments/`,
    ]),
  ]);
  for (const e of entries) {
    const isDir = e.name.endsWith('/');
    const ok = isDir ? dirs.has(e.name) && e.size === 0 : expected.has(e.name);
    if (!ok) throw importInvalid('archive.extraFile', { name: e.name });
  }

  const files: Buffer[] = [];
  for (const t of manifest.templates) {
    const e = byName.get(t.file);
    if (!e) throw importInvalid('archive.missingFile', { file: t.file });
    const data = await take(e);
    if (createHash('sha256').update(data).digest('hex') !== t.sha256) {
      throw importInvalid('archive.checksum', { file: t.file });
    }
    if (!isZip(data)) throw importInvalid('archive.notOffice', { file: t.file });
    files.push(data);
  }

  const attachments: TransferArchive['attachments'] = [];
  for (const t of manifest.templates) {
    const list: TransferArchive['attachments'][number] = [];
    for (const a of t.attachments ?? []) {
      const e = byName.get(a.file);
      if (!e) throw importInvalid('archive.missingFile', { file: a.file });
      const data = await take(e);
      if (data.length > MAX_PDF_ATTACHMENT_BYTES)
        throw importInvalid('import.attachmentError', {
          template: t.name,
          name: a.name,
          message: text('fileTooLarge', { size: mb(MAX_PDF_ATTACHMENT_BYTES) }),
        });
      if (createHash('sha256').update(data).digest('hex') !== a.sha256) {
        throw importInvalid('archive.checksum', { file: a.file });
      }
      try {
        list.push({ data, ...(await inspectPdf(data)) });
      } catch (err) {
        if (err instanceof PdfInputError)
          throw importInvalid('import.attachmentError', {
            template: t.name,
            name: a.name,
            message: text(err.key),
          });
        throw err;
      }
    }
    if (list.reduce((s, x) => s + x.pages, 0) > MAX_PDF_ATTACHMENT_PAGES)
      throw importInvalid('import.templateError', {
        template: t.name,
        message: text('pdf.tooManyPages', { count: MAX_PDF_ATTACHMENT_PAGES }),
      });
    if (t.pdfOptions?.pdfa) {
      const bad = (t.attachments ?? []).find((_, n) => !list[n]!.pdfa);
      if (bad)
        throw importInvalid('import.templateError', {
          template: t.name,
          message: text('pdf.attachmentNotPdfa', { name: bad.name }),
        });
    }
    attachments.push(list);
  }
  return { manifest, files, attachments };
}
