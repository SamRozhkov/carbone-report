/**
 * КриптоПро ЭЦП Browser plug-in (§42.7): загрузка официального `cadesplugin_api.js` и тонкая обёртка над
 * асинхронным вариантом его API.
 *
 * Форма асинхронного API, на которую опирается обёртка (документация КриптоПро ЭЦП Browser plug-in):
 * - скрипт создаёт `window.cadesplugin` — промис, который разрешается, когда плагин готов (и отклоняется,
 *   если плагина нет); к нему же прикреплён `cadesplugin.CreateObjectAsync(progId)`;
 * - объекты плагина — прокси: чтение свойства (`await store.Certificates`) и вызов метода
 *   (`await cert.HasPrivateKey()`) возвращают промисы; свойство задаётся методом `propset_<Имя>(value)`;
 * - коллекции (`Certificates`) нумеруются с 1: `Count`, `Item(i)`;
 * - ошибки — исключения с текстом плагина, в конце которого код вида `(0x8010006E)`.
 * Настоящего плагина в тестах нет — обёртка нарочно тонкая, типы описывают только используемое.
 */

import { i18n } from '../i18n';

/** Значение асинхронного API: свойство плагина может быть промисом или уже значением. */
type Async<T> = T | Promise<T>;

interface CadesVersion {
  MajorVersion: Async<number>;
  MinorVersion: Async<number>;
  BuildVersion: Async<number>;
}
interface CadesAbout {
  PluginVersion: Async<CadesVersion>;
  CSPVersion(providerName: string, providerType: number): Promise<CadesVersion>;
}
interface CadesCertificate {
  Thumbprint: Async<string>;
  SubjectName: Async<string>;
  IssuerName: Async<string>;
  ValidFromDate: Async<Date | string>;
  ValidToDate: Async<Date | string>;
  HasPrivateKey(): Promise<boolean>;
  PublicKey(): Promise<{ Algorithm: Async<{ Value: Async<string> }> }>;
  Export(encoding: number): Promise<string>;
}
interface CadesCertificates {
  Count: Async<number>;
  Item(index: number): Promise<CadesCertificate>;
}
interface CadesStore {
  Open(location: number, name: string, mode: number): Promise<unknown>;
  Close(): Promise<unknown>;
  Certificates: Async<CadesCertificates>;
}
interface CadesSigner {
  propset_Certificate(cert: CadesCertificate): Promise<unknown>;
  propset_TSAAddress(url: string): Promise<unknown>;
  propset_Options(options: number): Promise<unknown>;
}
interface CadesHashedData {
  propset_Algorithm(alg: number): Promise<unknown>;
  SetHashValue(hex: string): Promise<unknown>;
}
interface CadesSignedData {
  SignHash(hashed: CadesHashedData, signer: CadesSigner, cadesType: number): Promise<string>;
}
interface CadesObjects {
  'CAdESCOM.About': CadesAbout;
  'CAdESCOM.Store': CadesStore;
  'CAdESCOM.CPSigner': CadesSigner;
  'CAdESCOM.HashedData': CadesHashedData;
  'CAdESCOM.CadesSignedData': CadesSignedData;
}
type CadesPlugin = PromiseLike<unknown> & {
  CreateObjectAsync<K extends keyof CadesObjects>(progId: K): Promise<CadesObjects[K]>;
};

declare global {
  interface Window {
    cadesplugin?: CadesPlugin;
  }
}

// Константы плагина — по документации КриптоПро ЭЦП Browser plug-in.
const CAPICOM_CURRENT_USER_STORE = 2;
const CAPICOM_MY_STORE = 'My';
const CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED = 2;
const CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256 = 101;
const CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_512 = 102;
const CADESCOM_CADES_BES = 1;
const CADESCOM_CADES_T = 5;
const CADESCOM_ENCODE_BASE64 = 0;
const CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY = 2;
/** PROV_GOST_2012_256: тип провайдера КриптоПро CSP для ключей ГОСТ Р 34.10-2012. */
const PROV_GOST_2012_256 = 80;
/** OID ключа ГОСТ Р 34.10-2012 → длина ключа. */
const GOST_KEY_OIDS: Record<string, 256 | 512> = {
  '1.2.643.7.1.1.1.1': 256,
  '1.2.643.7.1.1.1.2': 512,
};

