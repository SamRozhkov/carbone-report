// Все каталоги всех языков — для API, тестов и проверки. Веб сюда не обращается,
// чтобы не тянуть все языки в основной бандл.
import type { Locale } from '.';
import deCommon from './de/common.json';
import deErrors from './de/errors.json';
import deValidation from './de/validation.json';
import enCommon from './en/common.json';
import enErrors from './en/errors.json';
import enValidation from './en/validation.json';
import esCommon from './es/common.json';
import esErrors from './es/errors.json';
import esValidation from './es/validation.json';
import frCommon from './fr/common.json';
import frErrors from './fr/errors.json';
import frValidation from './fr/validation.json';
import ptBRCommon from './pt-BR/common.json';
import ptBRErrors from './pt-BR/errors.json';
import ptBRValidation from './pt-BR/validation.json';
import ruCommon from './ru/common.json';
import ruErrors from './ru/errors.json';
import ruValidation from './ru/validation.json';
import zhCNCommon from './zh-CN/common.json';
import zhCNErrors from './zh-CN/errors.json';
import zhCNValidation from './zh-CN/validation.json';

export const resources: Record<Locale, Record<string, object>> = {
  ru: { common: ruCommon, errors: ruErrors, validation: ruValidation },
  en: { common: enCommon, errors: enErrors, validation: enValidation },
  es: { common: esCommon, errors: esErrors, validation: esValidation },
  'pt-BR': { common: ptBRCommon, errors: ptBRErrors, validation: ptBRValidation },
  fr: { common: frCommon, errors: frErrors, validation: frValidation },
  de: { common: deCommon, errors: deErrors, validation: deValidation },
  'zh-CN': { common: zhCNCommon, errors: zhCNErrors, validation: zhCNValidation },
};
