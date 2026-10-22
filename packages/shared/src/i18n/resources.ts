// Все каталоги всех языков — для API, тестов и проверки. Веб сюда не обращается,
// чтобы не тянуть все языки в основной бандл.
import type { Locale } from '.';
import deAdmin from './de/admin.json';
import deCommon from './de/common.json';
import deEditor from './de/editor.json';
import deHelp from './de/help.json';
import deErrors from './de/errors.json';
import deHistory from './de/history.json';
import deReport from './de/report.json';
import deReports from './de/reports.json';
import deSignature from './de/signature.json';
import deTemplates from './de/templates.json';
import deValidation from './de/validation.json';
import enAdmin from './en/admin.json';
import enCommon from './en/common.json';
import enEditor from './en/editor.json';
import enHelp from './en/help.json';
import enErrors from './en/errors.json';
import enHistory from './en/history.json';
import enReport from './en/report.json';
import enReports from './en/reports.json';
import enSignature from './en/signature.json';
import enTemplates from './en/templates.json';
import enValidation from './en/validation.json';
import esAdmin from './es/admin.json';
import esCommon from './es/common.json';
import esEditor from './es/editor.json';
import esHelp from './es/help.json';
import esErrors from './es/errors.json';
import esHistory from './es/history.json';
import esReport from './es/report.json';
import esReports from './es/reports.json';
import esSignature from './es/signature.json';
import esTemplates from './es/templates.json';
import esValidation from './es/validation.json';
import frAdmin from './fr/admin.json';
import frCommon from './fr/common.json';
import frEditor from './fr/editor.json';
import frHelp from './fr/help.json';
import frErrors from './fr/errors.json';
import frHistory from './fr/history.json';
import frReport from './fr/report.json';
import frReports from './fr/reports.json';
import frSignature from './fr/signature.json';
import frTemplates from './fr/templates.json';
import frValidation from './fr/validation.json';
import ptBRAdmin from './pt-BR/admin.json';
import ptBRCommon from './pt-BR/common.json';
import ptBREditor from './pt-BR/editor.json';
import ptBRHelp from './pt-BR/help.json';
import ptBRErrors from './pt-BR/errors.json';
import ptBRHistory from './pt-BR/history.json';
import ptBRReport from './pt-BR/report.json';
import ptBRReports from './pt-BR/reports.json';
import ptBRSignature from './pt-BR/signature.json';
import ptBRTemplates from './pt-BR/templates.json';
import ptBRValidation from './pt-BR/validation.json';
import ruAdmin from './ru/admin.json';
import ruCommon from './ru/common.json';
import ruEditor from './ru/editor.json';
import ruHelp from './ru/help.json';
import ruErrors from './ru/errors.json';
import ruHistory from './ru/history.json';
import ruReport from './ru/report.json';
import ruReports from './ru/reports.json';
import ruSignature from './ru/signature.json';
import ruTemplates from './ru/templates.json';
import ruValidation from './ru/validation.json';
import zhCNAdmin from './zh-CN/admin.json';
import zhCNCommon from './zh-CN/common.json';
import zhCNEditor from './zh-CN/editor.json';
import zhCNHelp from './zh-CN/help.json';
import zhCNErrors from './zh-CN/errors.json';
import zhCNHistory from './zh-CN/history.json';
import zhCNReport from './zh-CN/report.json';
import zhCNReports from './zh-CN/reports.json';
import zhCNSignature from './zh-CN/signature.json';
import zhCNTemplates from './zh-CN/templates.json';
import zhCNValidation from './zh-CN/validation.json';

export const resources: Record<Locale, Record<string, object>> = {
  ru: {
    common: ruCommon,
    reports: ruReports,
    history: ruHistory,
    signature: ruSignature,
    admin: ruAdmin,
    templates: ruTemplates,
    editor: ruEditor,
    help: ruHelp,
    errors: ruErrors,
    validation: ruValidation,
    report: ruReport,
  },
  en: {
    common: enCommon,
    reports: enReports,
    history: enHistory,
    signature: enSignature,
    admin: enAdmin,
    templates: enTemplates,
    editor: enEditor,
    help: enHelp,
    errors: enErrors,
    validation: enValidation,
    report: enReport,
  },
  es: {
    common: esCommon,
    reports: esReports,
    history: esHistory,
    signature: esSignature,
    admin: esAdmin,
    templates: esTemplates,
    editor: esEditor,
    help: esHelp,
    errors: esErrors,
    validation: esValidation,
    report: esReport,
  },
  'pt-BR': {
    common: ptBRCommon,
    reports: ptBRReports,
    history: ptBRHistory,
    signature: ptBRSignature,
    admin: ptBRAdmin,
    templates: ptBRTemplates,
    editor: ptBREditor,
    help: ptBRHelp,
    errors: ptBRErrors,
    validation: ptBRValidation,
    report: ptBRReport,
  },
  fr: {
    common: frCommon,
    reports: frReports,
    history: frHistory,
    signature: frSignature,
    admin: frAdmin,
    templates: frTemplates,
    editor: frEditor,
    help: frHelp,
    errors: frErrors,
    validation: frValidation,
    report: frReport,
  },
  de: {
    common: deCommon,
    reports: deReports,
    history: deHistory,
    signature: deSignature,
    admin: deAdmin,
    templates: deTemplates,
    editor: deEditor,
    help: deHelp,
    errors: deErrors,
    validation: deValidation,
    report: deReport,
  },
  'zh-CN': {
    common: zhCNCommon,
    reports: zhCNReports,
    history: zhCNHistory,
    signature: zhCNSignature,
    admin: zhCNAdmin,
    templates: zhCNTemplates,
    editor: zhCNEditor,
    help: zhCNHelp,
    errors: zhCNErrors,
    validation: zhCNValidation,
    report: zhCNReport,
  },
};
