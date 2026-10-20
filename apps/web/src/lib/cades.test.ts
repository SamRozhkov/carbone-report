import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('./cades');

const GOST256 = '1.2.643.7.1.1.1.1';
const GOST512 = '1.2.643.7.1.1.1.2';
const RSA = '1.2.840.113549.1.1.1';
const DAY = 86_400_000;

interface CertSpec {
  thumb: string;
  subject?: string;
  oid?: string;
  key?: boolean;
  from?: Date;
  to?: Date;
}

/** Заглушка сертификата асинхронного API: свойства — промисы, методы — async. */
function fakeCert(s: CertSpec) {
  return {
    Thumbprint: Promise.resolve(s.thumb),
    SubjectName: Promise.resolve(s.subject ?? `CN=Владелец ${s.thumb}, O=ООО Ромашка`),
    IssuerName: Promise.resolve('CN=Тестовый УЦ, O=УЦ'),
    ValidFromDate: Promise.resolve(s.from ?? new Date(Date.now() - DAY)),
    ValidToDate: Promise.resolve(s.to ?? new Date(Date.now() + 365 * DAY)),
    HasPrivateKey: vi.fn(async () => s.key ?? true),
    PublicKey: vi.fn(async () => ({
      Algorithm: Promise.resolve({ Value: Promise.resolve(s.oid ?? GOST256) }),
    })),
    Export: vi.fn(async () => `MIIB${s.thumb}\r\nAAAA\r\n`),
  };
}

function fakePlugin(certs: ReturnType<typeof fakeCert>[], opts: { csp?: boolean } = {}) {
  const store = {
    Open: vi.fn(async () => undefined),
    Close: vi.fn(async () => undefined),
    Certificates: Promise.resolve({
      Count: Promise.resolve(certs.length),
      // Коллекции КриптоПро нумеруются с 1.
      Item: vi.fn(async (i: number) => certs[i - 1]),
    }),
  };
  const signer = {
    propset_Certificate: vi.fn(async () => undefined),
    propset_TSAAddress: vi.fn(async () => undefined),
    propset_Options: vi.fn(async () => undefined),
  };
  const hashed = {
    propset_Algorithm: vi.fn(async () => undefined),
    SetHashValue: vi.fn(async () => undefined),
  };
  const signed = { SignHash: vi.fn(async () => 'MIAG\r\nCSqG\r\n') };
  const ver = (a: number, b: number, c: number) => ({
    MajorVersion: Promise.resolve(a),
    MinorVersion: Promise.resolve(b),
    BuildVersion: Promise.resolve(c),
  });
  const about = {
    PluginVersion: Promise.resolve(ver(2, 0, 15400)),
    CSPVersion: vi.fn(async () => {
      if (opts.csp === false) throw new Error('Не удалось получить версию CSP (0x80090019)');
      return ver(5, 0, 12000);
    }),
  };
  const objects: Record<string, unknown> = {
    'CAdESCOM.Store': store,
    'CAdESCOM.CPSigner': signer,
    'CAdESCOM.HashedData': hashed,
    'CAdESCOM.CadesSignedData': signed,
    'CAdESCOM.About': about,
  };
  const plugin = Object.assign(Promise.resolve(), {
    CreateObjectAsync: vi.fn(async (name: string) => objects[name]),
  });
  return { plugin, store, signer, hashed, signed, about };
}

const scripts = () => document.querySelectorAll('script[src="/cadesplugin_api.js"]');

let mod: Mod;
beforeEach(async () => {
  vi.resetModules();
  mod = await import('./cades');
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as { cadesplugin?: unknown }).cadesplugin;
  scripts().forEach((s) => s.remove());
});

/** Скрипт «загрузился»: появился window.cadesplugin, у тега — событие load. */
function scriptLoaded(plugin: unknown) {
  (window as { cadesplugin?: unknown }).cadesplugin = plugin;
  scripts()[0]!.dispatchEvent(new Event('load'));
}

describe('loadCades', () => {
  it('вставляет /cadesplugin_api.js один раз; повторный вызов — тот же промис', async () => {
    const { plugin } = fakePlugin([]);
    const a = mod.loadCades();
    const b = mod.loadCades();
    expect(a).toBe(b);
    expect(scripts()).toHaveLength(1);
    scriptLoaded(plugin);
    const cades = await a;
    expect(await b).toBe(cades);
    expect(await cades.versions()).toEqual({ plugin: '2.0.15400', csp: '5.0.12000' });
    expect(scripts()).toHaveLength(1);
  });

  it('скрипт не загрузился за 10 секунд — CadesUnavailableError', async () => {
    vi.useFakeTimers();
    const p = mod.loadCades();
    const check = expect(p).rejects.toBeInstanceOf(mod.CadesUnavailableError);
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
    await expect(p).rejects.toThrow('Не найден КриптоПро ЭЦП Browser plug-in или КриптоПро CSP');
  });

  it('промис плагина не разрешился за 10 секунд — CadesUnavailableError', async () => {
    vi.useFakeTimers();
    const p = mod.loadCades();
    const hanging = Object.assign(new Promise(() => undefined), { CreateObjectAsync: vi.fn() });
    scriptLoaded(hanging);
    const check = expect(p).rejects.toBeInstanceOf(mod.CadesUnavailableError);
    await vi.advanceTimersByTimeAsync(10_000);
    await check;
  });

  it('ошибка загрузки скрипта (404) — CadesUnavailableError; повторный вызов пробует снова', async () => {
    const p = mod.loadCades();
    scripts()[0]!.dispatchEvent(new Event('error'));
    await expect(p).rejects.toBeInstanceOf(mod.CadesUnavailableError);
    expect(scripts()).toHaveLength(0);
    const again = mod.loadCades();
    expect(again).not.toBe(p);
    expect(scripts()).toHaveLength(1);
    scriptLoaded(fakePlugin([]).plugin);
    await expect(again).resolves.toBeDefined();
  });

  it('промис плагина отклонён — CadesUnavailableError', async () => {
    const p = mod.loadCades();
    const rejected = Object.assign(Promise.reject(new Error('plugin')), {
      CreateObjectAsync: vi.fn(),
    });
    rejected.catch(() => undefined);
    scriptLoaded(rejected);
    await expect(p).rejects.toBeInstanceOf(mod.CadesUnavailableError);
  });

  it('CSP не найден — CadesUnavailableError', async () => {
    const p = mod.loadCades();
    scriptLoaded(fakePlugin([], { csp: false }).plugin);
    await expect(p).rejects.toBeInstanceOf(mod.CadesUnavailableError);
  });
});

