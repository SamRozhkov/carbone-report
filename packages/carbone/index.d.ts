declare namespace carbone {
  interface RenderBufferOptions {
    lang?: string;
    timezone?: string;
    complement?: Record<string, unknown>;
    translations?: Record<string, Record<string, string>>;
    currencySource?: string;
    currencyTarget?: string;
    currencyRates?: Record<string, number>;
    /** Хосты для загрузки изображений по адресу (точное совпадение, порт — часть хоста); пусто — загрузка выключена. */
    imageUrlAllowlist?: string[];
    /** Тайм-аут загрузки одного изображения, мс (по умолчанию 5000). */
    imageUrlTimeoutMs?: number;
    /** Массив, куда рендер дописывает предупреждения (например, сбой загрузки изображения). */
    warnings?: string[];
  }

  interface RenderBufferResult {
    buffer: Buffer;
    warnings: string[];
  }

  /** Отчёт в формате шаблона; ошибка шаблона — отклонённый Promise с текстом Carbone. */
  function renderBuffer(
    template: Buffer,
    extension: string,
    data: unknown,
    options?: RenderBufferOptions,
  ): Promise<Buffer>;

  /** Как renderBuffer, но вместе с предупреждениями рендера (опция warnings задаётся внутри). */
  function renderBufferWithWarnings(
    template: Buffer,
    extension: string,
    data: unknown,
    options?: Omit<RenderBufferOptions, 'warnings'>,
  ): Promise<RenderBufferResult>;
}

export = carbone;
