// Все каталоги всех языков — для API, тестов и проверки. Веб сюда не обращается,
// чтобы не тянуть все языки в основной бандл.
import type { Locale } from '.';
import deCommon from './de/common.json';
import deErrors from './de/errors.json';
import deHistory from './de/history.json';
import deReports from './de/reports.json';
import deSignature from './de/signature.json';
import deValidation from './de/validation.json';
import enCommon from './en/common.json';
import enErrors from './en/errors.json';
import enHistory from './en/history.json';
import enReports from './en/reports.json';
import enSignature from './en/signature.json';
import enValidation from './en/validation.json';
import esCommon from './es/common.json';
import esErrors from './es/errors.json';
import esHistory from './es/history.json';
import esReports from './es/reports.json';
import esSignature from './es/signature.json';
import esValidation from './es/validation.json';
import frCommon from './fr/common.json';
import frErrors from './fr/errors.json';
import frHistory from './fr/history.json';
import frReports from './fr/reports.json';
import frSignature from './fr/signature.json';
import frValidation from './fr/validation.json';
import ptBRCommon from './pt-BR/common.json';
import ptBRErrors from './pt-BR/errors.json';
import ptBRHistory from './pt-BR/history.json';
import ptBRReports from './pt-BR/reports.json';
import ptBRSignature from './pt-BR/signature.json';
import ptBRValidation from './pt-BR/validation.json';
import ruCommon from './ru/common.json';
import ruErrors from './ru/errors.json';
import ruHistory from './ru/history.json';
import ruReports from './ru/reports.json';
import ruSignature from './ru/signature.json';
import ruValidation from './ru/validation.json';
import zhCNCommon from './zh-CN/common.json';
import zhCNErrors from './zh-CN/errors.json';
import zhCNHistory from './zh-CN/history.json';
import zhCNReports from './zh-CN/reports.json';
import zhCNSignature from './zh-CN/signature.json';
import zhCNValidation from './zh-CN/validation.json';

export const resources: Record<Locale, Record<string, object>> = {
  ru: {
    common: ruCommon,
    reports: ruReports,
    history: ruHistory,
    signature: ruSignature,
    errors: ruErrors,
    validation: ruValidation,
  },
  en: {
    common: enCommon,
    reports: enReports,
    history: enHistory,
    signature: enSignature,
    errors: enErrors,
    validation: enValidation,
  },
  es: {
    common: esCommon,
    reports: esReports,
    history: esHistory,
    signature: esSignature,
    errors: esErrors,
    validation: esValidation,
  },
  'pt-BR': {
    common: ptBRCommon,
    reports: ptBRReports,
    history: ptBRHistory,
    signature: ptBRSignature,
    errors: ptBRErrors,
    validation: ptBRValidation,
  },
  fr: {
    common: frCommon,
    reports: frReports,
    history: frHistory,
    signature: frSignature,
    errors: frErrors,
    validation: frValidation,
  },
  de: {
    common: deCommon,
    reports: deReports,
    history: deHistory,
    signature: deSignature,
    errors: deErrors,
    validation: deValidation,
  },
  'zh-CN': {
    common: zhCNCommon,
    reports: zhCNReports,
    history: zhCNHistory,
    signature: zhCNSignature,
    errors: zhCNErrors,
    validation: zhCNValidation,
  },
};