async function loaded(f: ReturnType<typeof fakePlugin>) {
  const p = mod.loadCades();
  scriptLoaded(f.plugin);
  return p;
}

describe('listCertificates', () => {
  it('хранилище «Личное» текущего пользователя; только действующие ГОСТ 2012 с закрытым ключом', async () => {
    const to = new Date('2030-05-20T12:00:00Z');
    const f = fakePlugin([
      fakeCert({ thumb: 'A1', subject: 'CN="ООО ""Ромашка""", O=Ромашка', to }),
      fakeCert({ thumb: 'A2', oid: GOST512 }),
      fakeCert({ thumb: 'B1', to: new Date(Date.now() - DAY) }),
      fakeCert({ thumb: 'B2', from: new Date(Date.now() + DAY) }),
      fakeCert({ thumb: 'B3', oid: RSA }),
      fakeCert({ thumb: 'B4', key: false }),
    ]);
    const cades = await loaded(f);
    const list = await cades.listCertificates();
    expect(f.store.Open).toHaveBeenCalledWith(2, 'My', 2);
    expect(f.store.Close).toHaveBeenCalled();
    expect(list.map((c) => c.thumbprint)).toEqual(['A1', 'A2']);
    expect(list[0]).toEqual({
      thumbprint: 'A1',
      subjectCn: 'ООО "Ромашка"',
      issuerCn: 'Тестовый УЦ',
      validTo: to,
      // base64 плагина — с переводами строк; сервер принимает только чистый base64.
      certificateBase64: 'MIIBA1AAAA',
      keyBits: 256,
    });
    expect(list[1]!.keyBits).toBe(512);
  });
});

describe('signHash', () => {
  const certs = () => [fakeCert({ thumb: 'A1' }), fakeCert({ thumb: 'A2', oid: GOST512 })];

  it('хеш 256 без службы меток — CAdES-BES, TSAAddress не задаётся', async () => {
    const list = certs();
    const f = fakePlugin(list);
    const cades = await loaded(f);
    const sig = await cades.signHash('a2', 'ab'.repeat(32), 'streebog256', null);
    expect(sig).toBe('MIAGCSqG');
    expect(f.signer.propset_Certificate).toHaveBeenCalledWith(list[1]);
    expect(f.signer.propset_TSAAddress).not.toHaveBeenCalled();
    // В подпись — только сертификат подписанта: цепочка не строится (CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY).
    expect(f.signer.propset_Options).toHaveBeenCalledWith(2);
    expect(f.hashed.propset_Algorithm).toHaveBeenCalledWith(101);
    // Хеш сервера передаётся без изменений.
    expect(f.hashed.SetHashValue).toHaveBeenCalledWith('ab'.repeat(32));
    expect(f.signed.SignHash).toHaveBeenCalledWith(f.hashed, f.signer, 1);
  });

  it('хеш 512 со службой меток — CAdES-T и TSAAddress', async () => {
    const f = fakePlugin(certs());
    const cades = await loaded(f);
    await cades.signHash('A2', 'cd'.repeat(64), 'streebog512', 'http://tsa.example/tsp');
    expect(f.hashed.propset_Algorithm).toHaveBeenCalledWith(102);
    expect(f.signer.propset_TSAAddress).toHaveBeenCalledWith('http://tsa.example/tsp');
    expect(f.signed.SignHash).toHaveBeenCalledWith(f.hashed, f.signer, 5);
  });

  it('сертификат пропал из хранилища — понятная ошибка', async () => {
    const cades = await loaded(fakePlugin(certs()));
    await expect(cades.signHash('ZZ', 'ab'.repeat(32), 'streebog256', null)).rejects.toThrow(
      'Сертификат не найден в хранилище «Личное»',
    );
  });
});

describe('cadesErrorText', () => {
  it('отмена, неверный ПИН-код, служба меток, прочее — текст плагина', () => {
    expect(
      mod.cadesErrorText(new Error('The operation was canceled by the user. (0x8010006E)')),
    ).toBe('Подписание отменено пользователем');
    expect(mod.cadesErrorText(new Error('Указан неправильный pin. (0x8010006B)'))).toBe(
      'Неверный ПИН-код',
    );
    expect(
      mod.cadesErrorText(new Error('Ошибка при получении штампа времени (TSP) (0xC2110120)')),
    ).toBe('Служба меток времени недоступна — повторите позже');
    expect(mod.cadesErrorText(new Error('Не удается построить цепочку сертификатов'))).toBe(
      'Не удается построить цепочку сертификатов',
    );
    expect(mod.cadesErrorText(new mod.CadesUnavailableError())).toBe(
      'Не найден КриптоПро ЭЦП Browser plug-in или КриптоПро CSP',
    );
    expect(mod.cadesErrorText('строка')).toBe('строка');
    expect(mod.cadesErrorText(undefined)).toBe('неизвестная ошибка плагина');
  });
});
