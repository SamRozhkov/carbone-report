import type { CarboneRenderer, RenderOptions, TemplateFileRef } from '../../deps';
import { AppError } from '../../lib/errors';

const VERSION_HEADER = { 'carbone-version': '5' };

class TemplateMissing extends Error {}

export class CarboneClient implements CarboneRenderer {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  /** `${templateId}` → { version, carboneId } */
  private readonly ids = new Map<string, { version: number; carboneId: string }>();

  constructor(opts: { baseUrl: string; fetch?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetch = opts.fetch ?? fetch;
  }

  async render(tpl: TemplateFileRef, data: unknown, opts: RenderOptions): Promise<Buffer> {
    const signal = AbortSignal.timeout(opts.timeoutMs);
    try {
      const cached = this.ids.get(tpl.id);
      let carboneId = cached?.version === tpl.version ? cached.carboneId : await this.upload(tpl, signal);
      try {
        return await this.renderWith(carboneId, data, opts, signal);
      } catch (e) {
        if (!(e instanceof TemplateMissing)) throw e;
        carboneId = await this.upload(tpl, signal);
        return await this.renderWith(carboneId, data, opts, signal);
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (e instanceof TemplateMissing) throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: шаблон не найден');
      if (signal.aborted) throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
      throw new AppError('CARBONE_ERROR', 502, 'сервис генерации недоступен');
    }
  }

  private async upload(tpl: TemplateFileRef, signal: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('template', new Blob([new Uint8Array(await tpl.read())]), `template.${tpl.ext}`);
    const res = await this.fetch(`${this.baseUrl}/template`, {
      method: 'POST',
      headers: VERSION_HEADER,
      body: form,
      signal,
    });
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; error?: string; data?: { templateId?: string } }
      | null;
    const id = body?.data?.templateId;
    if (!res.ok || !body?.success || !id) {
      throw new AppError('CARBONE_ERROR', 502, `ошибка загрузки шаблона: ${body?.error ?? res.status}`);
    }
    this.ids.set(tpl.id, { version: tpl.version, carboneId: id });
    return id;
  }

  private async renderWith(
    carboneId: string,
    data: unknown,
    opts: RenderOptions,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const res = await this.fetch(`${this.baseUrl}/render/${encodeURIComponent(carboneId)}?download=true`, {
      method: 'POST',
      headers: { ...VERSION_HEADER, 'content-type': 'application/json' },
      body: JSON.stringify({ data, convertTo: opts.convertTo, lang: opts.lang, timezone: opts.timezone }),
      signal,
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    if (res.ok && !isJson) return Buffer.from(await res.arrayBuffer());

    const body = (isJson ? await res.json().catch(() => null) : null) as { error?: string } | null;
    const error = body?.error ?? `HTTP ${res.status}`;
    if (res.status === 404 || /template not found/i.test(error)) throw new TemplateMissing(error);
    throw new AppError('CARBONE_ERROR', 502, `ошибка генерации: ${error}`);
  }
}