const SCRIPT_URL = '/cadesplugin_api.js';

export interface CadesCert {
  thumbprint: string;
  subjectCn: string;
  issuerCn: string;
  validTo: Date;
  certificateBase64: string;
  keyBits: 256 | 512;
}

export class CadesUnavailableError extends Error {
  constructor() {
    super(i18n.t('signature:cades.unavailable'));
    this.name = 'CadesUnavailableError';
  }
}

export interface Cades {
  versions(): Promise<{ plugin: string; csp: string }>;
  /** Хранилище «Личное» текущего пользователя: действующие сертификаты ГОСТ 2012 с закрытым ключом. */
  listCertificates(): Promise<CadesCert[]>;
  /** Открепленная CAdES-BES (или CAdES-T при tsaUrl) над готовым хешем; base64. */
  signHash(
    thumbprint: string,
    hashHex: string,
    hashAlg: 'streebog256' | 'streebog512',
    tsaUrl: string | null,
  ): Promise<string>;
}

/** base64 плагина разбит на строки; сервер принимает только сплошной base64. */
const compact = (b64: string) => b64.replace(/\s+/g, '');

/** CN из строки имени вида `CN="ООО ""Ромашка""", O=…`; без CN — строка целиком. */
export function cnOf(name: string): string {
  const m = /(?:^|,)\s*CN=("(?:[^"]|"")*"|[^,]*)/.exec(name);
  if (!m) return name.trim();
  const v = m[1]!.trim();
  return v.startsWith('"') ? v.slice(1, -1).replaceAll('""', '"') : v;
}

async function versionText(v: CadesVersion): Promise<string> {
  return `${await v.MajorVersion}.${await v.MinorVersion}.${await v.BuildVersion}`;
}

function createCades(plugin: CadesPlugin, about: CadesAbout): Cades {
  /** Перебор хранилища «Личное»; хранилище закрывается и при ошибке. */
  async function eachCertificate(fn: (c: CadesCertificate) => Promise<boolean | void>) {
    const store = await plugin.CreateObjectAsync('CAdESCOM.Store');
    await store.Open(
      CAPICOM_CURRENT_USER_STORE,
      CAPICOM_MY_STORE,
      CAPICOM_STORE_OPEN_MAXIMUM_ALLOWED,
    );
    try {
      const all = await store.Certificates;
      const n = await all.Count;
      for (let i = 1; i <= n; i++) if ((await fn(await all.Item(i))) === true) return;
    } finally {
      await store.Close();
    }
  }

  async function describe(c: CadesCertificate, now: number): Promise<CadesCert | null> {
    const pk = await c.PublicKey();
    const keyBits = GOST_KEY_OIDS[await (await pk.Algorithm).Value];
    if (!keyBits) return null;
    const validFrom = new Date(await c.ValidFromDate);
    const validTo = new Date(await c.ValidToDate);
    if (!(validFrom.getTime() <= now && now < validTo.getTime())) return null;
    if (!(await c.HasPrivateKey())) return null;
    return {
      thumbprint: await c.Thumbprint,
      subjectCn: cnOf(await c.SubjectName),
      issuerCn: cnOf(await c.IssuerName),
      validTo,
      certificateBase64: compact(await c.Export(CADESCOM_ENCODE_BASE64)),
      keyBits,
    };
  }

  return {
    async versions() {
      return {
        plugin: await versionText(await about.PluginVersion),
        csp: await versionText(await about.CSPVersion('', PROV_GOST_2012_256)),
      };
    },

    async listCertificates() {
      const now = Date.now();
      const out: CadesCert[] = [];
      await eachCertificate(async (c) => {
        // Сертификат, который плагин не может прочитать (повреждён, чужой провайдер), пропускается.
        const info = await describe(c, now).catch(() => null);
        if (info) out.push(info);
      });
      return out;
    },

    async signHash(thumbprint, hashHex, hashAlg, tsaUrl) {
      const found: { cert?: CadesCertificate } = {};
      const wanted = thumbprint.toUpperCase();
      await eachCertificate(async (c) => {
        if ((await c.Thumbprint).toUpperCase() !== wanted) return false;
        found.cert = c;
        return true;
      });
      const cert = found.cert;
      if (!cert) throw new Error(i18n.t('signature:cades.certificateNotFound'));
      const signer = await plugin.CreateObjectAsync('CAdESCOM.CPSigner');
      await signer.propset_Certificate(cert);
      // Только сертификат подписанта: по умолчанию (INCLUDE_CHAIN_EXCEPT_ROOT) SignHash строит цепочку и
      // падает с 0x800B010A без промежуточного/корневого УЦ; серверу (§42.4) нужен лишь сертификат по sid.
      // Если ошибка цепочки всё же появится — следующее свойство для проверки: CPSigner.CheckCertificate.
      await signer.propset_Options(CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY);
      if (tsaUrl) await signer.propset_TSAAddress(tsaUrl);
      const hashed = await plugin.CreateObjectAsync('CAdESCOM.HashedData');
      await hashed.propset_Algorithm(
        hashAlg === 'streebog512'
          ? CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_512
          : CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256,
      );
      // Хеш сервера — уже в порядке байтов SetHashValue (§42.2); hex — в верхнем регистре, как в
      // примерах КриптоПро (регистр подтверждается ручной приёмкой, §42.8).
      await hashed.SetHashValue(hashHex.toUpperCase());
      const signed = await plugin.CreateObjectAsync('CAdESCOM.CadesSignedData');
      const sig = await signed.SignHash(
        hashed,
        signer,
        tsaUrl ? CADESCOM_CADES_T : CADESCOM_CADES_BES,
      );
      return compact(sig);
    },
  };
}

