declare namespace carbone {
  interface RenderBufferOptions {
    lang?: string;
    timezone?: string;
    complement?: Record<string, unknown>;
    translations?: Record<string, Record<string, string>>;
    currencySource?: string;
    currencyTarget?: string;
    currencyRates?: Record<string, number>;
  }

  /** Отчёт в формате шаблона; ошибка шаблона — отклонённый Promise с текстом Carbone. */
  function renderBuffer(
    template: Buffer,
    extension: string,
    data: unknown,
    options?: RenderBufferOptions,
  ): Promise<Buffer>;
}

export = carbone;
