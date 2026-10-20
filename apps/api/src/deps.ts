import type { SignPrepareJob } from './modules/pdf/sign/prepare';
import type { P12Contents } from './modules/pdf/sign/p12';
import type { PdfPostJob } from './modules/pdf/postprocess';
import type { PdfProtectJob } from './modules/pdf/protect';
import type { Inflight } from './lib/inflight';
import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Config } from './config';
import type { Db } from './db/client';
import type { RunFileGate } from './lib/run-file-gate';
import type { Storage } from './lib/storage';
import type { LdapAuthenticator } from './modules/auth/ldap';
import type { AgentClient } from './modules/backups/agent-client';
import type { RenderHandoff } from './modules/render/handoff';

export interface TemplateFileRef {
  id: string;
  version: number;
  ext: TemplateExt;
  read(): Promise<Buffer>;
}

export interface RenderOptions {
  convertTo: OutputFormat;
  lang: string;
  timezone: string;
  timeoutMs: number;
  /** PDF/A-2b от конвертера (§36.4); действует только при convertTo = pdf. */
  pdfa?: boolean;
}

export interface CarboneRenderer {
  render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer>;
}

/** Обработка готового PDF (§36.4): приложения, водяной знак, нумерация, метаданные — в пределах timeoutMs. */
export type PdfPostprocessor = (pdf: Buffer, job: PdfPostJob, timeoutMs: number) => Promise<Buffer>;

/** Шифрование готового PDF (§37.2): пароль и запреты — в пределах timeoutMs. */
export type PdfProtector = (pdf: Buffer, job: PdfProtectJob, timeoutMs: number) => Promise<Buffer>;

/** Подготовка PDF к подписи (§39.4): поле, штамп, заглушки — в пределах timeoutMs. */
/** Разбор .p12 (§39.8): в пуле рендера — главный поток не считает KDF; deadlineAt — срок, мс эпохи. */
export type P12Reader = (
  file: Buffer,
  password: string,
  now: Date,
  deadlineAt: number,
) => Promise<P12Contents>;

export type PdfSignPreparer = (
  pdf: Buffer,
  job: SignPrepareJob,
  timeoutMs: number,
) => Promise<Buffer>;

export interface OnlyOfficeCommands {
  forceSave(key: string): Promise<void>;
}

export type FileFetcher = (url: string) => Promise<Buffer>;

export interface SourcePools {
  get(datasourceId: string): Promise<{ pool: pg.Pool; name: string }>;
  invalidate(datasourceId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface AppDeps {
  config: Config;
  db: Db;
  storage: Storage;
  /** Сборка файла запуска под advisory-блокировкой на отдельном небольшом пуле. */
  runFileGate: RunFileGate;
  sources: SourcePools;
  carbone: CarboneRenderer;
  /** Обработка готового PDF в пуле рендера (тестам — в этом потоке). */
  pdf: PdfPostprocessor;
  /** Шифрование PDF программой qpdf (§37.2). */
  pdfProtect: PdfProtector;
  /** Подготовка PDF к подписи в пуле рендера (§39.4; тестам — в этом потоке). */
  pdfSignPrepare: PdfSignPreparer;
  /** Разбор .p12 в пуле рендера (§39.8; тестам — в этом потоке). */
  p12Read: P12Reader;
  onlyoffice: OnlyOfficeCommands;
  fetchFile: FileFetcher;
  /** Общий Redis (лимит входа, режим обслуживания); null — лимиты считаются в памяти экземпляра. */
  redis: Redis | null;
  /** null, если LDAP не настроен (LDAP_ENABLED=false) — вход только по локальному паролю. */
  ldap: LdapAuthenticator | null;
  /** Агент бэкапа (§26.3); null — управление бэкапами в админке выключено. */
  backupAgent: AgentClient | null;
  /** Разовые файлы рендера для Document Server в памяти этой реплики. */
  renderFiles: RenderHandoff;
  /** Состояние остановки процесса; нет — считается «не останавливаемся». */
  /** requests — незавершённые HTTP-запросы (кроме проб и разовых ссылок рендера): их ждёт остановка. */
  drain?: { isDraining(): boolean; requests?: Inflight };
}
