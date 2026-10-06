import type { OutputFormat, TemplateExt } from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Config } from './config';
import type { Db } from './db/client';
import type { Storage } from './lib/storage';

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
  sources: SourcePools;
  carbone: CarboneRenderer;
  onlyoffice: OnlyOfficeCommands;
  fetchFile: FileFetcher;
  /** Общий Redis (кэш Carbone, лимит входа); null — кэш промахивается, лимиты считаются в памяти экземпляра. */
  redis: Redis | null;
}
