// Builds draft golden files (text only) from recorded EE 5.15.3 evidence. Scratch tool for Plan 17 research.
const fs = require('fs'); const path = require('path');
const { docxText, readEntry, coreErr } = require('./harness');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60);
const pyToHelp = (t) => t.split('\n').map((l) => (/^\[.*\]$/.test(l) && l.includes(' | ') ? ('| ' + l.slice(1, -1) + ' |').replace(/\| {2}(?=\|)/g, '| ') : l)).join('\n');
(async () => {
  const header = (src) => ({ version: 1, engine: 'carbone/carbone-ee:full-5.15.3-fonts, no licence (Community mode)', source: src,
    compare: 'text = docxText(word/document.xml) as in scripts/help-check.ts; error = message without "Unable to generate the document. Error: " prefix and " Source: ..." suffix' });
  // help
  const help = require('../help-examples.json').map((e) => {
    const c = { id: 'help/' + e.id, template: e.template, data: JSON.parse(e.data), options: { lang: 'ru', timezone: 'Europe/Moscow' } };
    if (e.unavailable) { const n = /используется (\S+)/.exec(e.result)[1]; c.expect = { error: `Formatter "${n}" is disabled in the Community Edition.` }; c.apiMessage = e.result; }
    else c.expect = { text: e.result };
    if (e.antiPattern) c.antiPattern = true;
    return c;
  });
  fs.writeFileSync(path.join(__dirname, 'golden-draft/help.json'), JSON.stringify({ ...header('apps/web/src/pages/admin/help/content.ts (HELP_SECTIONS, verified by pnpm help:check against EE)'), cases: help }, null, 1));
  // matrix
  const seen = new Set(); const cases = [];
  for (const p of require('../probes-export.json')) {
    let id = 'matrix/' + (p.sec ? 's' + p.sec + '/' : p.source.replace('.py', '') + '/') + slug(p.name); while (seen.has(id)) id += '-2'; seen.add(id);
    const c = { id, probe: p.source + ' :: ' + p.name, template: p.template, data: p.data, options: Object.assign({ lang: 'ru-ru', timezone: 'Europe/Moscow' }, p.opts || {}) };
    if (p.rawXml) c.raw = p.rawXml; if (p.rels) c.rels = p.rels;
    if (p.convertTo && p.convertTo !== 'docx') { c.convertTo = p.convertTo; c.skip = 'conversion (LibreOffice in EE) — out of renderBuffer scope; covered by OnlyOffice integration test'; c.expect = { note: p.textPy }; cases.push(c); continue; }
    if (p.error) c.expect = { error: coreErr(p.error).replace(/","code".*$/, ''), errorSource: (/ Source: \\?"(.*?)\\?"","code"/.exec(p.error) || [])[1] };
    else if (p.docx) c.expect = { text: docxText(await readEntry(Buffer.from(p.docx, 'base64'), 'word/document.xml')) };
    else c.expect = { text: pyToHelp(p.textPy ?? '') , textFrom: 'results3.txt (python text_of, converted)' };
    if (p.name === 'dynamic image (alt text)') c.skip = 'needs word/media/p.png (media) — add media support to the golden format or drop';
    if (/c\.now/.test(p.name)) c.volatile = 'depends on current date';
    cases.push(c);
  }
  fs.writeFileSync(path.join(__dirname, 'golden-draft/matrix.json'), JSON.stringify({ ...header('carbone-probe/tests.py, tests2.py, tests3.py (2026-10-07 run, results*.pkl / results3.txt)'), defaults: { ext: 'docx' }, cases }, null, 1));
  console.log('help', help.length, 'matrix', cases.length, 'skip', cases.filter((c) => c.skip).length);
})();