let script: Promise<void> | null = null;
let loading: Promise<Cades> | null = null;

/** Тег скрипта вставляется один раз; при ошибке загрузки (404) удаляется — следующий вызов пробует снова. */
function injectScript(): Promise<void> {
  if (window.cadesplugin) return Promise.resolve();
  script ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      script = null;
      reject(new CadesUnavailableError());
    };
    document.head.appendChild(el);
  });
  return script;
}

async function init(): Promise<Cades> {
  await injectScript();
  const plugin = window.cadesplugin;
  if (!plugin) throw new CadesUnavailableError();
  try {
    await plugin;
    const about = await plugin.CreateObjectAsync('CAdESCOM.About');
    // Плагин без КриптоПро CSP не подпишет — проверяем сразу (§42.7: «…или КриптоПро CSP»).
    await about.CSPVersion('', PROV_GOST_2012_256);
    return createCades(plugin, about);
  } catch {
    throw new CadesUnavailableError();
  }
}

/**
 * Загружает `/cadesplugin_api.js` (один раз) и ждёт готовности плагина. Скрипт не загрузился, плагин или
 * CSP не ответили за `timeoutMs` — `CadesUnavailableError` (диалог не висит). Повторный вызов отдаёт тот же
 * промис; после неудачи — пробует заново.
 */
export function loadCades(timeoutMs = 10_000): Promise<Cades> {
  loading ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CadesUnavailableError()), timeoutMs);
    });
    try {
      return await Promise.race([init(), timeout]);
    } catch (e) {
      loading = null;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  })();
  return loading;
}

const TSA_RE = /TSP|time-?stamp|штамп\S* времени|метк\S* времени/i;

/** Ошибка плагина понятным текстом (§42.7): отмена, неверный ПИН-код, служба меток; прочее — текст плагина. */
export function cadesErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const code = /0x([0-9a-f]{8})/i.exec(msg)?.[1]?.toUpperCase();
  if (code === '8010006E') return i18n.t('signature:cades.cancelled');
  if (code === '8010006B') return i18n.t('signature:cades.wrongPin');
  if (TSA_RE.test(msg)) return i18n.t('signature:cades.tsaUnavailable');
  return msg || i18n.t('signature:cades.unknown');
}
