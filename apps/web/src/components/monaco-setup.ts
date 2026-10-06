import { loader } from '@monaco-editor/react';
// Только ядро редактора, SQL и JSON (§22.8): полный 'monaco-editor' тянет все языки и воркеры css/html/ts.
import * as monaco from 'monaco-editor/editor/editor.api';
// Возможности редактора из полного пакета, нужные для правки SQL: поиск, скобки, буфер обмена,
// контекстное меню, комментарии, сворачивание, подсказки при наведении, операции со строками и словами.
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/language/json/monaco.contribution';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';

// Monaco из бандла, а не с CDN: инструмент внутренний, CSP — только 'self'.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    return new editorWorker();
  },
};
loader.config({ monaco });
