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
}

export interface CarboneRenderer {
  render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer>;
}

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
  drain?: { isDraining(): boolean };
}
